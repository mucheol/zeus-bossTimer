import { defaultPreferences, orderedBosses, bossTiming, remaining, koreanTime, invasionTimes } from './lib/engine.js';

// 화면에서 단일 요소를 찾습니다.
const $ = selector => document.querySelector(selector);
const bell = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
let catalog;
let registration;
let subscription;
let config;
let editing = false;
let connected = false;
let syncing = false;
let syncTask;
let disconnecting = false;
let storageAvailable = true;
let installPrompt;
let toastTimer;
let saved = readStorage();
let restored = false;
let preferences = defaultPreferences();
let order = Array.isArray(saved.order) ? saved.order : [];
let sort = ['custom', 'level-asc', 'level-desc', 'time-asc', 'time-desc'].includes(saved.sort) ? saved.sort : (order.length ? 'custom' : 'level-desc');
let drag;
let pending = Boolean(saved.pending);

// 손상되거나 사용이 차단된 기기 저장소를 안전하게 읽습니다.
function readStorage() {
  try { return JSON.parse(localStorage.getItem('zeus-settings') || '{}') || {}; } catch { return {}; }
}

// 알림·정렬 설정과 기기 토큰을 저장합니다.
function persist() {
  try {
    saved.preferences = structuredClone(preferences);
    localStorage.setItem('zeus-settings', JSON.stringify({ token: saved.token, preferences, order, sort, pending }));
    storageAvailable = true;
  } catch {
    storageAvailable = false;
    toast('기기 저장 공간을 사용할 수 없습니다. 브라우저 설정을 확인해 주세요.');
  }
}

// 짧은 작업 결과를 화면 하단에 표시합니다.
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

// 외부 데이터의 문자열을 HTML 텍스트로 안전하게 표시합니다.
function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// 저장된 설정에서 현재 지원하는 보스와 시점만 복구합니다.
function restorePreferences(value) {
  const defaults = defaultPreferences();
  return Object.fromEntries(Object.entries({ bosses: catalog.bosses.map(boss => boss.id), offsets: [600, 300, 60, 0], invasion: [0, 12, 18] })
    .map(([key, allowed]) => [key, Array.isArray(value?.[key]) ? [...new Set(value[key].filter(item => allowed.includes(item)))] : defaults[key]]));
}

// 공통 관측값의 초상화와 알림 선택을 2열 목록으로 그립니다.
function renderBosses() {
  if (!catalog) return;
  clearDrag();
  const bosses = orderedBosses(catalog.bosses, order, sort);
  $('#boss-sort').value = sort;
  $('#boss-count').textContent = String(bosses.length).padStart(2, '0');
  $('#boss-list').innerHTML = bosses.map((boss, index) => {
    const x = (boss.portrait[0] - 110) / (2520 - 220) * 100;
    const y = (boss.portrait[1] - 110) / (1080 - 220) * 100;
    const enabled = preferences.bosses.includes(boss.id);
    return `<article class="boss-card" data-boss="${escape(boss.id)}" data-alert-enabled="${enabled}">
      <div class="boss-top"><div class="boss-identity"><h3>${escape(boss.name)}</h3><span class="boss-meta">Lv.${boss.level} · ${escape(boss.region)}</span></div><button class="boss-alert" data-alert="${escape(boss.id)}" aria-label="${escape(boss.name)} 알림" aria-pressed="${enabled}">${bell}<span>${enabled ? '켜짐' : '알림'}</span></button></div>
      <div class="boss-time"><div class="portrait" role="img" aria-label="${escape(boss.name)} 초상화" style="background-position:${x}% ${y}%"></div><div class="countdown" role="timer" title="남은 시간 · 시:분:초"></div></div>
      <div class="card-bottom"><span class="kind"></span><span class="spawn-time"></span></div>
      ${editing ? `<div class="move-buttons"><button data-move="${escape(boss.id)}" data-direction="-1" aria-label="${escape(boss.name)} 앞으로" ${index === 0 ? 'disabled' : ''}>←</button><button class="drag-handle" data-drag="${escape(boss.id)}" aria-label="${escape(boss.name)} 순서 이동" title="끌어서 이동 · 방향키로 한 칸 이동">⠿</button><button data-move="${escape(boss.id)}" data-direction="1" aria-label="${escape(boss.name)} 뒤로" ${index === bosses.length - 1 ? 'disabled' : ''}>→</button></div>` : ''}
    </article>`;
  }).join('');
  tick();
}

