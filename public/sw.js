const VERSION = 'zeus-e908499f1b7ef8dd';
const SHELL = ['/', '/app.css', '/app.js', '/lib/engine.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/images/bosses.png', '/data/catalog.json'];

// 첫 설치에 오프라인 화면을 준비합니다.
self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

// 이전 캐시를 정리하고 열린 화면에 새 버전을 알립니다.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const previous = (await caches.keys()).filter(key => key.startsWith('zeus-') && key !== VERSION);
    await Promise.all(previous.map(key => caches.delete(key)));
    await self.clients.claim();
    if (previous.length) for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'UPDATED' });
  })());
});

// 공통 자료는 항상 서버에서 먼저 읽고 연결 실패 시에만 보관본을 제공합니다.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const response = await fetch(event.request);
      if (response.ok && SHELL.includes(url.pathname)) await cache.put(url.pathname, response.clone());
      return response;
    } catch {
      const cached = await cache.match(url.pathname);
      if (!cached) return Response.error();
      const headers = new Headers(cached.headers);
      headers.set('X-Zeus-Offline', '1');
      return new Response(cached.body, { status: 200, headers });
    }
  })());
});

// Safari 구독을 유지하도록 수신한 푸시는 항상 사용자 알림으로 표시합니다.
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let message;
    try { message = event.data?.json(); } catch { message = null; }
    const late = Number.isFinite(message?.expiresAt) && message.expiresAt < Date.now();
    const title = late ? '제우스 타이머 · 지연된 알림' : typeof message?.title === 'string' ? message.title : '제우스 타이머';
    const body = late ? '전달이 늦었습니다. 최신 보스 시간표를 확인해 주세요.'
      : typeof message?.body === 'string' ? message.body : '새 알림이 있습니다. 보스 시간표를 확인해 주세요.';
    await self.registration.showNotification(title, {
      body, icon: '/icons/icon-192.png', badge: '/icons/badge.png',
      tag: typeof message?.tag === 'string' ? message.tag : 'zeus-message', data: { url: '/' }
    });
  })());
});

// 알림을 누르면 열려 있는 앱으로 돌아가거나 새 화면을 엽니다.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(client.url).origin === self.location.origin) { await client.focus(); return; }
    }
    await self.clients.openWindow('/');
  })());
});
