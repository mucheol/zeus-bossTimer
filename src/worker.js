import catalog from '../public/data/catalog.json' with { type: 'json' };
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { plannedEvents, DAY } from '../public/lib/engine.js';
import { deviceId, validatePreferences, validateSubscription, invalid } from './validation.js';

// API 응답의 캐시와 외부 스크립트 접근을 제한합니다.
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

// 크기가 제한된 JSON 본문만 읽습니다.
async function readBody(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw invalid('JSON 형식이 필요합니다.');
  const reader = request.body?.getReader();
  if (!reader) throw invalid('본문이 필요합니다.');
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) {
      await reader.cancel();
      throw Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalid('JSON을 읽을 수 없습니다.'); }
}

// 취소된 미래 예약을 다시 만들되 이미 발송한 회차는 보존합니다.
function jobStatements(env, id, preferences, now) {
  const events = plannedEvents(catalog, preferences, now);
  const statements = [];
  for (let i = 0; i < events.length; i += 15) {
    const chunk = events.slice(i, i + 15);
    const values = chunk.flatMap(event => [`${id}:${event.key}`, id, event.dueAt, event.expiresAt, JSON.stringify({
      title: event.title, body: event.body, tag: event.key, expiresAt: event.expiresAt, url: '/'
    })]);
    statements.push(env.DB.prepare(`INSERT INTO jobs(id, device_id, due_at, expires_at, payload)
      VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(',')}
      ON CONFLICT(id) DO UPDATE SET due_at=excluded.due_at, expires_at=excluded.expires_at,
        payload=excluded.payload, state='pending', lease_until=0
      WHERE jobs.state IN ('pending', 'queued', 'cancelled')`).bind(...values));
  }
  return statements;
}

// 기기 설정과 미래 예약을 하나의 트랜잭션으로 교체합니다.
async function saveDevice(env, id, subscription, preferences, now) {
  const existing = await env.DB.prepare('SELECT id FROM devices WHERE endpoint=?').bind(subscription.endpoint).first();
  if (existing && existing.id !== id) throw Object.assign(new Error('이 브라우저의 기존 알림 연결을 먼저 해제해 주세요.'), { status: 409 });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices(id, endpoint, subscription, preferences, revision, planned_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      endpoint=excluded.endpoint, subscription=excluded.subscription, preferences=excluded.preferences,
      revision=excluded.revision, planned_until=excluded.planned_until, updated_at=excluded.updated_at`
    ).bind(id, subscription.endpoint, JSON.stringify(subscription), JSON.stringify(preferences), catalog.revision, now + DAY, now),
    env.DB.prepare("UPDATE jobs SET state='cancelled' WHERE device_id=? AND state IN ('pending', 'queued')").bind(id),
    ...jobStatements(env, id, preferences, now)
  ]);
}

// 앱의 구독 등록·해제와 잠금 화면용 테스트 알림을 처리합니다.
async function api(request, env) {
  const url = new URL(request.url);
  const ready = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
  if (url.pathname === '/api/config' && request.method === 'GET') return json({ ready, publicKey: env.VAPID_PUBLIC_KEY || null, revision: catalog.revision });
  if (request.headers.get('Origin') !== url.origin) return json({ error: '같은 사이트에서만 요청할 수 있습니다.' }, 403);
  if (!['PUT', 'POST', 'DELETE', 'GET'].includes(request.method)) return json({ error: '지원하지 않는 요청입니다.' }, 405);
  const id = await deviceId(request);
  const rate = await env.API_RATE_LIMIT.limit({ key: id });
  if (!rate.success) return json({ error: '잠시 후 다시 시도해 주세요.' }, 429);
  if (url.pathname === '/api/subscription' && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM devices WHERE id=?').bind(id).run();
    return json({ ok: true });
  }
  if (url.pathname === '/api/status' && request.method === 'POST') {
    const row = await env.DB.prepare('SELECT preferences FROM devices WHERE id=?').bind(id).first();
    return json({ connected: Boolean(row), preferences: row ? JSON.parse(row.preferences) : null });
  }
  if (!ready) return json({ error: '운영자가 푸시 배포 설정을 완료하지 않았습니다.' }, 503);
  if (url.pathname === '/api/subscription' && request.method === 'PUT') {
    const body = await readBody(request);
    const preferences = validatePreferences(body.preferences, catalog);
    const subscription = await validateSubscription(body.subscription);
    await saveDevice(env, id, subscription, preferences, Date.now());
    return json({ ok: true });
  }
  if (url.pathname === '/api/test' && request.method === 'POST') {
    const now = Date.now();
    const allowed = await env.DB.prepare('UPDATE devices SET test_at=? WHERE id=? AND test_at<? RETURNING id').bind(now, id, now - 60000).first();
    if (!allowed) return json({ error: '알림을 연결한 뒤 테스트해 주세요. 테스트는 1분마다 가능합니다.' }, 429);
    const key = `${id}:test:${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO jobs(id,device_id,due_at,expires_at,payload,state,lease_until) VALUES (?,?,?,?,?,\'queued\',?)')
      .bind(key, id, now + 10000, now + 130000, JSON.stringify({ title: '제우스 타이머 · 테스트', body: '알림 연결 성공! 소리·진동은 기기 설정을 따릅니다.', tag: 'zeus-test', expiresAt: now + 130000, url: '/' }), now + 120000).run();
    await env.PUSH_QUEUE.send({ id: key }, { delaySeconds: 10 });
    return json({ ok: true });
  }
  return json({ error: '요청 경로를 찾을 수 없습니다.' }, 404);
}

// 자료 변경과 침공의 다음 날짜 예약을 기기별로 갱신합니다.
export async function schedule(env, now = Date.now()) {
  const { results: devices } = await env.DB.prepare('SELECT id,preferences,revision FROM devices WHERE revision!=? OR planned_until<? LIMIT 5').bind(catalog.revision, now).all();
  for (const device of devices) {
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET state='cancelled' WHERE device_id=? AND state IN ('pending','queued') AND (due_at>? OR ?!=?)").bind(device.id, now, catalog.revision, device.revision),
      ...jobStatements(env, device.id, JSON.parse(device.preferences), now),
      env.DB.prepare('UPDATE devices SET revision=?,planned_until=? WHERE id=?').bind(catalog.revision, now + DAY, device.id)
    ]);
  }
  await env.DB.prepare("UPDATE jobs SET state='expired' WHERE expires_at<=? AND state IN ('pending','queued','sending')").bind(now).run();
  const { results: jobs } = await env.DB.prepare(`UPDATE jobs SET state='queued',lease_until=?
    WHERE id IN (SELECT id FROM jobs WHERE due_at<=? AND expires_at>? AND attempts<4
    AND (state='pending' OR (state IN ('queued','sending') AND lease_until<?)) ORDER BY due_at LIMIT 100)
    RETURNING id`).bind(now + 120000, now, now, now).all();
  if (jobs.length) await env.PUSH_QUEUE.sendBatch(jobs.map(job => ({ body: { id: job.id } })));
  await env.DB.prepare('DELETE FROM jobs WHERE expires_at<?').bind(now - 7 * DAY).run();
}