// 카운트다운과 한국시간 침공의 다음 일정을 갱신합니다.
function tick() {
  if (!catalog) return;
  const now = Date.now();
  if (!editing && sort.startsWith('time-')) {
    const list = $('#boss-list');
    const bosses = orderedBosses(catalog.bosses, order, sort, now);
    bosses.forEach((boss, index) => {
      const card = list.querySelector(`[data-boss="${boss.id}"]`);
      if (list.children[index] !== card) list.insertBefore(card, list.children[index]);
    });
  }
  for (const boss of catalog.bosses) {
    const card = document.querySelector(`[data-boss="${boss.id}"]`);
    const timing = bossTiming(boss, now);
    for (const kind of ['observed', 'predicted', 'stale']) card.classList.toggle(kind, timing.kind === kind);
    card.classList.toggle('soon', timing.at !== null && timing.at - now < 600000);
    const countdown = card.querySelector('.countdown');
    const text = remaining(timing.at, now);
    countdown.textContent = text;
    const parts = text.split(':');
    countdown.setAttribute('aria-label', timing.at === null ? text : `${Number(parts[0])}시간 ${Number(parts[1])}분 ${Number(parts[2])}초 남음`);
    card.querySelector('.spawn-time').textContent = timing.at ? `${koreanTime(timing.at)} 예정` : `관측 ${koreanTime(Date.parse(timing.latest.capturedAt))}`;
    const kind = card.querySelector('.kind');
    kind.textContent = ({ observed: '관측 기준', predicted: timing.sampleCount < 2 ? '추정 · 자료 부족' : '다음 회차 추정', stale: '갱신 필요' })[timing.kind];
    kind.title = timing.kind === 'predicted' ? (timing.sampleCount < 2 ? '기본 주기 · 보정자료 부족' : `연속 회차 ${timing.sampleCount}개 기준`) : '촬영 초 미상 · 시각 오차 있음';
  }
  for (const button of document.querySelectorAll('[data-hour]')) {
    const hour = Number(button.dataset.hour);
    const next = invasionTimes(now).find(event => event.hour === hour && event.at > now);
    button.title = `다음 ${koreanTime(next.at, true)} 한국시간`;
  }
}

// 알림 토글과 실제 서버 저장 상태를 함께 표시합니다.
function renderSettings() {
  for (const button of document.querySelectorAll('[data-hour]')) {
    const enabled = preferences.invasion.includes(Number(button.dataset.hour));
    button.setAttribute('aria-pressed', enabled);
    button.querySelector('span').textContent = enabled ? '알림 켜짐' : '알림 꺼짐';
    button.setAttribute('aria-label', `${button.dataset.hour}시 침공 알림`);
  }
  for (const button of document.querySelectorAll('[data-offset]')) button.setAttribute('aria-pressed', preferences.offsets.includes(Number(button.dataset.offset)));
  $('#test-push').disabled = !connected;
  $('#disconnect').hidden = !subscription;
  $('#connect').hidden = connected;
  $('#sync-status').textContent = connected ? (pending ? '변경사항 저장 대기 · 연결되면 다시 시도합니다.' : '이 기기의 알림 선택이 서버에 저장됐습니다.') : '선택은 이 기기에 저장됩니다. 알림 연결 후 적용됩니다.';
  const title = connected ? '이 기기 알림 연결됨' : '화면을 닫아도 보스 알림';
  $('#connect-banner strong').textContent = title;
  $('#connect-banner small').textContent = connected ? (pending ? '변경사항이 아직 서버에 저장되지 않았습니다.' : '필드 보스와 침공 시간을 선택해 주세요.') : '홈 화면에 추가하고 알림을 연결하세요.';
}

