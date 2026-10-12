import { readBody, invalid } from './validation.js';
import { loadCatalog } from './catalog.js';

const SESSION_MS = 8 * 3600000;

// 인증 응답을 캐시하지 않고 필요한 쿠키만 설정합니다.
function json(value, status = 200, cookie) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}

// 비밀번호 비교와 세션 식별에 사용할 해시를 계산합니다.
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// 스크립트로 읽을 수 없는 관리자 인증 쿠키를 만듭니다.
function sessionCookie(token, age = SESSION_MS / 1000) {
  return `zeus-admin=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}

// 쿠키의 비밀 토큰을 해시로 조회하고 만료를 확인합니다.
async function session(request, env) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)zeus-admin=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  const id = await digest(token);
  return await env.DB.prepare('SELECT id FROM admin_sessions WHERE id=? AND expires_at>?').bind(id, Date.now()).first();
}

// 관리자 인증과 전체 이용자에게 적용할 보스 시간 수정을 처리합니다.
export async function adminApi(request, env) {
  try {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' && request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: '같은 사이트에서만 요청할 수 있습니다.' }, 403);
    if (path === '/api/admin/login' && request.method === 'POST') {
      if (!env.ADMIN_PASSWORD) return json({ error: '관리자 비밀번호 설정이 필요합니다.' }, 503);
      const rate = await env.ADMIN_LOGIN_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
      if (!rate.success) return json({ error: '인증 시도가 많습니다. 1분 뒤 다시 시도해 주세요.' }, 429);
      const body = await readBody(request);
      if (typeof body.password !== 'string' || body.password.length > 256) throw invalid('비밀번호를 입력해 주세요.');
      const [expected, actual] = await Promise.all([digest(env.ADMIN_PASSWORD), digest(body.password)]);
      let difference = 0;
      for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
      if (difference) return json({ error: '비밀번호가 맞지 않습니다.' }, 401);
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').bind(Date.now()),
        env.DB.prepare('INSERT INTO admin_sessions(id,expires_at) VALUES (?,?)').bind(await digest(token), Date.now() + SESSION_MS)
      ]);
      return json({ authenticated: true }, 200, sessionCookie(token));
    }
    const authenticated = await session(request, env);
    if (path === '/api/admin/status' && request.method === 'GET') return json({ authenticated: Boolean(authenticated) });
    if (!authenticated) return json({ error: '관리자 인증이 필요합니다.' }, 401);
    if (path === '/api/admin/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM admin_sessions WHERE id=?').bind(authenticated.id).run();
      return json({ authenticated: false }, 200, sessionCookie('', 0));
    }
    if (path === '/api/admin/time' && request.method === 'PUT') {
      const { bossId, hours, minutes } = await readBody(request);
      const catalog = await loadCatalog(env);
      if (!catalog.bosses.some(boss => boss.id === bossId)) throw invalid('등록된 보스가 아닙니다.');
      if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || minutes < 0 || minutes > 59 || hours * 60 + minutes > 48 * 60) throw invalid('시간은 0~48, 분은 0~59 사이 정수로 입력해 주세요. 최대 48시간입니다.');
      const now = Date.now();
      await env.DB.prepare('INSERT INTO boss_updates(boss_id,recorded_at,spawn_at) VALUES (?,?,?)').bind(bossId, now, now + (hours * 60 + minutes) * 60000).run();
      return json({ catalog: await loadCatalog(env) });
    }
    return json({ error: '요청 경로를 찾을 수 없습니다.' }, 404);
  } catch (error) {
    if (!error.status) console.error('admin-request-failed');
    return json({ error: error.status ? error.message : '관리자 요청에 실패했습니다. 다시 시도해 주세요.' }, error.status || 500);
  }
}
