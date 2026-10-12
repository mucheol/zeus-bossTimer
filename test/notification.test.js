import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// 실제 서비스 워커의 수신 핸들러를 실행해 Safari의 표시 규칙을 검사합니다.
test('정상·지연·잘못된 푸시 모두 표시하고 기기 소리·진동을 강제하지 않음', async () => {
  const handlers = {};
  const notifications = [];
  const self = {
    // 서비스 워커 이벤트를 보관합니다.
    addEventListener(name, handler) { handlers[name] = handler; },
    registration: {
      // 운영체제 알림에 전달할 내용만 수집합니다.
      async showNotification(title, options) { notifications.push({ title, options }); }
    }
  };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, Date, URL, Response, Headers, fetch });
  const messages = [
    { title: '침공 보스 · 18시', body: '정각 안내', expiresAt: Date.now() + 10000, tag: 'invasion' },
    { title: '출현 5분 전', body: '지난 사전 알림', expiresAt: Date.now() - 10000, tag: 'late' },
    null
  ];
  for (const message of messages) {
    let task;
    handlers.push({ data: { json: () => message }, waitUntil: promise => { task = promise; } });
    await task;
  }
  assert.equal(notifications.length, 3);
  assert.equal(notifications[0].title, messages[0].title);
  assert.equal(notifications[1].title, '제우스 타이머 · 지연된 알림');
  assert.ok(!notifications[1].options.body.includes('5분 전'));
  for (const notification of notifications) {
    assert.equal('silent' in notification.options, false);
    assert.equal('vibrate' in notification.options, false);
    assert.equal(notification.options.data.url, '/');
  }
});
