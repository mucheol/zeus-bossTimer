import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import * as engine from '../public/lib/engine.js';
import catalog from '../public/data/catalog.json' with { type: 'json' };

// 실제 앱 함수를 최소 DOM과 독립 기기 저장소에서 실행합니다.
function app(initial = {}) {
  const elements = new Map();
  const storage = new Map([['zeus-settings', JSON.stringify(initial)]]);
  const context = createContext({ ...engine, structuredClone, Date, JSON, AbortSignal,
    crypto, Uint8Array, atob, navigator: {}, window: {}, matchMedia: () => ({ matches: false }),
    setTimeout: () => 0, clearTimeout() {}, confirm: () => true,
    document: { querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { open: false, hidden: false, textContent: '',
        showModal() { this.open = true; }, close() { this.open = false; } });
      return elements.get(selector);
    } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch: async () => { throw new Error('offline'); }
  });
  const source = readFileSync('public/app.js', 'utf8').replace(/^import .*\r?\n/, '').split("$('#settings-open').addEventListener")[0];
  runInContext(`${source}\nrenderBosses = () => {}; tick = () => {}; renderSettings = () => {}; renderSettingsDraft = () => {};`, context);
  return { context, storage, elements, run: code => runInContext(code, context) };
}

// 기존 구독이 있어도 앱 알림 권한을 확인하고 거절 시 서버에 연결하지 않습니다.
test('푸시 연결은 기존 구독에도 알림 권한 확인·거절 후 저장 차단', async () => {
  for (const permission of ['granted', 'denied']) {
    const ui = app();
    let asked = 0, writes = 0;
    ui.context.Notification = { permission: 'default', requestPermission: async () => { asked++; return permission; } };
    ui.context.window.Notification = ui.context.Notification;
    ui.context.window.PushManager = {};
    ui.context.navigator.serviceWorker = {};
    ui.context.navigator.userAgent = 'Android';
    ui.context.fetch = async () => { writes++; return Response.json({ ok: true }); };
    ui.run("registration={}; config={ready:true}; subscription={toJSON:()=>({endpoint:'test'})};");
    await ui.run('connect()');
    assert.equal(asked, 1);
    assert.equal(writes, permission === 'granted' ? 1 : 0);
    assert.equal(ui.run('connected'), permission === 'granted');
  }
});

// 화면을 벗어나면 주기 작업을 제거하고 복귀할 때 한 번씩만 재개합니다.
test('백그라운드 타이머 중지·복귀 재계산·중복 실행 방지', () => {
  const ui = app();
  const timers = new Map();
  let sequence = 0, ticks = 0;
  ui.context.setInterval = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; };
  ui.context.clearInterval = id => timers.delete(id);
  ui.context.onTick = () => ticks++;
  ui.run('tick=onTick; startForegroundUpdates()');
  assert.equal(ticks, 1);
  assert.deepEqual([...timers.values()].map(item => item.delay), [1000, 15000]);
  ui.context.document.hidden = true;
  ui.run('stopForegroundUpdates(); startForegroundUpdates()');
  assert.equal(timers.size, 0);
  assert.equal(ticks, 1);
  ui.context.document.hidden = false;
  ui.run('startForegroundUpdates(); startForegroundUpdates()');
  assert.equal(timers.size, 2);
  assert.equal(ticks, 3);
});

// 초기 자료가 늦어도 저장된 선택을 기본값으로 덮어쓰지 않습니다.
test('초기 자료 복원 전 환경설정 차단과 기존 개인 선택 유지', () => {
  const preferences = { enabled: false, bosses: ['bedix'], offsets: [180], invasion: [18] };
  const ui = app({ preferences });
  ui.run('openSettings()');
  assert.equal(ui.elements.get('#settings').open, false);
  ui.context.next = catalog;
  ui.run('applyCatalog(next); openSettings()');
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(settingsDraft)')), preferences);
});

// 저장소 오류에서는 실제 선택을 바꾸지 않고 변경 폐기 확인을 유지합니다.
test('기기 저장 실패 시 설정 미적용·서버 미전송·닫기 확인 유지', async () => {
  const ui = app();
  ui.context.next = catalog;
  ui.run("applyCatalog(next); openSettings(); changeSettings('enabled'); connected=true;");
  let writes = 0;
  let confirms = 0;
  ui.context.fetch = async () => { writes++; return Response.json({ ok: true }); };
  ui.context.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  ui.context.confirm = () => { confirms++; return false; };
  await ui.run('saveSettings()');
  assert.equal(ui.run('preferences.enabled'), true);
  assert.equal(ui.run('settingsChanged()'), true);
  ui.run('closeSettings()');
  assert.equal(confirms, 1);
  assert.equal(ui.elements.get('#settings').open, true);
  assert.equal(writes, 0);
});

