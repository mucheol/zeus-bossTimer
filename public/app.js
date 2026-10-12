import { defaultPreferences, normalizePreferences, orderedBosses, bossTiming, remaining, koreanTime, invasionTimes } from './lib/engine.js';

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
let preferences = normalizePreferences(saved.preferences || defaultPreferences());
let order = Array.isArray(saved.order) ? saved.order : [];
let sort = ['custom', 'level-asc', 'level-desc', 'time-asc', 'time-desc'].includes(saved.sort) ? saved.sort : (order.length ? 'custom' : 'level-desc');
let drag;
let pending = Boolean(saved.pending);
let administrator = false;
let editedBoss;
let settingsDraft;
let settingsSaving = false;
let settingsMessage = '';
let pushBusy = false;
let checkingPush = false;
let pushKnown = !saved.token;
let catalogRequest = 0;
let adminWriting = false;
let historyBefore;

// 손상되거나 사용이 차단된 기기 저장소를 안전하게 읽습니다.
function readStorage() {
  try { return JSON.parse(localStorage.getItem('zeus-settings') || '{}') || {}; } catch { return {}; }
}

// 알림·정렬 설정과 기기 토큰을 저장합니다.
function persist(candidate = preferences, nextPending = pending) {
  try {
    localStorage.setItem('zeus-settings', JSON.stringify({ token: saved.token, preferences: candidate, order, sort, pending: nextPending }));
    saved.preferences = structuredClone(candidate);
    storageAvailable = true;
    return true;
  } catch {
    storageAvailable = false;
    toast('기기 저장 공간을 사용할 수 없습니다. 브라우저 설정을 확인해 주세요.');
    return false;
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
  return normalizePreferences(value, catalog?.bosses.map(boss => boss.id));
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
    return `<article class="boss-card" data-boss="${escape(boss.id)}" data-alert-enabled="${enabled}" ${administrator ? `tabindex="0" aria-label="${escape(boss.name)} 공통 시간 수정"` : ''}>
      <div class="boss-top"><div class="boss-identity"><h3>${escape(boss.name)}</h3><span class="boss-meta">Lv.${boss.level} · ${escape(boss.region)}</span></div><button class="boss-alert" data-alert="${escape(boss.id)}" aria-label="${escape(boss.name)} 알림" aria-pressed="${enabled}">${bell}<span>${enabled ? preferences.enabled ? '켜짐' : '일시중지' : '알림'}</span></button></div>
      <div class="boss-time"><div class="portrait" role="img" aria-label="${escape(boss.name)} 초상화" style="background-position:${x}% ${y}%"></div><div class="countdown" role="timer" title="남은 시간 · 분 단위"></div></div>
      <div class="card-bottom"><span class="spawn-time"></span></div>
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
    card.classList.toggle('soon', timing.at !== null && timing.at - now < 600000);
    const countdown = card.querySelector('.countdown');
    const text = remaining(timing.at, now);
    countdown.innerHTML = escape(text).replace(/(시간|분)/g, '<span class="time-unit">$1</span>');
    countdown.setAttribute('aria-label', timing.at === null ? text : `${text} 남음`);
    card.querySelector('.spawn-time').textContent = timing.at ? `${koreanTime(timing.at)} 예정` : `관측 ${koreanTime(Date.parse(timing.latest.capturedAt))}`;
  }
  for (const button of document.querySelectorAll('[data-hour]')) {
    const hour = Number(button.dataset.hour);
    const next = invasionTimes(now).find(event => event.hour === hour && event.at > now);
    button.title = `다음 ${koreanTime(next.at, true)} 한국시간`;
  }
}

// 알림 토글과 실제 서버 저장 상태를 함께 표시합니다.
function renderSettings() {
  for (const button of $('#settings').querySelectorAll('button')) button.disabled = settingsSaving;
  document.body.classList.toggle('alerts-paused', !preferences.enabled);
  for (const button of document.querySelectorAll('[data-hour]')) {
    const enabled = preferences.invasion.includes(Number(button.dataset.hour));
    button.setAttribute('aria-pressed', enabled);
    button.querySelector('span').textContent = enabled ? preferences.enabled ? '알림 켜짐' : '선택 · 중지' : '알림 꺼짐';
    button.setAttribute('aria-label', `${button.dataset.hour}시 침공 알림`);
  }
  $('#test-push').disabled = settingsSaving || pushBusy || !connected || !preferences.enabled;
  $('#connect').disabled = settingsSaving || pushBusy;
  $('#disconnect').disabled = settingsSaving || pushBusy;
  $('#check-permission').disabled = settingsSaving || pushBusy || checkingPush;
  $('#settings-save').disabled = settingsSaving || pushBusy || !catalog;
  $('#disconnect').hidden = !subscription && !connected;
  $('#connect').hidden = connected && Boolean(subscription);
  const unconfirmed = pending && Boolean(saved.token);
  $('#sync-status').textContent = !pushKnown || unconfirmed ? '서버 적용 확인 대기 · 기존 알림이 도착할 수 있습니다. 연결되면 다시 시도합니다.' : connected ? '이 기기의 알림 선택이 서버에 저장됐습니다.' : '선택은 이 기기에 저장됩니다. 알림 연결 후 적용됩니다.';
  const title = !preferences.enabled ? unconfirmed || !pushKnown ? '전체 알림 끄기 · 서버 확인 대기' : '전체 알림 꺼짐' : connected ? '이 기기 알림 연결됨' : '화면을 닫아도 보스 알림';
  $('#connect-banner strong').textContent = title;
  $('#connect-banner small').textContent = !preferences.enabled ? (unconfirmed || !pushKnown ? '서버 저장 대기 · 아직 알림이 도착할 수 있습니다.' : '환경설정에서 다시 켜세요. 개별 선택은 유지됩니다.') : connected ? (pending ? '변경사항이 아직 서버에 저장되지 않았습니다.' : '필드 보스와 침공 시간을 선택해 주세요.') : '홈 화면에 추가하고 알림을 연결하세요.';
  renderSettingsDraft();
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
  if (!connected || disconnecting || syncing || settingsSaving || !pending) return;
  syncing = true;
  try {
    while (pending && !disconnecting) {
      const snapshot = JSON.stringify(preferences);
      await api('/api/preferences', 'PUT', { preferences: JSON.parse(snapshot) });
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
  if (settingsSaving) return;
  const candidate = structuredClone(preferences);
  candidate[key] = candidate[key].includes(value) ? candidate[key].filter(item => item !== value) : [...candidate[key], value];
  if (!persist(candidate, true)) return;
  preferences = candidate;
  pending = true;
  renderSettings();
  renderBosses();
  if (!connected) toast('선택 저장됨 · 알림 설정에서 연결하면 적용됩니다.');
  void syncPreferences();
}

// 공통 자료를 반영하고 관리자 수정·오프라인 상태를 표시합니다.
function applyCatalog(next, offline = false) {
  const changed = next.revision !== catalog?.revision;
  catalog = next;
  preferences = restorePreferences(!restored ? saved.preferences : preferences);
  restored = true;
  $('#network').textContent = offline ? '오프라인 자료' : '연결됨';
  $('#source-time').textContent = `${koreanTime(Date.parse(catalog.capturedAt), true, catalog.capturedSecondsKnown)} ${catalog.source === 'admin' ? '관리자 수정' : catalog.capturedSecondsKnown ? '관측' : '관측 · 초 미상'}`;
  if (changed) renderBosses();
  else tick();
  renderSettings();
}

// 서버 응답을 기다리지 않고 보관한 공통 시각으로 카운트다운을 복원합니다.
async function restoreCatalog() {
  try {
    if (!('caches' in globalThis)) return;
    const names = (await caches.keys()).filter(name => name.startsWith('zeus-')).reverse();
    for (const name of names) {
      const response = await (await caches.open(name)).match('/data/catalog.json');
      if (!response?.ok) continue;
      const next = await response.json();
      if (!catalog && Array.isArray(next.bosses) && next.bosses.length) applyCatalog(next, true);
      return;
    }
  } catch { /* 보관 자료가 없으면 일반 자료 요청으로 계속 진행합니다. */ }
}

// 최신 공통 자료를 읽고 오프라인 캐시 여부를 명확히 표시합니다.
async function refresh() {
  if (adminWriting) return;
  const requestId = ++catalogRequest;
  $('#refresh').disabled = true;
  try {
    const response = await fetch('/data/catalog.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('관측 자료를 불러올 수 없습니다.');
    const next = await response.json();
    if (requestId === catalogRequest) {
      const offline = response.headers.get('X-Zeus-Offline') === '1';
      applyCatalog(offline && catalog ? catalog : next, offline);
    }
  } catch (error) {
    if (requestId !== catalogRequest) return;
    $('#network').textContent = catalog ? '오프라인 자료' : '연결 끊김';
    if (!catalog) {
      $('#boss-list').innerHTML = '<p class="loading">자료를 불러오지 못했습니다. 연결을 확인하고 새로고침해 주세요.</p>';
      toast(error.message);
    }
  } finally { if (requestId === catalogRequest) $('#refresh').disabled = false; }
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
  if (pushBusy || settingsSaving) return;
  const unsupported = pushSupport();
  if (unsupported) { $('#push-status').textContent = unsupported; return; }
  if (!registration || !config?.ready) { toast('푸시 준비가 아직 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.'); return; }
  pushBusy = true;
  renderSettings();
  try {
    if (!saved.token) saved.token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    persist();
    if (!storageAvailable) throw new Error('알림 연결을 유지하려면 기기 저장소를 허용해 주세요.');
    const candidate = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(config.publicKey) });
    subscription = candidate;
    const snapshot = JSON.stringify(preferences);
    await api('/api/subscription', 'PUT', { subscription: candidate.toJSON(), preferences: JSON.parse(snapshot) });
    connected = true;
    pushKnown = true;
    pending = snapshot !== JSON.stringify(preferences);
    persist();
    $('#push-status').textContent = '알림 연결됨 · 테스트로 잠금 화면 수신을 확인하세요.';
    toast('알림이 연결됐습니다.');
    void syncPreferences();
  } catch (error) {
    $('#push-status').textContent = pushSupport() || `연결 실패: ${error.message}`;
  } finally {
    pushBusy = false;
    renderSettings();
  }
}

// 서버 예약을 먼저 제거하고 브라우저 구독도 해제합니다.
async function disconnect() {
  if (pushBusy || settingsSaving || !confirm('이 기기의 푸시 연결과 모든 예약을 즉시 해제할까요? 개별 선택은 유지됩니다.')) return;
  pushBusy = true;
  renderSettings();
  disconnecting = true;
  try {
    if (syncing) await new Promise(resolve => { syncTask = { resolve }; });
    await api('/api/subscription', 'DELETE');
    connected = false;
    pushKnown = true;
    pending = false;
    persist();
    if (subscription) await subscription.unsubscribe();
    subscription = null;
    $('#push-status').textContent = '알림 연결을 해제했습니다. 선택은 기기에 남아 있습니다.';
    toast('이 기기의 예약 알림을 해제했습니다.');
  } catch (error) { toast(error.message); } finally {
    disconnecting = false;
    pushBusy = false;
    renderSettings();
  }
}

// 서비스 워커와 기존 구독을 복구하고 저장 대기 설정을 재전송합니다.
async function initializePush() {
  if (pushBusy || checkingPush || settingsSaving) return;
  checkingPush = true;
  renderSettings();
  try {
    if (!('serviceWorker' in navigator)) throw new Error(pushSupport());
    registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    subscription = await registration.pushManager?.getSubscription();
    if (saved.token) {
      const status = await api('/api/status');
      pushKnown = true;
      connected = status.connected;
      if (connected && !pending && catalog) {
        const changed = settingsChanged();
        preferences = restorePreferences(status.preferences);
        if (settingsDraft && !changed) settingsDraft = structuredClone(preferences);
        persist();
      }
      if (connected) await syncPreferences();
    }
    config = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(15000) }).then(response => { if (!response.ok) throw new Error('푸시 설정 확인에 실패했습니다.'); return response.json(); });
    $('#push-status').textContent = pushSupport() || (connected ? subscription ? '이 기기의 시스템 알림이 연결되어 있습니다.' : '기존 서버 예약이 있습니다. 알림을 다시 연결해 주세요.' : config.ready ? '원하는 알림을 선택하고 알림을 연결하세요.' : '화면 사용 가능 · 운영자의 푸시 배포 설정이 필요합니다.');
    renderSettings();
    renderBosses();
  } catch (error) { $('#push-status').textContent = error.message || '알림 연결을 확인할 수 없습니다.'; } finally { checkingPush = false; renderSettings(); }
}

// 저장된 값의 사본으로 환경설정 편집을 시작합니다.
function openSettings() {
  if ($('#settings').open) return;
  if (!restored) { toast('보스 자료와 저장된 설정을 불러오는 중입니다. 잠시 후 다시 열어 주세요.'); return; }
  settingsDraft = structuredClone(preferences);
  settingsMessage = '';
  renderSettings();
  $('#settings').showModal();
}

// 선택 순서가 바뀌어도 실제 설정값이 같은지 비교합니다.
function settingsFingerprint(value) {
  return JSON.stringify({ enabled: value.enabled, bosses: [...value.bosses].sort(), offsets: [...value.offsets].sort(), invasion: [...value.invasion].sort() });
}

// 아직 저장하지 않은 환경설정 변경을 확인합니다.
function settingsChanged() {
  return Boolean(settingsDraft && settingsFingerprint(settingsDraft) !== settingsFingerprint(preferences));
}

// 임시 설정과 실제 푸시 연결 상태를 구분해 표시합니다.
function renderSettingsDraft() {
  if (!settingsDraft) return;
  $('#alerts-enabled').setAttribute('aria-checked', settingsDraft.enabled);
  $('#alerts-enabled').textContent = settingsDraft.enabled ? '켜짐' : '꺼짐';
  for (const button of document.querySelectorAll('[data-offset]')) button.setAttribute('aria-pressed', settingsDraft.offsets.includes(Number(button.dataset.offset)));
  for (const button of document.querySelectorAll('[data-settings-hour]')) button.setAttribute('aria-pressed', settingsDraft.invasion.includes(Number(button.dataset.settingsHour)));
  const list = $('#settings-bosses');
  if (catalog && list.dataset.revision !== catalog.revision) {
    list.innerHTML = catalog.bosses.map(boss => `<button data-settings-boss="${escape(boss.id)}" aria-pressed="false">${escape(boss.name)}</button>`).join('');
    list.dataset.revision = catalog.revision;
  }
  for (const button of list.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', settingsDraft.bosses.includes(button.dataset.settingsBoss));
    button.disabled = settingsSaving;
  }
  $('#settings-save').textContent = settingsSaving ? '저장 중…' : '설정 저장';
  $('#settings-status').textContent = settingsMessage || (settingsChanged() ? '저장하지 않은 변경사항이 있습니다.' : '이 기기에 적용할 설정을 선택하고 저장하세요.');
}

// 환경설정의 선택은 저장 전까지 임시값만 바꿉니다.
function changeSettings(key, value) {
  if (!settingsDraft || settingsSaving) return;
  settingsDraft[key] = key === 'enabled' ? !settingsDraft.enabled : settingsDraft[key].includes(value) ? settingsDraft[key].filter(item => item !== value) : [...settingsDraft[key], value];
  settingsMessage = '';
  renderSettingsDraft();
}

// X·닫기·Escape에서 변경 폐기를 확인합니다.
function closeSettings() {
  if (settingsSaving) return;
  if (settingsChanged() && !confirm('저장하지 않은 변경사항이 있습니다. 변경사항을 버리고 닫을까요?')) return;
  settingsDraft = null;
  $('#settings').close();
}

// 서버 저장이 성공한 설정만 실제 선택으로 반영합니다.
async function saveSettings() {
  if (!settingsDraft || settingsSaving || pushBusy) return;
  if (settingsDraft.enabled && settingsDraft.bosses.length && !settingsDraft.offsets.length) {
    settingsMessage = '필드 보스 알림 시점을 하나 이상 선택해 주세요.';
    renderSettingsDraft();
    return;
  }
  const candidate = restorePreferences(settingsDraft);
  settingsSaving = true;
  settingsMessage = '';
  renderSettings();
  try {
    if (syncing) await new Promise(resolve => { syncTask = { resolve }; });
    if (!persist(candidate, true)) throw new Error('기기 저장에 실패했습니다. 저장소 권한을 확인한 뒤 다시 저장해 주세요.');
    preferences = candidate;
    pending = true;
    if (connected) {
      try {
        await api('/api/preferences', 'PUT', { preferences: candidate });
        pending = false;
        persist();
      } catch { /* 기기에 저장한 변경은 다음 연결에서 재전송합니다. */ }
    }
    settingsDraft = null;
    $('#settings').close();
    renderBosses();
    toast(pending && saved.token ? '기기에 저장됨 · 서버 적용 대기 중이며 기존 알림이 도착할 수 있습니다.' : !preferences.enabled ? '전체 알림을 껐습니다. 개별 선택은 유지됩니다.' : connected ? '알림 설정을 저장했습니다.' : '기기에 저장했습니다. 푸시 알림을 연결해 주세요.');
  } catch (error) { settingsMessage = `저장 실패: ${error.message}`; } finally {
    settingsSaving = false;
    renderSettings();
    if (pending && !connected) void initializePush();
  }
}

// 현재 기기에 맞는 시스템 알림 설정 경로를 안내합니다.
function showDeviceNotifications() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('#device-guide').textContent = ios ? 'iPhone: 홈 화면에 추가한 앱에서 푸시 알림을 허용하세요. 소리·배너는 iPhone 설정 → 알림 → 설치한 제우스 앱에서 변경합니다. 차단했으면 알림 허용을 다시 켜세요.' : /Android/.test(navigator.userAgent) ? 'Android: 휴대폰 설정 → 앱 → Chrome 또는 설치한 제우스 앱 → 알림에서 알림·소리·진동을 확인하세요. 사이트 권한은 Chrome → 설정 → 사이트 설정 → 알림에서 이 사이트를 허용하세요.' : '브라우저 주소창의 사이트 정보 → 알림에서 허용하세요. 소리·배너는 운영체제 설정 → 알림 → 사용 중인 브라우저에서 확인합니다.';
  $('#device-guide').hidden = false;
}

// 관리자 상태를 화면에만 반영하며 권한 판단은 서버에 맡깁니다.
function setAdministrator(value) {
  administrator = value;
  document.body.classList.toggle('admin-mode', value);
  $('#admin-open').textContent = value ? '관리중' : '관리자';
  $('#admin-open').setAttribute('aria-pressed', value);
  $('#admin-hint').hidden = !value;
  $('#admin-login').hidden = value;
  $('#admin-authorized').hidden = !value;
  renderBosses();
}

// 비밀번호와 수정 요청을 동일 출처의 관리자 API로 전송합니다.
async function adminRequest(path, method = 'GET', body) {
  const response = await fetch(`/api/admin/${path}`, {
    method, cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') setAdministrator(false);
    throw new Error(result.error || '관리자 요청에 실패했습니다.');
  }
  return result;
}

// 기존의 유효한 관리자 세션을 복원합니다.
async function restoreAdmin() {
  try { setAdministrator((await adminRequest('status')).authenticated); } catch { setAdministrator(false); }
}

// 관리자 저장 중에는 이전에 시작한 공통 자료 요청을 무효화합니다.
async function changeBossTime(path, method, body) {
  if (adminWriting) throw new Error('다른 수정이 저장 중입니다. 잠시 후 다시 시도해 주세요.');
  adminWriting = true;
  catalogRequest++;
  try {
    const result = await adminRequest(path, method, body);
    applyCatalog(result.catalog);
  } finally {
    adminWriting = false;
    $('#refresh').disabled = false;
    void refresh();
  }
}

// 관리자 수정·취소 이력을 최신순으로 불러옵니다.
async function loadHistory(more = false) {
  $('#history-more').disabled = true;
  $('#history-refresh').disabled = true;
  try {
    const result = await adminRequest(`history${more && historyBefore ? `?before=${historyBefore}` : ''}`);
    const html = result.entries.map(entry => {
      const boss = catalog?.bosses.find(item => item.id === entry.bossId);
      return `<li><strong>${escape(boss?.name || entry.bossId)} · ${entry.undoOf ? `#${entry.undoOf} 수정 되돌림` : '시간 수정'}</strong><small>#${entry.id} · ${koreanTime(entry.recordedAt, true, true)}</small>${entry.undoOf ? '' : `<span>출현 예정 ${koreanTime(entry.spawnAt, true, true)}${entry.undoneBy ? ' · 취소됨' : ''}</span>`}${entry.canUndo ? `<button class="secondary" data-undo="${entry.id}">이 수정 되돌리기</button>` : ''}</li>`;
    }).join('');
    if (more) $('#admin-history').insertAdjacentHTML('beforeend', html);
    else $('#admin-history').innerHTML = html || '<li>아직 관리자 수정 이력이 없습니다.</li>';
    historyBefore = result.nextBefore;
    $('#history-more').hidden = !historyBefore;
    $('#admin-status').textContent = '';
  } catch (error) { $('#admin-status').textContent = error.message; } finally {
    $('#history-more').disabled = false;
    $('#history-refresh').disabled = false;
  }
}

