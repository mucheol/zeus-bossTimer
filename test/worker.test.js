import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlatformProxy } from 'wrangler';
import { readFileSync, readdirSync } from 'node:fs';
import worker, { schedule, deliver } from '../src/worker.js';
import { validateSubscription } from '../src/validation.js';
import catalog from '../public/data/catalog.json' with { type: 'json' };
import { estimate } from '../public/lib/engine.js';

// 실제 암호화가 가능한 브라우저 구독키와 VAPID 키를 만듭니다.
async function environment(context) {
  context.mock.method(Date, 'now', () => Date.parse('2026-10-12T12:01:00+09:00'));
  const platform = await getPlatformProxy({ persist: false, remoteBindings: false });
  context.after(() => platform.dispose());
  const DB = platform.env.DB;
  const statements = readdirSync('migrations').filter(name => name.endsWith('.sql')).sort().flatMap(name => readFileSync(`migrations/${name}`, 'utf8').split(';').filter(sql => sql.trim()));
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
    ADMIN_PASSWORD: 'test-only-admin', ADMIN_LOGIN_LIMIT: { limit: async () => ({ success: true }) },
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

// 전체 알림을 끄면 예약·대기 푸시·테스트를 막고 선택은 보존합니다.
test('전체 알림 저장·중지·테스트 차단·다시 켜기와 기존 시점 이관', async context => {
  const env = await environment(context);
  const preferences = { enabled: true, bosses: ['tripork'], offsets: [60, 180, 300], invasion: [0, 12, 18] };
  assert.equal((await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences }), env)).status, 200);
  assert.equal((await worker.fetch(request('/api/test', 'POST'), env)).status, 200);
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE state='queued'").first();
  preferences.enabled = false;
  await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences }), env);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('queued','pending')").first()).count, 0);
  assert.deepEqual((await (await worker.fetch(request('/api/status', 'POST'), env)).json()).preferences, preferences);
  assert.equal((await worker.fetch(request('/api/test', 'POST'), env)).status, 409);
  await env.DB.prepare("UPDATE jobs SET state='queued' WHERE id=?").bind(job.id).run();
  await deliver(env, job.id, job.due_at, async () => assert.fail('전체 중지 후 푸시 발송'));
  assert.equal((await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(job.id).first()).state, 'cancelled');
  preferences.enabled = true;
  await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences }), env);
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state='pending'").first()).count > 0);
  const legacy = { bosses: ['tripork'], offsets: [600, 0], invasion: [12] };
  await env.DB.prepare("UPDATE devices SET preferences=?,revision='old'").bind(JSON.stringify(legacy)).run();
  await schedule(env, Date.now());
  const migrated = JSON.parse((await env.DB.prepare('SELECT preferences FROM devices').first()).preferences);
  assert.deepEqual(migrated, { enabled: true, bosses: ['tripork'], offsets: [300], invasion: [12] });
  assert.equal((await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences: { ...preferences, enabled: 'false' } }), env)).status, 400);
});

