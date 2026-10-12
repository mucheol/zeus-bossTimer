import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../public/data/catalog.json' with { type: 'json' };
import { estimate, bossTiming, invasionTimes, plannedEvents, orderedBosses, defaultPreferences } from '../public/lib/engine.js';

const previousCatalog = structuredClone(catalog);
for (const boss of previousCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse('2026-10-12T12:01:00+09:00'));
}

// 최신 표와 같은 회차 보정이 원본 시간 그대로 계산되는지 확인합니다.
test('12:01 관측 9마리와 동일 회차 보정은 새 학습 표본이 아니다', () => {
  assert.equal(previousCatalog.bosses.length, 9);
  assert.equal(estimate(previousCatalog.bosses.find(boss => boss.id === 'chrysophagos')).latest.spawnAt, '2026-10-12T12:20:17+09:00');
  for (const boss of previousCatalog.bosses) assert.equal(estimate(boss).sampleCount, 0);
  const timing = bossTiming(previousCatalog.bosses[0], Date.parse('2026-10-12T12:01:00+09:00'));
  assert.equal(timing.kind, 'observed');
  assert.equal(timing.at, Date.parse('2026-10-12T13:57:00+09:00'));
});

// 새 캡처의 예정값과 두 보스의 연속 회차 전환을 확인합니다.
test('12:25 관측 갱신, 두 보스만 새 연속 회차 표본 추가', () => {
  assert.equal(catalog.source, 'screenshot-005');
  assert.equal(catalog.capturedAt, '2026-10-12T12:25:00+09:00');
  assert.equal(catalog.capturedSecondsKnown, false);
  const expected = { tripork: '13:57:00', bedix: '13:54:00', gotsis: '19:16:00', alastor: '12:58:39', iokantos: '16:41:00', kini: '16:44:00', thrason: '16:57:00', chrysophagos: '20:21:00', amorphos: '20:23:00' };
  for (const boss of catalog.bosses) {
    const learned = estimate(boss);
    const previous = estimate(previousCatalog.bosses.find(item => item.id === boss.id)).latest;
    assert.equal(learned.latest.spawnAt, `2026-10-12T${expected[boss.id]}+09:00`);
    assert.equal(learned.latest.source, 'screenshot-005');
    assert.deepEqual(boss.observations.slice(0, -1), previousCatalog.bosses.find(item => item.id === boss.id).observations);
    if (['chrysophagos', 'amorphos'].includes(boss.id)) {
      assert.equal(learned.latest.consecutiveFrom, previous.cycleId);
      assert.equal(learned.sampleCount, 1);
      assert.equal(learned.interval, 8 * 3600000 + (boss.id === 'chrysophagos' ? 43000 : 14000));
    } else {
      assert.equal(learned.latest.cycleId, previous.cycleId);
      assert.equal(learned.sampleCount, 0);
    }
  }
});

// 다음 한 회차까지만 추정하며 지난 추정을 다시 학습하지 않습니다.
test('관측 이후 한 회차 추정, 그 이후에는 자료 대기', () => {
  const boss = catalog.bosses[0];
  assert.equal(bossTiming(boss, Date.parse('2026-10-12T14:00:00+09:00')).kind, 'predicted');
  assert.equal(bossTiming(boss, Date.parse('2026-10-13T02:00:00+09:00')).kind, 'stale');
  assert.equal(estimate(boss).sampleCount, 0);
});

// 명시된 연속 회차만 중앙값에 사용하고 짧거나 누락된 간격은 제외합니다.
test('최근 최대 10개 연속 간격의 중앙값만 사용', () => {
  const start = Date.parse('2026-10-01T00:00:00+09:00');
  let at = start;
  const observations = [{ cycleId: 'c0', spawnAt: new Date(at).toISOString() }];
  for (let i = 1; i <= 12; i++) {
    at += 8 * 3600000 + i * 1000;
    observations.push({ cycleId: `c${i}`, consecutiveFrom: `c${i - 1}`, spawnAt: new Date(at).toISOString() });
  }
  const boss = { respawnHours: 8, observations };
  assert.equal(estimate(boss).sampleCount, 10);
  assert.equal(estimate(boss).interval, 8 * 3600000 + 7500);
  observations.push({ cycleId: 'missed', spawnAt: new Date(at + 16 * 3600000).toISOString() });
  assert.equal(estimate(boss).sampleCount, 10);
  observations.push({ cycleId: 'short', consecutiveFrom: 'missed', spawnAt: new Date(at + 17 * 3600000).toISOString() });
  assert.equal(estimate(boss).sampleCount, 10);
});

// 지나간 침공 시간은 다음날 예약하며 일반 보스의 사전 알림과 분리합니다.
test('KST 자정·12시·18시 침공, 정각만 예약하고 지난 알림 없음', () => {
  const now = Date.parse('2026-10-12T12:01:00+09:00');
  const events = plannedEvents(catalog, { bosses: [], offsets: [600, 300, 60, 0], invasion: [0, 12, 18] }, now);
  assert.equal(events[0].dueAt, Date.parse('2026-10-12T18:00:00+09:00'));
  assert.equal(events[1].dueAt, Date.parse('2026-10-13T00:00:00+09:00'));
  assert.equal(events[2].dueAt, Date.parse('2026-10-13T12:00:00+09:00'));
  assert.ok(events.every(event => event.dueAt > now && !event.title.includes('분 전')));
  assert.equal(plannedEvents(catalog, defaultPreferences(), now).length, 0);
  assert.equal(invasionTimes(Date.parse('2026-10-12T15:01:00Z'))[0].at, Date.parse('2026-10-13T00:00:00+09:00'));
});

// 회차를 보정해도 예약 ID가 같고 이미 지난 알림은 재생하지 않습니다.
test('같은 회차 보정은 같은 알림 키, 지난 시점 제외', () => {
  const now = Date.parse('2026-10-12T12:18:00+09:00');
  const prefs = { bosses: ['chrysophagos'], offsets: [600, 300, 60, 0], invasion: [] };
  const before = plannedEvents(previousCatalog, prefs, now);
  assert.equal(before.filter(event => event.key.includes(':0:')).length, 2);
  const copy = structuredClone(previousCatalog);
  copy.bosses.find(boss => boss.id === 'chrysophagos').observations.at(-1).spawnAt = '2026-10-12T12:20:40+09:00';
  const after = plannedEvents(copy, prefs, now);
  assert.deepEqual(before.map(event => event.key), after.map(event => event.key));
  assert.notEqual(before[0].dueAt, after[0].dueAt);
});

// 레벨 기본 정렬과 사용자 순서에서 중복·삭제·신규 보스를 처리합니다.
test('레벨 내림차순, 사용자 순서 유지, 중복 ID 제외', () => {
  assert.equal(orderedBosses(catalog.bosses)[0].id, 'tripork');
  const ordered = orderedBosses(catalog.bosses, ['kini', 'kini', 'removed']);
  assert.equal(ordered[0].id, 'kini');
  assert.equal(ordered[1].id, 'tripork');
  assert.equal(ordered.length, 9);
});