// 오래된 폴링 응답은 관리자 저장을 되돌릴 수 없습니다.
test('관리자 저장 전에 시작한 늦은 조회 응답 무시', async () => {
  const ui = app();
  ui.context.next = catalog;
  ui.run('applyCatalog(next)');
  let release;
  const updated = { ...catalog, revision: 'new-admin' };
  ui.context.fetch = async path => path.includes('/api/admin/') ? Response.json({ catalog: updated })
    : new Promise(resolve => { release = () => resolve(Response.json(catalog)); });
  const refresh = ui.run('refresh()');
  const oldRelease = release;
  await ui.run("changeBossTime('time','PUT',{})");
  assert.equal(ui.run('catalog.revision'), 'new-admin');
  oldRelease();
  await refresh;
  assert.equal(ui.run('catalog.revision'), 'new-admin');
});

// 연결 확인 실패 뒤에도 대기 중인 전체 끄기를 자동 복구 경로에서 전송합니다.
test('푸시 초기 장애 재확인과 기기별 저장 대기 설정 재전송', async () => {
  const preferences = { enabled: false, bosses: ['bedix'], offsets: [60], invasion: [] };
  const ui = app({ token: 'a'.repeat(64), preferences, pending: true });
  ui.context.next = catalog;
  ui.run('applyCatalog(next)');
  const registration = { pushManager: { getSubscription: async () => null } };
  ui.context.navigator.serviceWorker = { register: async () => registration, ready: Promise.resolve(registration) };
  await ui.run('initializePush()');
  assert.equal(ui.run('pushKnown'), false);
  const writes = [];
  ui.context.fetch = async (path, options) => {
    if (path === '/api/status') return Response.json({ connected: true, preferences: { ...preferences, enabled: true } });
    if (path === '/api/preferences') { writes.push(JSON.parse(options.body).preferences); return Response.json({ ok: true }); }
    return Response.json({ ready: true, publicKey: 'test' });
  };
  await ui.run('initializePush()');
  assert.deepEqual(writes, [preferences]);
  assert.equal(ui.run('pending'), false);
  assert.equal(ui.run('pushKnown'), true);
});

// 서버 장애 중 저장한 선택은 재실행해도 대기 상태로 남습니다.
test('설정 서버 저장 실패 시 기기에 재전송할 선택 보존', async () => {
  const ui = app({ token: 'a'.repeat(64) });
  ui.context.next = catalog;
  ui.run("applyCatalog(next); openSettings(); changeSettings('enabled'); connected=true;");
  await ui.run('saveSettings()');
  assert.equal(ui.run('preferences.enabled'), false);
  assert.equal(ui.run('pending'), true);
  const saved = JSON.parse(ui.storage.get('zeus-settings'));
  assert.equal(saved.preferences.enabled, false);
  assert.equal(saved.pending, true);
  const reopened = app(saved);
  assert.equal(reopened.run('preferences.enabled'), false);
  assert.equal(reopened.run('pending'), true);
});

// 저장 직후 통신이 끊겨도 예전 서비스 워커 자료로 되돌아가지 않습니다.
test('오프라인 캐시보다 메모리의 최신 관리자 자료 유지', async () => {
  const ui = app();
  ui.context.next = { ...catalog, revision: 'new-admin' };
  ui.run('applyCatalog(next)');
  ui.context.fetch = async () => Response.json(catalog, { headers: { 'X-Zeus-Offline': '1' } });
  await ui.run('refresh()');
  assert.equal(ui.run('catalog.revision'), 'new-admin');
  assert.equal(ui.elements.get('#network').textContent, '오프라인 자료');
});

// 통신 없이 재실행해도 남은 분을 저장해 재사용하지 않고 현재 시각으로 계산합니다.
test('오프라인 재실행은 캐시의 절대 시각으로 복원하고 최신 응답을 보호', async () => {
  const ui = app();
  let release;
  ui.context.caches = {
    keys: async () => ['unrelated-cache', 'zeus-current'],
    open: async () => ({ match: async () => new Promise(resolve => { release = () => resolve(Response.json(catalog)); }) })
  };
  const restoration = ui.run('restoreCatalog()');
  await new Promise(resolve => setImmediate(resolve));
  release();
  await restoration;
  assert.equal(ui.run('catalog.revision'), catalog.revision);
  assert.equal(ui.elements.get('#network').textContent, '오프라인 자료');
  const again = app();
  again.context.caches = ui.context.caches;
  const late = again.run('restoreCatalog()');
  await new Promise(resolve => setImmediate(resolve));
  again.context.next = { ...catalog, revision: 'newer-admin' };
  again.run('applyCatalog(next)');
  release();
  await late;
  assert.equal(again.run('catalog.revision'), 'newer-admin');
});