// 만료·취소 여부를 다시 확인한 뒤 한 기기의 암호화 푸시를 전송합니다.
export async function deliver(env, id, now = Date.now(), send = fetch) {
  const job = await env.DB.prepare(`UPDATE jobs SET state='sending',attempts=attempts+1,lease_until=?
    WHERE id=? AND state='queued' AND expires_at>? AND attempts<4 RETURNING *`).bind(now + 120000, id, now).first();
  if (!job) return;
  const device = await env.DB.prepare('SELECT subscription,revision FROM devices WHERE id=?').bind(job.device_id).first();
  if (!device) return;
  if (!id.includes(':test:') && device.revision !== catalog.revision) {
    await env.DB.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").bind(id).run();
    return;
  }
  try {
    const subscription = JSON.parse(device.subscription);
    const options = await buildPushPayload({ data: job.payload, options: { ttl: Math.max(1, Math.floor((job.expires_at - now) / 1000)) } }, subscription, {
      subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY
    });
    const response = await send(subscription.endpoint, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.status === 404 || response.status === 410) {
      await env.DB.prepare('DELETE FROM devices WHERE id=?').bind(job.device_id).run();
      return;
    }
    if (response.status === 429 || response.status >= 500) throw new Error('push-retry');
    await env.DB.prepare('UPDATE jobs SET state=? WHERE id=?').bind(response.ok ? 'sent' : 'failed', id).run();
    if (!response.ok) console.error('push-provider-rejected', response.status);
  } catch (error) {
    await env.DB.prepare("UPDATE jobs SET state='queued' WHERE id=? AND state='sending'").bind(id).run();
    throw error;
  }
}

export default {
  // 정적 앱과 동일 출처 API를 제공합니다.
  async fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await api(request, env); } catch (error) {
      if (!error.status) console.error('api-failed');
      return json({ error: error.status ? error.message : '저장에 실패했습니다. 잠시 후 다시 시도해 주세요.' }, error.status || 500);
    }
  },
  // 분 단위 예약을 메시지 큐로 전달합니다.
  async scheduled(event, env) {
    await schedule(env, event.scheduledTime);
  },
  // 실패한 푸시만 짧게 재시도하며 만료된 알림은 버립니다.
  async queue(batch, env) {
    for (const message of batch.messages) {
      try { await deliver(env, message.body.id); message.ack(); } catch {
        console.error('push-attempt-failed');
        message.retry({ delaySeconds: 30 });
      }
    }
  }
};
