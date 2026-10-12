import { HOURS, OFFSETS, normalizePreferences } from '../public/lib/engine.js';

// 크기가 제한된 JSON 본문만 읽습니다.
export async function readBody(request) {
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
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('JSON 객체가 필요합니다.');
    return value;
  } catch { throw invalid('JSON 객체를 읽을 수 없습니다.'); }
}

// 잘못된 외부 입력을 사용자에게 설명할 오류로 바꿉니다.
export function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// 허용된 배열 값만 중복 없이 받습니다.
export function selection(value, allowed) {
  if (!Array.isArray(value) || value.length > allowed.length || value.some(item => !allowed.includes(item))) {
    throw invalid('알림 선택값이 올바르지 않습니다.');
  }
  return [...new Set(value)];
}

// 등록된 보스와 지원 시점에 한해서 기기 설정을 검증합니다.
export function validatePreferences(value, catalog) {
  if (!value || typeof value !== 'object') throw invalid('알림 설정이 필요합니다.');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw invalid('어플 알림 설정이 올바르지 않습니다.');
  return normalizePreferences({
    enabled: value.enabled,
    bosses: selection(value.bosses, catalog.bosses.map(boss => boss.id)),
    offsets: selection(value.offsets, [...OFFSETS, 0, 600]),
    invasion: selection(value.invasion, HOURS)
  });
}

// 푸시 키의 URL-safe Base64를 바이트로 읽습니다.
export function decodeKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid('푸시 키가 올바르지 않습니다.');
  try {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  } catch {
    throw invalid('푸시 키를 읽을 수 없습니다.');
  }
}

// 공개 푸시 사업자 주소만 허용해 임의 서버로의 요청을 막습니다.
export async function validateSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 2048) throw invalid('푸시 주소가 필요합니다.');
  let url;
  try { url = new URL(value.endpoint); } catch { throw invalid('푸시 주소가 올바르지 않습니다.'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.apple.com');
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw invalid('지원하지 않는 푸시 주소입니다.');
  const p256dh = decodeKey(value.keys?.p256dh);
  const auth = decodeKey(value.keys?.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw invalid('푸시 키 길이가 올바르지 않습니다.');
  try {
    await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch { throw invalid('유효하지 않은 푸시 공개키입니다.'); }
  return { endpoint: url.href, expirationTime: null, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

// 기기 비밀 토큰을 저장하지 않고 해시로 식별합니다.
export async function deviceId(request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw Object.assign(new Error('기기 인증이 필요합니다.'), { status: 401 });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