// 선택한 보스의 공통 남은 시간·분 입력창을 엽니다.
function openBossEditor(id) {
  if (!administrator || editing) return;
  const boss = catalog?.bosses.find(item => item.id === id);
  if (!boss) return;
  editedBoss = id;
  const minutes = Math.max(0, Math.ceil((bossTiming(boss).at - Date.now()) / 60000));
  $('#boss-edit-name').textContent = `${boss.name} · Lv.${boss.level} · ${boss.region}`;
  $('#boss-hours').value = Math.floor(minutes / 60);
  $('#boss-minutes').value = minutes % 60;
  $('#boss-edit-status').textContent = '';
  $('#boss-editor').showModal();
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
$('#admin-open').addEventListener('click', async () => {
  await restoreAdmin();
  $('#admin-status').textContent = '';
  if (!$('#admin-panel').open) $('#admin-panel').showModal();
  if (administrator) void loadHistory();
});
$('#admin-close').addEventListener('click', () => $('#admin-panel').close());
$('#boss-edit-close').addEventListener('click', () => $('#boss-editor').close());
$('#admin-login').addEventListener('submit', async event => {
  event.preventDefault();
  $('#admin-login-submit').disabled = true;
  try {
    await adminRequest('login', 'POST', { password: $('#admin-password').value });
    setAdministrator(true);
    $('#admin-panel').close();
    toast('관리자 모드 · 보스를 눌러 공통 시간을 수정하세요.');
  } catch (error) { $('#admin-status').textContent = error.message; } finally {
    $('#admin-password').value = '';
    $('#admin-login-submit').disabled = false;
  }
});
$('#admin-logout').addEventListener('click', async () => {
  try { await adminRequest('logout', 'POST'); setAdministrator(false); $('#admin-panel').close(); } catch (error) { $('#admin-status').textContent = error.message; }
});
$('#boss-edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#boss-edit-save').disabled = true;
  try {
    await changeBossTime('time', 'PUT', { bossId: editedBoss, hours: Number($('#boss-hours').value), minutes: Number($('#boss-minutes').value) });
    $('#boss-editor').close();
    toast('공통 시간 저장됨 · 다른 앱에도 15초 이내 반영됩니다.');
  } catch (error) { $('#boss-edit-status').textContent = error.message; } finally { $('#boss-edit-save').disabled = false; }
});
$('#history-refresh').addEventListener('click', () => loadHistory());
$('#history-more').addEventListener('click', () => loadHistory(true));
$('#admin-history').addEventListener('click', async event => {
  const button = event.target.closest('[data-undo]');
  if (!button || adminWriting || !confirm('이 수정을 취소하고 이전 시간 기준으로 복원할까요? 모든 앱에 공유됩니다.')) return;
  button.disabled = true;
  try {
    await changeBossTime('undo', 'POST', { id: Number(button.dataset.undo) });
    toast('이전 시간 기준으로 복원했습니다. 모든 앱에 반영됩니다.');
  } catch (error) { toast(error.message); } finally { await loadHistory(); }
});
$('#connect-banner').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-cancel').addEventListener('click', closeSettings);
$('#settings').addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
$('#settings-save').addEventListener('click', saveSettings);
$('#alerts-enabled').addEventListener('click', () => changeSettings('enabled'));
$('#device-notifications').addEventListener('click', showDeviceNotifications);
$('#check-permission').addEventListener('click', initializePush);
$('#select-all-bosses').addEventListener('click', () => { if (settingsDraft && !settingsSaving) { settingsDraft.bosses = catalog?.bosses.map(boss => boss.id) || []; settingsMessage = ''; renderSettingsDraft(); } });
$('#clear-bosses').addEventListener('click', () => { if (settingsDraft && !settingsSaving) { settingsDraft.bosses = []; settingsMessage = ''; renderSettingsDraft(); } });
$('#settings-bosses').addEventListener('click', event => { const button = event.target.closest('[data-settings-boss]'); if (button) changeSettings('bosses', button.dataset.settingsBoss); });
$('#settings-invasion').addEventListener('click', event => { const button = event.target.closest('[data-settings-hour]'); if (button) changeSettings('invasion', Number(button.dataset.settingsHour)); });
window.addEventListener('beforeunload', event => { if (settingsChanged()) { event.preventDefault(); event.returnValue = ''; } });
$('#refresh').addEventListener('click', refresh);
$('#connect').addEventListener('click', connect);
$('#disconnect').addEventListener('click', disconnect);
$('#test-push').addEventListener('click', async () => {
  if (!connected || !preferences.enabled || settingsSaving || pushBusy) return;
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
  if (button) changeSettings('offsets', Number(button.dataset.offset));
});
$('#boss-list').addEventListener('click', event => {
  const alert = event.target.closest('[data-alert]');
  const move = event.target.closest('[data-move]');
  if (alert) toggle('bosses', alert.dataset.alert);
  if (move) moveBoss(move.dataset.move, Number(move.dataset.direction));
  if (!event.target.closest('button')) openBossEditor(event.target.closest('[data-boss]')?.dataset.boss);
});
$('#boss-list').addEventListener('pointerdown', startDrag);
$('#boss-list').addEventListener('pointermove', moveDrag);
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#boss-list').addEventListener(type, endDrag);
$('#boss-list').addEventListener('keydown', event => {
  if (administrator && !event.target.closest('button') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openBossEditor(event.target.closest('[data-boss]')?.dataset.boss); return; }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); void refresh(); void initializePush(); void registration?.update(); } });
window.addEventListener('focus', tick);
window.addEventListener('pageshow', tick);
window.addEventListener('online', () => { void refresh(); void initializePush(); });
window.addEventListener('offline', () => { $('#network').textContent = '오프라인 자료'; });
// 자료 요청과 별개로 기기 시각에 맞춰 화면을 계속 갱신합니다.
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden) { void refresh(); if (!config || !pushKnown || (!connected && pending && saved.token)) void initializePush(); else void syncPreferences(); } }, 15000);
void restoreCatalog();
void refresh().then(initializePush);
void restoreAdmin();
