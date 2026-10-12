import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlatformProxy } from 'wrangler';
import { readFileSync } from 'node:fs';
import worker, { schedule, deliver } from '../src/worker.js';
import { validateSubscription } from '../src/validation.js';
import catalog from '../public/data/catalog.json' with { type: 'json' };

// 실제 암호화가 가능한 브라우저 구독키와 VAPID 키를 만듭니다.
async function environment(context) {
  context.mock.method(Date, 'now', () => Date.parse('2026-10-12T12:01:00+09:00'));
  const platform = await getPlatformProxy({ persist: false, remoteBindings: false });
  context.after(() => platform.dispose());
  const DB = platform.env.DB;
  const statements = readFileSync('migrations/0001_push.sql', 'utf8').split(';').filter(sql => sql.trim());
  await DB.batch(statements.map(sql => DB.prepare(sql)));
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const receiverRaw = await crypto.subtle.exportKey('raw', receiver.publicKey);
  const vapidRaw = await crypto.subtle.exportKey('raw', vapid.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', vapid.privateKey);
  const messages = [];
  return {
    DB, VAPID_PUBLIC_KEY: Buffer.from(vapidRaw).toString('base64url'), VAPID_PRIVATE_KEY: jwk.d,
    VAPID_SUBJECT: 'https://example.com', API_RATE_LIMIT: { limit: async () => ({ success: true }) },
    PUSH_QUEUE: { send: async body => messages.push(body), sendBatch: async jobs => messages.push(...jobs.map(job => job.body)) },
    messages, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: Buffer.from(receiverRaw).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } }
  };
}

// 기기 토큰과 동일 출처 요청을 만들어 API를 호출합니다.
function request(path, method = 'POST', body, token = 'a'.repeat(64)) {
  return new Request(`https://timer.example${path}`, { method, headers: { Origin: 'https://timer.example', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

// 선택 취소 시 모든 대기 예약을 막고 구독 해제 시 개인 푸시 정보를 제거합니다.
test('구독 저장·침공 취소·해제, 다른 토큰의 기존 주소 탈취 방지', async context => {
  const env = await environment(context);
  const preferences = { bosses: ['tripork'], offsets: [300, 0], invasion: [0, 12, 18] };
  assert.equal((await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences }), env)).status, 200);
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state='pending'").first()).count > 0);
  assert.equal((await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences }, 'b'.repeat(64)), env)).status, 409);
  preferences.bosses = []; preferences.invasion = [];
  assert.equal((await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences }), env)).status, 200);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state='pending'").first()).count, 0);
  assert.equal((await worker.fetch(request('/api/subscription', 'DELETE'), env)).status, 200);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM jobs').first()).count, 0);
});

// 외부 사이트 요청·잘못된 보스·임의 주소·큰 본문을 거절합니다.
test('API 인증과 입력 경계, SSRF 주소 거절', async context => {
  const env = await environment(context);
  const forged = request('/api/subscription', 'DELETE');
  forged.headers.set('Origin', 'https://evil.example');
  assert.equal((await worker.fetch(forged, env)).status, 403);
  assert.equal((await worker.fetch(request('/api/subscription', 'DELETE', null, 'bad'), env)).status, 401);
  const preferences = { bosses: ['unknown'], offsets: [0], invasion: [12] };
  assert.equal((await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences }), env)).status, 400);
  for (const endpoint of ['https://127.0.0.1/push', 'https://fcm.googleapis.com.evil.example/', 'http://fcm.googleapis.com/', 'https://fcm.googleapis.com:444/', 'https://user@fcm.googleapis.com/']) {
    await assert.rejects(validateSubscription({ ...env.subscription, endpoint }));
  }
  assert.equal((await worker.fetch(request('/api/subscription', 'PUT', { padding: 'x'.repeat(17000) }), env)).status, 413);
});