// 동일 출처 API에 기기 인증을 붙여 요청합니다.
async function api(path, method = 'POST', body) {
  const response = await fetch(path, {
    method, cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${saved.token}` },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '알림 설정 요청에 실패했습니다.');
  return result;
}

// 선택 변경을 순서대로 저장해 늦게 도착한 요청의 덮어쓰기를 막습니다.
async function syncPreferences() {
  if (!connected || !subscription || disconnecting || syncing || !pending) return;
  syncing = true;
  try {
    while (pending && !disconnecting) {
      const snapshot = JSON.stringify(preferences);
      await api('/api/subscription', 'PUT', { subscription: subscription.toJSON(), preferences: JSON.parse(snapshot) });
      pending = snapshot !== JSON.stringify(preferences);
      persist();
    }
  } catch (error) {
    toast(error.message);
  } finally {
    syncing = false;
    syncTask?.resolve();
    syncTask = null;
    renderSettings();
  }
}

// 보스별 선택·침공 시간·알림 시점의 변경을 저장합니다.
function toggle(key, value) {
  preferences[key] = preferences[key].includes(value) ? preferences[key].filter(item => item !== value) : [...preferences[key], value];
  pending = true;
  persist();
  renderSettings();
  renderBosses();
  if (!connected) toast('선택 저장됨 · 알림 설정에서 연결하면 적용됩니다.');
  void syncPreferences();
}

// 최신 공통 자료를 읽고 오프라인 캐시 여부를 명확히 표시합니다.
async function refresh() {
  $('#refresh').disabled = true;
  try {
    const response = await fetch('/data/catalog.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('관측 자료를 불러올 수 없습니다.');
    const next = await response.json();
    const changed = next.revision !== catalog?.revision;
    catalog = next;
    preferences = restorePreferences(!restored ? saved.preferences : preferences);
    restored = true;
    const offline = response.headers.get('X-Zeus-Offline') === '1';
    $('#network').textContent = offline ? '오프라인 자료' : '연결됨';
    $('#source-time').textContent = `${koreanTime(Date.parse(catalog.capturedAt), true)} 관측 · 초 미상`;
    if (changed) renderBosses();
    renderSettings();
  } catch (error) {
    $('#network').textContent = '연결 끊김';
    if (!catalog) {
      $('#boss-list').innerHTML = '<p class="loading">자료를 불러오지 못했습니다. 연결을 확인하고 새로고침해 주세요.</p>';
      toast(error.message);
    }
  } finally { $('#refresh').disabled = false; }
}

// PWA 설치 환경과 권한에 맞는 알림 안내를 표시합니다.
function pushSupport() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (ios && !standalone) return 'iPhone은 Safari에서 홈 화면에 추가한 뒤, 추가된 앱에서 연결해 주세요.';
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) return '이 브라우저는 웹 푸시를 지원하지 않습니다. Android Chrome 또는 홈 화면에 추가한 iPhone 앱을 사용해 주세요.';
  if (Notification.permission === 'denied') return '알림 권한이 차단되어 있습니다. 휴대폰 또는 브라우저 설정에서 이 앱의 알림을 허용해 주세요.';
  return null;
}

// 푸시 공개키를 브라우저 구독용 바이트로 변환합니다.
function publicKeyBytes(key) {
  return Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}

// 사용자가 누른 순간 푸시 구독을 요청하고 서버 예약을 연결합니다.
async function connect() {
  const unsupported = pushSupport();
  if (unsupported) { $('#push-status').textContent = unsupported; return; }
  if (!registration || !config?.ready) { toast('푸시 준비가 아직 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.'); return; }
  $('#connect').disabled = true;
  try {
    if (!saved.token) saved.token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    persist();
    if (!storageAvailable) throw new Error('알림 연결을 유지하려면 기기 저장소를 허용해 주세요.');
    const candidate = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(config.publicKey) });
    subscription = candidate;
    const snapshot = JSON.stringify(preferences);
    await api('/api/subscription', 'PUT', { subscription: candidate.toJSON(), preferences: JSON.parse(snapshot) });
    connected = true;
    pending = snapshot !== JSON.stringify(preferences);
    persist();
    $('#push-status').textContent = '알림 연결됨 · 테스트로 잠금 화면 수신을 확인하세요.';
    toast('알림이 연결됐습니다.');
    void syncPreferences();
  } catch (error) {
    $('#push-status').textContent = pushSupport() || `연결 실패: ${error.message}`;
  } finally {
    $('#connect').disabled = false;
    renderSettings();
  }
}

// 서버 예약을 먼저 제거하고 브라우저 구독도 해제합니다.
async function disconnect() {
  $('#disconnect').disabled = true;
  disconnecting = true;
  try {
    if (syncing) await new Promise(resolve => { syncTask = { resolve }; });
    await api('/api/subscription', 'DELETE');
    connected = false;
    if (subscription) await subscription.unsubscribe();
    subscription = null;
    $('#push-status').textContent = '알림 연결을 해제했습니다. 선택은 기기에 남아 있습니다.';
    toast('이 기기의 예약 알림을 해제했습니다.');
  } catch (error) { toast(error.message); } finally {
    disconnecting = false;
    $('#disconnect').disabled = false;
    renderSettings();
  }
}

// 서비스 워커와 기존 구독을 복구하고 저장 대기 설정을 재전송합니다.
async function initializePush() {
  try {
    if (!('serviceWorker' in navigator)) throw new Error(pushSupport());
    registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    config = await fetch('/api/config', { cache: 'no-store' }).then(response => response.json());
    subscription = await registration.pushManager?.getSubscription();
    if (subscription && saved.token) {
      const status = await api('/api/status');
      connected = status.connected;
      if (connected && !pending && catalog) preferences = restorePreferences(status.preferences);
      if (connected) await syncPreferences();
    }
    $('#push-status').textContent = pushSupport() || (connected ? '이 기기의 시스템 알림이 연결되어 있습니다.' : config.ready ? '원하는 알림을 선택하고 알림을 연결하세요.' : '화면 사용 가능 · 운영자의 푸시 배포 설정이 필요합니다.');
    renderSettings();
    renderBosses();
  } catch (error) { $('#push-status').textContent = error.message || '알림 연결을 확인할 수 없습니다.'; }
}

// 설정 창을 열고 현재 기기의 설치 안내를 보여 줍니다.
function openSettings() {
  if (!$('#settings').open) $('#settings').showModal();
}

// 현재 화면의 순서를 사용자 정렬로 저장합니다.
function saveOrder() {
  order = [...$('#boss-list').children].map(card => card.dataset.boss);
  sort = 'custom';
  persist();
}

// 편집 모드에서 지정 보스를 앞이나 뒤로 지정 칸만큼 이동합니다.
function moveBoss(id, direction, handle = false) {
  const ids = [...$('#boss-list').children].map(card => card.dataset.boss);
  const index = ids.indexOf(id);
  if (index < 0 || index + direction < 0 || index + direction >= ids.length) return;
  [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
  order = ids;
  sort = 'custom';
  persist();
  renderBosses();
  document.querySelector(handle ? `[data-drag="${id}"]` : `[data-move="${id}"][data-direction="${direction}"]`)?.focus();
  toast(`${catalog.bosses.find(boss => boss.id === id).name} · ${index + direction + 1}번째로 이동`);
}

// 드래그 미리보기와 포인터 캡처를 정리합니다.
function clearDrag() {
  if (!drag) return;
  const previous = drag;
  drag = null;
  cancelAnimationFrame(previous.frame);
  previous.ghost?.remove();
  previous.card.classList.remove('drag-source');
  document.body.classList.remove('dragging');
  if ($('#boss-list').hasPointerCapture(previous.pointerId)) $('#boss-list').releasePointerCapture(previous.pointerId);
}

// 손잡이를 누른 위치를 기억하고 터치·마우스 드래그를 준비합니다.
function startDrag(event) {
  const handle = event.target.closest('[data-drag]');
  if (!handle || !event.isPrimary || event.button !== 0 || drag) return;
  handle.focus({ preventScroll: true });
  const card = handle.closest('[data-boss]');
  const rect = card.getBoundingClientRect();
  drag = { pointerId: event.pointerId, card, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
  $('#boss-list').setPointerCapture(event.pointerId);
}

// 손잡이가 일정 거리 이동한 뒤에만 순서 편집을 시작합니다.
function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (drag.ghost || Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
  const rect = drag.card.getBoundingClientRect();
  const ghost = drag.card.cloneNode(true);
  ghost.removeAttribute('data-boss');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.classList.add('drag-ghost');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.append(ghost);
  drag.ghost = ghost;
  drag.card.classList.add('drag-source');
  document.body.classList.add('dragging');
  drag.frame = requestAnimationFrame(drawDrag);
}

// 이동 위치에 카드를 삽입하고 화면 가장자리에서는 자동 스크롤합니다.
function drawDrag(time) {
  if (!drag?.ghost) return;
  const elapsed = Math.min(time - (drag.lastFrame ?? time), 32);
  drag.lastFrame = time;
  drag.ghost.style.left = `${drag.x - drag.offsetX}px`;
  drag.ghost.style.top = `${drag.y - drag.offsetY}px`;
  const edge = 64;
  const speed = drag.y < edge ? -Math.min(1, (edge - drag.y) / edge) : drag.y > innerHeight - edge ? Math.min(1, (drag.y - innerHeight + edge) / edge) : 0;
  if (speed) window.scrollBy(0, speed * elapsed * .65);
  const target = document.elementFromPoint(drag.x, drag.y)?.closest('#boss-list > [data-boss]');
  if (target && target !== drag.card) {
    const cards = [...$('#boss-list').children];
    const after = cards.indexOf(target) > cards.indexOf(drag.card);
    $('#boss-list').insertBefore(drag.card, after ? target.nextSibling : target);
  }
  drag.frame = requestAnimationFrame(drawDrag);
}

// 놓으면 순서를 저장하고 취소하면 드래그 전 순서로 복구합니다.
function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const id = drag.card.dataset.boss;
  const moved = Boolean(drag.ghost);
  if (moved && event.type === 'pointerup') saveOrder();
  clearDrag();
  if (!moved) return;
  renderBosses();
  document.querySelector(`[data-drag="${id}"]`)?.focus({ preventScroll: true });
  if (event.type === 'pointerup') toast('내 순서로 저장했습니다.');
}

$('#settings-open').addEventListener('click', openSettings);
$('#connect-banner').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => $('#settings').close());
$('#refresh').addEventListener('click', refresh);
$('#connect').addEventListener('click', connect);
$('#disconnect').addEventListener('click', disconnect);
$('#test-push').addEventListener('click', async () => {
  $('#test-push').disabled = true;
  try { await api('/api/test'); toast('10초 뒤 발송합니다. 화면을 잠가 확인해 보세요.'); } catch (error) { toast(error.message); }
  setTimeout(renderSettings, 3000);
});
$('#invasion-buttons').addEventListener('click', event => {
  const button = event.target.closest('[data-hour]');
  if (button) toggle('invasion', Number(button.dataset.hour));
});
$('#offsets').addEventListener('click', event => {
  const button = event.target.closest('[data-offset]');
  if (button) toggle('offsets', Number(button.dataset.offset));
});
$('#boss-list').addEventListener('click', event => {
  const alert = event.target.closest('[data-alert]');
  const move = event.target.closest('[data-move]');
  if (alert) toggle('bosses', alert.dataset.alert);
  if (move) moveBoss(move.dataset.move, Number(move.dataset.direction));
});
$('#boss-list').addEventListener('pointerdown', startDrag);
$('#boss-list').addEventListener('pointermove', moveDrag);
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#boss-list').addEventListener(type, endDrag);
$('#boss-list').addEventListener('keydown', event => {
  const handle = event.target.closest('[data-drag]');
  if (!handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const direction = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 }[event.key];
  moveBoss(handle.dataset.drag, direction, true);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && drag) { endDrag({ pointerId: drag.pointerId, type: 'pointercancel' }); event.preventDefault(); }
});
window.addEventListener('blur', () => { if (drag) endDrag({ pointerId: drag.pointerId, type: 'pointercancel' }); });
$('#boss-sort').addEventListener('change', event => {
  sort = event.target.value;
  persist();
  renderBosses();
});
$('#reorder').addEventListener('click', () => {
  editing = !editing;
  $('#reorder').textContent = editing ? '편집 완료' : '순서 편집';
  $('#reorder').setAttribute('aria-pressed', editing);
  $('#order-actions').hidden = !editing;
  renderBosses();
});
$('#reset-order').addEventListener('click', () => { order = []; sort = 'level-desc'; persist(); renderBosses(); toast('높은 레벨 순으로 정렬했습니다.'); });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('#install').hidden = false; });
$('#install').addEventListener('click', async () => { await installPrompt?.prompt(); installPrompt = null; $('#install').hidden = true; });
navigator.serviceWorker?.addEventListener('message', event => { if (event.data?.type === 'UPDATED') $('#update-banner').hidden = false; });
$('#apply-update').addEventListener('click', () => location.reload());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); void refresh(); void syncPreferences(); void registration?.update(); } });
window.addEventListener('focus', tick);
window.addEventListener('pageshow', tick);
window.addEventListener('online', () => { void refresh(); void syncPreferences(); });
window.addEventListener('offline', () => { $('#network').textContent = '오프라인 자료'; });
await refresh();
void initializePush();
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden) { void refresh(); void syncPreferences(); } }, 60000);
