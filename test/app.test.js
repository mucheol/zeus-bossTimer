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