// 예약 하나를 큐로 보내고 실제 암호화 요청이 중복 없이 발생하는지 확인합니다.
test('정각 예약 큐 발송, aes128gcm 암호화, 중복 실행 방지', async context => {
  const env = await environment(context);
  await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences: { bosses: [], offsets: [], invasion: [18] } }), env);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE state='pending' ORDER BY due_at LIMIT 1").first();
  await schedule(env, job.due_at);
  assert.equal(env.messages.length, 1);
  let sends = 0;
  // 푸시 사업자 대신 암호화된 요청 헤더와 본문을 검사합니다.
  const send = async (url, options) => {
    sends++;
    assert.equal(url, env.subscription.endpoint);
    assert.equal(new Headers(options.headers).get('Content-Encoding'), 'aes128gcm');
    assert.ok(new Headers(options.headers).get('Authorization').startsWith('vapid '));
    assert.ok(options.body);
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 201 });
  };
  await deliver(env, job.id, job.due_at + 1000, send);
  await deliver(env, job.id, job.due_at + 2000, send);
  assert.equal(sends, 1);
  assert.equal((await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(job.id).first()).state, 'sent');
});

// 늦게 도착하거나 새 배포 이전의 예약은 발송하지 않습니다.
test('만료 알림과 구버전 예약 발송 차단', async context => {
  const env = await environment(context);
  await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences: { bosses: [], offsets: [], invasion: [18] } }), env);
  const job = await env.DB.prepare("SELECT * FROM jobs ORDER BY due_at LIMIT 1").first();
  await schedule(env, job.expires_at + 1);
  assert.equal(env.messages.length, 0);
  await deliver(env, job.id, job.expires_at + 2, async () => assert.fail('만료 발송'));
  await env.DB.prepare("UPDATE jobs SET state='queued',expires_at=? WHERE id=?").bind(job.expires_at + 100000, job.id).run();
  await env.DB.prepare("UPDATE devices SET revision='old'").run();
  await deliver(env, job.id, job.expires_at + 3, async () => assert.fail('구버전 발송'));
  assert.equal((await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(job.id).first()).state, 'cancelled');
});

// 해지된 주소는 제거하고 일시 장애는 재시도 상태로 되돌립니다.
test('푸시 사업자 503 재시도, 410 구독 삭제', async context => {
  const env = await environment(context);
  await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences: { bosses: [], offsets: [], invasion: [18] } }), env);
  const job = await env.DB.prepare('SELECT * FROM jobs ORDER BY due_at LIMIT 1').first();
  await schedule(env, job.due_at);
  await assert.rejects(deliver(env, job.id, job.due_at, async () => new Response(null, { status: 503 })));
  assert.equal((await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(job.id).first()).state, 'queued');
  await deliver(env, job.id, job.due_at + 30000, async () => new Response(null, { status: 410 }));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM devices').first()).count, 0);
});

// 새 배포는 같은 회차 예약만 보정하고 이미 발송한 예약을 되살리지 않습니다.
test('자료 보정 후 예약 갱신과 발송 이력 보존', async context => {
  const env = await environment(context);
  await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences: { bosses: ['tripork'], offsets: [300, 0], invasion: [] } }), env);
  const { results: jobs } = await env.DB.prepare('SELECT * FROM jobs ORDER BY due_at').all();
  const sent = jobs.at(-1);
  const pending = jobs.at(-2);
  await env.DB.prepare("UPDATE jobs SET state='sent' WHERE id=?").bind(sent.id).run();
  const observation = catalog.bosses[0].observations.at(-1);
  const originalTime = observation.spawnAt;
  const originalRevision = catalog.revision;
  try {
    catalog.revision += '-correction';
    observation.spawnAt = new Date(Date.parse(originalTime) + 30000).toISOString();
    await schedule(env, Date.now());
    const updated = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(pending.id).first();
    assert.equal(updated.due_at, pending.due_at + 30000);
    assert.equal(updated.state, 'pending');
    assert.equal((await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(sent.id).first()).state, 'sent');
  } finally {
    observation.spawnAt = originalTime;
    catalog.revision = originalRevision;
  }
});