// 최대 선택 기기 5대의 반복 예약도 무료 실행당 쿼리 한도 안에서 갱신합니다.
test('전체 보스·모든 시점의 5기기 반복 예약은 50쿼리 이내', async context => {
  const env = await environment(context);
  const preferences = { bosses: catalog.bosses.map(boss => boss.id), offsets: [60, 180, 300], invasion: [0, 12, 18] };
  for (let index = 1; index <= 5; index++) {
    const subscription = { ...env.subscription, endpoint: `${env.subscription.endpoint}-${index}` };
    assert.equal((await worker.fetch(request('/api/subscription', 'PUT', { subscription, preferences }, String(index).repeat(64)), env)).status, 200);
  }
  await env.DB.prepare("UPDATE devices SET revision='old'").run();
  const database = env.DB;
  let queries = 0;
  env.DB = {
    // 실제로 실행할 준비된 문장을 집계합니다.
    prepare(sql) { queries++; return database.prepare(sql); },
    // 실제 D1 트랜잭션을 그대로 실행합니다.
    batch(statements) { return database.batch(statements); }
  };
  await schedule(env, Date.now());
  assert.ok(queries <= 50, `쿼리 수 ${queries}`);
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM devices WHERE revision='old'").first()).count, 0);
  assert.ok((await database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state='pending'").first()).count > 1000);
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
  const pending = jobs[0];
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

// 최신 수정만 적용하던 기존 이력도 모두 읽어 학습하고 원본을 보존합니다.
test('과거 관리자 이력 전체 보존·조회와 이미지 이후 보정 학습', async context => {
  const env = await environment(context);
  const boss = catalog.bosses.find(item => item.id === 'bedix');
  const start = Date.parse(boss.observations.at(-1).spawnAt);
  for (let cycle = 1; cycle <= 3; cycle++) {
    const at = start + cycle * (8 * 3600000 + 45000);
    await env.DB.prepare('INSERT INTO boss_updates(boss_id,recorded_at,spawn_at) VALUES (?,?,?)').bind(boss.id, at - 600000, at).run();
  }
  const shared = await (await worker.fetch(request('/data/catalog.json', 'GET'), env)).json();
  const merged = shared.bosses.find(item => item.id === boss.id);
  assert.equal(merged.observations.length, boss.observations.length + 3);
  assert.deepEqual(merged.observations.slice(0, boss.observations.length), boss.observations);
  assert.equal(estimate(merged).manualSampleCount, 3);
  assert.ok(estimate(merged).killSeconds > 30 && estimate(merged).killSeconds < 45);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS count FROM boss_updates').first()).count, 3);
});

// 인증·공통 저장·다른 기기 조회와 수정 후 예약 교체를 실제 D1에서 검사합니다.
test('관리자 인증 후 공통 시간 저장, 전체 기기 공유, 초 제거와 예약 교체', async context => {
  const env = await environment(context);
  const now = Date.parse('2026-10-12T16:10:37.500+09:00');
  context.mock.method(Date, 'now', () => now);
  const preferences = { bosses: ['bedix'], offsets: [60], invasion: [] };
  await worker.fetch(request('/api/subscription', 'PUT', { subscription: env.subscription, preferences }), env);
  const oldJob = await env.DB.prepare('SELECT * FROM jobs ORDER BY due_at LIMIT 1').first();
  const login = await worker.fetch(request('/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }), env);
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('Set-Cookie');
  assert.match(cookieHeader, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = cookieHeader.split(';')[0];
  const edit = request('/api/admin/time', 'PUT', { bossId: 'bedix', hours: 1, minutes: 12, seconds: 59 });
  edit.headers.set('Cookie', cookie);
  const saved = await worker.fetch(edit, env);
  assert.equal(saved.status, 200);
  const shared = (await saved.json()).catalog;
  assert.equal(shared.source, 'admin');
  assert.equal(shared.bosses.find(boss => boss.id === 'bedix').observations.at(-1).spawnAt, new Date(now + 72 * 60000).toISOString());
  const update = await env.DB.prepare('SELECT * FROM boss_updates').first();
  assert.equal(update.spawn_at - update.recorded_at, 72 * 60000);
  assert.deepEqual(await (await worker.fetch(request('/data/catalog.json', 'GET'), env)).json(), shared);
  assert.equal(catalog.bosses.find(boss => boss.id === 'bedix').observations.at(-1).source, 'screenshot-007');
  await env.DB.prepare("UPDATE jobs SET state='queued' WHERE id=?").bind(oldJob.id).run();
  await deliver(env, oldJob.id, now, async () => assert.fail('관리자 수정 전 예약 발송'));
  assert.equal((await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(oldJob.id).first()).state, 'cancelled');
  await schedule(env, now);
  const next = await env.DB.prepare("SELECT * FROM jobs WHERE state='pending' ORDER BY due_at LIMIT 1").first();
  assert.equal(next.due_at, now + 71 * 60000);
  const logout = request('/api/admin/logout', 'POST');
  logout.headers.set('Cookie', cookie);
  assert.equal((await worker.fetch(logout, env)).status, 200);
  const denied = request('/api/admin/time', 'PUT', { bossId: 'bedix', hours: 0, minutes: 1 });
  denied.headers.set('Cookie', cookie);
  assert.equal((await worker.fetch(denied, env)).status, 401);
});

// 비인증·오인증·교차 출처·변조 입력·만료 세션을 차단합니다.
test('관리자 권한과 입력 경계, 인증 제한·세션 만료·최신 관측 우선', async context => {
  const env = await environment(context);
  let now = Date.parse('2026-10-12T14:10:00+09:00');
  context.mock.method(Date, 'now', () => now);
  assert.equal((await worker.fetch(request('/api/admin/time', 'PUT', { bossId: 'bedix', hours: 0, minutes: 5 }), env)).status, 401);
  assert.equal((await worker.fetch(request('/api/admin/login', 'POST', { password: 'wrong' }), env)).status, 401);
  const crossOrigin = request('/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD });
  crossOrigin.headers.set('Origin', 'https://other.example');
  assert.equal((await worker.fetch(crossOrigin, env)).status, 403);
  const login = await worker.fetch(request('/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }), env);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  for (const body of [{ bossId: 'unknown', hours: 0, minutes: 1 }, { bossId: 'bedix', hours: -1, minutes: 1 }, { bossId: 'bedix', hours: 0.5, minutes: 1 }, { bossId: 'bedix', hours: 0, minutes: 60 }, { bossId: 'bedix', hours: 48, minutes: 1 }]) {
    const edit = request('/api/admin/time', 'PUT', body);
    edit.headers.set('Cookie', cookie);
    assert.equal((await worker.fetch(edit, env)).status, 400);
  }
  const status = request('/api/admin/status', 'GET');
  status.headers.set('Cookie', cookie);
  assert.equal((await (await worker.fetch(status, env)).json()).authenticated, true);
  now += 8 * 3600000;
  assert.equal((await (await worker.fetch(status, env)).json()).authenticated, false);
  env.ADMIN_LOGIN_LIMIT.limit = async () => ({ success: false });
  assert.equal((await worker.fetch(request('/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }), env)).status, 429);
  await env.DB.prepare('INSERT INTO boss_updates(boss_id,recorded_at,spawn_at) VALUES (?,?,?)').bind('bedix', Date.parse('2026-10-12T12:00:00+09:00'), now).run();
  const shared = await (await worker.fetch(request('/data/catalog.json', 'GET'), env)).json();
  assert.equal(shared.bosses.find(boss => boss.id === 'bedix').observations.at(-1).source, 'screenshot-007');
});
