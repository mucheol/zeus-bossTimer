import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../public/data/catalog.json' with { type: 'json' };
import { estimate, bossTiming, invasionTimes, plannedEvents, orderedBosses, defaultPreferences, remaining, normalizePreferences, koreanTime } from '../public/lib/engine.js';

const previousCatalog = structuredClone(catalog);
for (const boss of previousCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse('2026-10-12T12:01:00+09:00'));
}
const noonCatalog = structuredClone(catalog);
for (const boss of noonCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse('2026-10-12T12:25:00+09:00'));
}
const afternoonCatalog = { ...structuredClone(catalog), revision: '2026-10-12-screenshot-006-v2', source: 'screenshot-006', capturedAt: '2026-10-12T13:52:00+09:00', capturedSecondsKnown: false };
for (const boss of afternoonCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse(afternoonCatalog.capturedAt));
}

const preciseCatalog = { ...structuredClone(catalog), revision: '2026-10-12-screenshot-007-v1', source: 'screenshot-007', capturedAt: '2026-10-12T15:29:00+09:00', capturedSecondsKnown: true };
for (const boss of preciseCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse(preciseCatalog.capturedAt));
}

const secondsCatalog = { ...structuredClone(catalog), revision: '2026-10-12-screenshot-008-v1', source: 'screenshot-008', capturedAt: '2026-10-12T16:30:20+09:00', capturedSecondsKnown: true };
for (const boss of secondsCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse(secondsCatalog.capturedAt));
}

const eveningCatalog = { ...structuredClone(catalog), revision: '2026-10-12-screenshot-009-v1', source: 'screenshot-009', capturedAt: '2026-10-12T17:17:00+09:00', capturedSecondsKnown: true };
for (const boss of eveningCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse(eveningCatalog.capturedAt));
}

const morningCatalog = { ...structuredClone(catalog), revision: '2026-10-13-screenshot-010-v1', source: 'screenshot-010', capturedAt: '2026-10-13T09:34:00+09:00', capturedSecondsKnown: true };
for (const boss of morningCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse(morningCatalog.capturedAt));
}

const updateCatalog = { ...structuredClone(catalog), revision: '2026-10-14-screenshot-012-v1', source: 'screenshot-012', capturedAt: '2026-10-14T09:21:00+09:00', capturedSecondsKnown: true };
for (const boss of updateCatalog.bosses) {
  boss.observations = boss.observations.filter(observation => Date.parse(observation.capturedAt) <= Date.parse(updateCatalog.capturedAt));
}

// 이전 시점은 새 선택으로 이관하며 전체 중지는 선택 자체를 지우지 않습니다.
test('1·3·5분 시점·기존 설정 이관·전체 알림 중지와 복원', () => {
  assert.deepEqual(defaultPreferences(), { enabled: true, bosses: [], offsets: [300], invasion: [] });
  assert.deepEqual(normalizePreferences({ bosses: ['bedix'], offsets: [600, 0], invasion: [12] }).offsets, [300]);
  assert.deepEqual(normalizePreferences({ offsets: [60, 180, 300, 600, 0] }).offsets, [60, 180, 300]);
  const prefs = { enabled: true, bosses: ['bedix'], offsets: [60, 180, 300], invasion: [0, 12, 18] };
  const now = Date.parse('2026-10-12T12:01:00+09:00');
  const before = plannedEvents(catalog, prefs, now);
  assert.ok(before.filter(event => event.key.startsWith('bedix:')).every(event => /:(60|180|300)$/.test(event.key)));
  prefs.enabled = false;
  assert.deepEqual(plannedEvents(catalog, prefs, now), []);
  assert.deepEqual(prefs.bosses, ['bedix']);
  prefs.enabled = true;
  assert.deepEqual(plannedEvents(catalog, prefs, now), before);
});

// 정확한 초 단위 연속 자료가 없으면 임의의 처치시간을 더하지 않습니다.
test('지역별 기본 처치시간 제거·0초 반복과 화면·푸시 일치', () => {
  const start = Date.parse('2026-10-12T00:00:00+09:00');
  for (const [region, seconds] of [['테살리아', 0], ['자하브', 0]]) {
    const boss = { id: 'test', name: '테스트', region, respawnHours: 8, observations: [{ cycleId: 'c0', capturedAt: new Date(start - 60000).toISOString(), spawnAt: new Date(start).toISOString() }] };
    const model = estimate(boss);
    assert.equal(model.killSeconds, seconds);
    assert.equal(model.interval, 8 * 3600000 + seconds * 1000);
    assert.equal(bossTiming(boss, start).at, start + model.interval);
    assert.equal(bossTiming(boss, start + model.interval).at, start + 2 * model.interval);
    assert.equal(plannedEvents({ bosses: [boss] }, { bosses: ['test'], offsets: [60], invasion: [] }, start)[0].dueAt, bossTiming(boss, start).at - 60000);
  }
});

// 관리자 보정과 이미지의 같은 회차는 하나로 세고 간격 자료만 누적합니다.
test('분 단위 관리자 수정은 기준에 반영하되 처치시간으로 학습하지 않음', () => {
  const start = Date.parse('2026-10-01T00:00:00+09:00');
  const period = 8 * 3600000 + 60000;
  const boss = { region: '자하브', respawnHours: 8, observations: [] };
  for (let cycle = 0; cycle < 8; cycle++) {
    const at = start + cycle * period;
    boss.observations.push({ source: cycle ? `admin-${cycle}` : 'screenshot', cycleId: `c${cycle}`, capturedAt: new Date(at - 600000).toISOString(), spawnAt: new Date(at).toISOString(), precisionSeconds: cycle ? 60 : 1 });
    if (cycle === 1) {
      const first = estimate(boss);
      assert.equal(first.killSeconds, 0);
    }
  }
  const learned = estimate(boss);
  assert.equal(learned.sampleCount, 0);
  assert.equal(learned.manualSampleCount, 0);
  assert.equal(learned.killSeconds, 0);
  const last = boss.observations.at(-1);
  boss.observations.push({ ...last, source: 'admin-repeat', cycleId: 'admin-repeat', capturedAt: new Date(Date.parse(last.capturedAt) + 60000).toISOString() });
  assert.equal(estimate(boss).sampleCount, 0);
  boss.observations.push({ ...last, source: 'screenshot-new', cycleId: 'verified-c7', capturedAt: new Date(Date.parse(last.capturedAt) + 120000).toISOString(), precisionSeconds: 1 });
  assert.equal(estimate(boss).sampleCount, 0);
  assert.equal(estimate(boss).latest.source, 'screenshot-new');
  const copy = structuredClone(boss.observations);
  bossTiming(boss, start + 100 * period);
  assert.deepEqual(boss.observations, copy);
});

// 여러 회차 누락은 회차 수로 나누고 불가능한 입력 간격은 학습에서 제외합니다.
test('남은 초 미확인·분 입력·음수 간격은 처치시간 학습 제외', () => {
  const start = Date.parse('2026-10-01T00:00:00+09:00');
  const first = { source: 'admin-1', cycleId: 'c1', capturedAt: new Date(start - 60000).toISOString(), spawnAt: new Date(start).toISOString(), precisionSeconds: 60 };
  const boss = { region: '테살리아', respawnHours: 8, observations: [first] };
  boss.observations.push({ ...first, source: 'admin-2', cycleId: 'c2', capturedAt: new Date(start + 24 * 3600000 - 60000).toISOString(), spawnAt: new Date(start + 24 * 3600000 + 60000).toISOString() });
  assert.equal(estimate(boss).sampleCount, 0);
  assert.equal(estimate(boss).killSeconds, 0);
  boss.observations.push({ ...first, source: 'admin-wrong', cycleId: 'wrong', capturedAt: new Date(start + 25 * 3600000).toISOString(), spawnAt: new Date(start + 28 * 3600000).toISOString() });
  assert.equal(estimate(boss).sampleCount, 0);
  const uncertain = { region: '테살리아', respawnHours: 8, observations: [first, { ...first, source: 'admin-minus', cycleId: 'minus', spawnAt: new Date(start + 8 * 3600000 - 30000).toISOString(), capturedAt: new Date(start + 8 * 3600000 - 60000).toISOString() }] };
  assert.equal(estimate(uncertain).sampleCount, 0);
  assert.ok(estimate(uncertain).killSeconds >= 0);
});

// 더 이른 시각으로 수정해도 관리자 입력을 우선하고 실제 회차 학습을 유지합니다.
test('큰 관리자 수정은 즉시 적용되지만 잘못된 회차 간격은 학습하지 않음', () => {
  const boss = structuredClone(afternoonCatalog.bosses.find(item => item.id === 'alastor'));
  const before = estimate(boss);
  const now = Date.parse('2026-10-12T14:00:00+09:00');
  boss.observations.push({ source: 'admin-1', cycleId: 'admin-1', capturedAt: new Date(now).toISOString(), spawnAt: new Date(now + 60000).toISOString() });
  assert.equal(bossTiming(boss, now).at, now + 60000);
  assert.equal(estimate(boss).sampleCount, before.sampleCount);
  assert.equal(estimate(boss).interval, before.interval);
  boss.observations.at(-1).spawnAt = new Date(now).toISOString();
  assert.equal(bossTiming(boss, now).at, now + before.interval);
});

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
  const expected = { tripork: '13:57:00', bedix: '13:54:00', gotsis: '19:16:00', alastor: '12:58:39', iokantos: '16:41:00', kini: '16:44:00', thrason: '16:57:00', chrysophagos: '20:21:00', amorphos: '20:23:00' };
  for (const boss of noonCatalog.bosses) {
    const learned = estimate(boss);
    const previous = estimate(previousCatalog.bosses.find(item => item.id === boss.id)).latest;
    assert.equal(learned.latest.spawnAt, `2026-10-12T${expected[boss.id]}+09:00`);
    assert.equal(learned.latest.source, 'screenshot-005');
    assert.equal(learned.latest.capturedAt, '2026-10-12T12:25:00+09:00');
    assert.deepEqual(boss.observations.slice(0, -1), previousCatalog.bosses.find(item => item.id === boss.id).observations);
    if (['chrysophagos', 'amorphos'].includes(boss.id)) {
      assert.equal(learned.latest.consecutiveFrom, previous.cycleId);
      assert.equal(learned.sampleCount, 0);
      assert.equal(learned.interval, 8 * 3600000 + learned.killSeconds * 1000);
      assert.equal(learned.killSeconds, 0);
    } else {
      assert.equal(learned.latest.cycleId, previous.cycleId);
      assert.equal(learned.sampleCount, 0);
    }
  }
});

// 새 회차 한 마리와 기존 회차 보정을 구분하고 과거 원본을 보존합니다.
test('13:52 관측 9마리 갱신, 알라스토르만 새 회차, 기존 연속 관계 유지', () => {
  assert.equal(afternoonCatalog.revision, '2026-10-12-screenshot-006-v2');
  assert.equal(afternoonCatalog.source, 'screenshot-006');
  assert.equal(afternoonCatalog.capturedAt, '2026-10-12T13:52:00+09:00');
  assert.equal(afternoonCatalog.capturedSecondsKnown, false);
  const expected = { tripork: '13:56:59', bedix: '13:53:48', gotsis: '19:17:00', alastor: '21:01:00', iokantos: '16:41:00', kini: '16:44:00', thrason: '16:58:00', chrysophagos: '20:21:00', amorphos: '20:24:00' };
  for (const boss of afternoonCatalog.bosses) {
    const learned = estimate(boss);
    const previous = noonCatalog.bosses.find(item => item.id === boss.id);
    assert.equal(learned.latest.spawnAt, `2026-10-12T${expected[boss.id]}+09:00`);
    assert.equal(learned.latest.source, afternoonCatalog.source);
    assert.equal(learned.latest.capturedAt, afternoonCatalog.capturedAt);
    assert.equal(learned.latest.precisionSeconds, ['tripork', 'bedix'].includes(boss.id) ? 60 : 120);
    assert.deepEqual(boss.observations.slice(0, -1), previous.observations);
    if (boss.id === 'alastor') {
      assert.notEqual(learned.latest.cycleId, estimate(previous).latest.cycleId);
      assert.equal(learned.latest.consecutiveFrom, estimate(previous).latest.cycleId);
    } else {
      assert.equal(learned.latest.cycleId, estimate(previous).latest.cycleId);
      assert.equal(learned.latest.consecutiveFrom, estimate(previous).latest.consecutiveFrom);
    }
    assert.equal(learned.sampleCount, 0);
    assert.equal(learned.interval, boss.respawnHours * 3600000 + learned.killSeconds * 1000);
    assert.equal(learned.killSeconds, 0);
  }
  const now = Date.parse(afternoonCatalog.capturedAt);
  const preferences = { bosses: ['bedix', 'tripork'], offsets: [60, 180, 300], invasion: [] };
  const events = plannedEvents(afternoonCatalog, preferences, now).filter(event => event.key.includes(':0:'));
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.dueAt > now));
  assert.ok(events.every(event => !event.key.endsWith(':300')));
  assert.equal(events.find(event => event.key.startsWith('bedix:') && event.key.endsWith(':60')).dueAt, Date.parse('2026-10-12T13:52:48+09:00'));
});

// 촬영 초 확인과 분 표시 오차를 분리하고 날짜 넘김·새 회차를 보존합니다.
test('15:29:00 정각 관측 9마리, 촬영 초 확인·분 오차·두 새 회차와 이력 보존', () => {
  assert.equal(preciseCatalog.revision, '2026-10-12-screenshot-007-v1');
  assert.equal(preciseCatalog.source, 'screenshot-007');
  assert.equal(preciseCatalog.capturedAt, '2026-10-12T15:29:00+09:00');
  assert.equal(preciseCatalog.capturedSecondsKnown, true);
  assert.match(koreanTime(Date.parse(preciseCatalog.capturedAt), true, true), /15:29:00/);
  assert.ok(!koreanTime(Date.parse(preciseCatalog.capturedAt), true).includes('15:29:00'));
  const expected = { tripork: [630, '2026-10-13T01:59:00+09:00'], bedix: [386, '2026-10-12T21:55:00+09:00'], gotsis: [228, '2026-10-12T19:17:00+09:00'], alastor: [332, '2026-10-12T21:01:00+09:00'], iokantos: [73, '2026-10-12T16:42:00+09:00'], kini: [75, '2026-10-12T16:44:00+09:00'], thrason: [89, '2026-10-12T16:58:00+09:00'], chrysophagos: [292, '2026-10-12T20:21:00+09:00'], amorphos: [295, '2026-10-12T20:24:00+09:00'] };
  for (const boss of preciseCatalog.bosses) {
    const before = afternoonCatalog.bosses.find(item => item.id === boss.id);
    const latest = boss.observations.at(-1);
    const nextCycle = ['bedix', 'tripork'].includes(boss.id);
    assert.deepEqual(boss.observations.slice(0, -1), before.observations);
    assert.equal(latest.source, preciseCatalog.source);
    assert.equal(latest.capturedAt, preciseCatalog.capturedAt);
    assert.equal(latest.capturedSecondsKnown, true);
    assert.equal(latest.remainingSecondsKnown, false);
    assert.equal(latest.precisionSeconds, 60);
    assert.equal(latest.spawnAt, expected[boss.id][1]);
    assert.equal(Date.parse(latest.spawnAt) - Date.parse(latest.capturedAt), expected[boss.id][0] * 60000);
    assert.equal(bossTiming(boss, Date.parse(preciseCatalog.capturedAt)).at, Date.parse(latest.spawnAt));
    if (nextCycle) {
      assert.notEqual(latest.cycleId, before.observations.at(-1).cycleId);
      assert.equal(latest.consecutiveFrom, before.observations.at(-1).cycleId);
    } else {
      assert.equal(latest.cycleId, before.observations.at(-1).cycleId);
      assert.equal(latest.consecutiveFrom, before.observations.at(-1).consecutiveFrom);
    }
    assert.equal(estimate(boss).sampleCount, 0);
  }
  assert.equal(preciseCatalog.bosses.reduce((count, boss) => count + boss.observations.length, 0), 53);
});

// 초가 확인된 같은 회차의 보정은 리스폰 표본을 추가하지 않습니다.
test('16:30:20 관측 9마리와 초 표시 3마리 보정·이력 보존', () => {
  assert.equal(secondsCatalog.source, 'screenshot-008');
  assert.equal(secondsCatalog.capturedAt, '2026-10-12T16:30:20+09:00');
  const expected = { tripork: '2026-10-13T01:59:20+09:00', bedix: '2026-10-12T21:55:20+09:00', gotsis: '2026-10-12T19:16:20+09:00', alastor: '2026-10-12T21:00:20+09:00', iokantos: '2026-10-12T16:40:46+09:00', kini: '2026-10-12T16:43:42+09:00', thrason: '2026-10-12T16:57:07+09:00', chrysophagos: '2026-10-12T20:21:20+09:00', amorphos: '2026-10-12T20:23:20+09:00' };
  for (const boss of secondsCatalog.bosses) {
    const previous = preciseCatalog.bosses.find(item => item.id === boss.id);
    const last = boss.observations.at(-1);
    const exact = ['iokantos', 'kini', 'thrason'].includes(boss.id);
    assert.deepEqual(boss.observations.slice(0, -1), previous.observations);
    assert.equal(last.source, secondsCatalog.source);
    assert.equal(last.capturedAt, secondsCatalog.capturedAt);
    assert.equal(last.spawnAt, expected[boss.id]);
    assert.equal(last.capturedSecondsKnown, true);
    assert.equal(last.remainingSecondsKnown, exact);
    assert.equal(last.precisionSeconds, exact ? 1 : 60);
    assert.equal(last.cycleId, previous.observations.at(-1).cycleId);
    assert.equal(last.consecutiveFrom, previous.observations.at(-1).consecutiveFrom);
    assert.equal(estimate(boss).sampleCount, estimate(previous).sampleCount);
    assert.ok(estimate(boss).killSeconds >= 0);
  }
  assert.equal(secondsCatalog.bosses.reduce((sum, boss) => sum + boss.observations.length, 0), 62);
  const boss = secondsCatalog.bosses.find(item => item.id === 'iokantos');
  const start = Date.parse(secondsCatalog.capturedAt);
  assert.equal(remaining(bossTiming(boss, start).at, start), '10분');
  const reopened = start + 5 * 60000;
  assert.equal(remaining(bossTiming(boss, reopened).at, reopened), '5분');
  assert.equal(bossTiming(boss, reopened).at, Date.parse(expected.iokantos));
});

// 촬영 초만 확인된 분 표시는 원본과 현재 기준만 갱신합니다.
test('17:17:00 관측 71개 보존·세 보스 새 회차·현재 처치시간 0초', () => {
  assert.equal(eveningCatalog.source, 'screenshot-009');
  assert.equal(eveningCatalog.capturedAt, '2026-10-12T17:17:00+09:00');
  const minutes = { tripork: 522, bedix: 278, gotsis: 120, alastor: 224, iokantos: 685, kini: 688, thrason: 461, chrysophagos: 184, amorphos: 187 };
  for (const boss of eveningCatalog.bosses) {
    const previous = secondsCatalog.bosses.find(item => item.id === boss.id);
    const latest = boss.observations.at(-1);
    assert.deepEqual(boss.observations.slice(0, -1), previous.observations);
    assert.equal(latest.capturedSecondsKnown, true);
    assert.equal(latest.remainingSecondsKnown, false);
    assert.equal(latest.precisionSeconds, 60);
    assert.equal(Date.parse(latest.spawnAt) - Date.parse(latest.capturedAt), minutes[boss.id] * 60000);
    if (['iokantos', 'kini', 'thrason'].includes(boss.id)) {
      assert.notEqual(latest.cycleId, previous.observations.at(-1).cycleId);
      assert.equal(latest.consecutiveFrom, previous.observations.at(-1).cycleId);
    } else assert.equal(latest.cycleId, previous.observations.at(-1).cycleId);
    assert.equal(estimate(boss).killSeconds, 0);
    assert.equal(estimate(boss).sampleCount, 0);
  }
  assert.equal(eveningCatalog.bosses.reduce((sum, boss) => sum + boss.observations.length, 0), 71);
});

// 새 관측의 예정값·이력과 중간 회차 누락을 검사하며 분 자료는 학습하지 않습니다.
test('10/13 09:34:00 관측 80개 보존·세 연속 회차·여섯 중간 회차 누락', () => {
  assert.equal(morningCatalog.revision, '2026-10-13-screenshot-010-v1');
  assert.equal(morningCatalog.source, 'screenshot-010');
  assert.equal(morningCatalog.capturedAt, '2026-10-13T09:34:00+09:00');
  assert.equal(morningCatalog.capturedSecondsKnown, true);
  const expected = { tripork: [267, '14:01'], bedix: [263, '13:57'], gotsis: [105, '11:19'], alastor: [208, '13:02'], iokantos: [428, '16:42'], kini: [431, '16:45'], thrason: [445, '16:59'], chrysophagos: [168, '12:22'], amorphos: [171, '12:25'] };
  const now = Date.parse(morningCatalog.capturedAt);
  for (const boss of morningCatalog.bosses) {
    const before = eveningCatalog.bosses.find(item => item.id === boss.id);
    const latest = boss.observations.at(-1);
    assert.deepEqual(boss.observations.slice(0, -1), before.observations);
    assert.equal(latest.source, morningCatalog.source);
    assert.equal(latest.capturedAt, morningCatalog.capturedAt);
    assert.equal(latest.capturedSecondsKnown, true);
    assert.equal(latest.remainingSecondsKnown, false);
    assert.equal(latest.precisionSeconds, 60);
    assert.equal(latest.spawnAt, `2026-10-13T${expected[boss.id][1]}:00+09:00`);
    assert.equal(Date.parse(latest.spawnAt) - now, expected[boss.id][0] * 60000);
    assert.notEqual(latest.cycleId, before.observations.at(-1).cycleId);
    const consecutive = ['tripork', 'iokantos', 'kini'].includes(boss.id);
    assert.equal(latest.consecutiveFrom, consecutive ? before.observations.at(-1).cycleId : undefined);
    assert.equal(bossTiming(boss, now).at, Date.parse(latest.spawnAt));
    assert.equal(bossTiming(boss, Date.parse(latest.spawnAt)).at, Date.parse(latest.spawnAt) + boss.respawnHours * 3600000);
    assert.equal(remaining(bossTiming(boss, now + 60000).at, now + 60000), remaining(Date.parse(latest.spawnAt) - 60000, now));
    assert.equal(estimate(boss).killSeconds, 0);
    assert.equal(estimate(boss).sampleCount, 0);
  }
  assert.equal(morningCatalog.bosses.reduce((sum, boss) => sum + boss.observations.length, 0), 80);
});

// 다른 PC에서 반영한 011·012 관측을 보존하고 013은 같은 출현 재촬영과 다음 회차로 구분합니다.
test('10/14 14:03:25 관측 보존·운영 011/012 이력 유지·같은 출현과 다음 회차 구분', () => {
  assert.equal(catalog.revision, '2026-10-14-screenshot-013-v1');
  assert.equal(catalog.source, 'screenshot-013');
  assert.equal(catalog.capturedAt, '2026-10-14T14:03:25+09:00');
  assert.equal(catalog.capturedSecondsKnown, true);
  const expected = { tripork: '14:04:12', bedix: '15:09:25', gotsis: '19:22:25', alastor: '15:04:25', iokantos: '16:43:25', kini: '16:46:25', thrason: '16:59:25', chrysophagos: '20:23:25', amorphos: '20:26:25' };
  const next = ['gotsis', 'chrysophagos', 'amorphos'];
  const now = Date.parse(catalog.capturedAt);
  for (const boss of catalog.bosses) {
    const before = updateCatalog.bosses.find(item => item.id === boss.id);
    const latest = boss.observations.at(-1);
    const previous = before.observations.at(-1);
    assert.deepEqual(boss.observations.slice(0, -1), before.observations);
    assert.deepEqual(boss.observations.slice(-3, -1).map(item => item.source), ['screenshot-011', 'screenshot-012']);
    assert.equal(latest.source, catalog.source);
    assert.equal(latest.capturedAt, catalog.capturedAt);
    assert.equal(latest.capturedSecondsKnown, true);
    assert.equal(latest.remainingSecondsKnown, boss.id === 'tripork');
    assert.equal(latest.precisionSeconds, boss.id === 'tripork' ? 1 : 60);
    assert.equal(latest.spawnAt, `2026-10-14T${expected[boss.id]}+09:00`);
    if (next.includes(boss.id)) {
      assert.notEqual(latest.cycleId, previous.cycleId);
      assert.equal(latest.consecutiveFrom, previous.cycleId);
    } else {
      assert.equal(latest.cycleId, previous.cycleId);
      assert.equal(latest.consecutiveFrom, undefined);
    }
    assert.equal(bossTiming(boss, now).at, Date.parse(latest.spawnAt));
    assert.equal(bossTiming(boss, Date.parse(latest.spawnAt)).at, Date.parse(latest.spawnAt) + boss.respawnHours * 3600000);
    assert.equal(estimate(boss).killSeconds, 0);
    assert.equal(estimate(boss).sampleCount, 0);
  }
  assert.equal(Date.parse(catalog.bosses[0].observations.at(-1).spawnAt) - now, 47000);
  assert.equal(catalog.bosses.reduce((sum, boss) => sum + boss.observations.length, 0), 107);
});

// 정확한 초 단위 연속 자료와 관리자 분 입력이 있어도 처치시간은 0초로 고정합니다.
test('처치시간 0초 고정·정확한 연속 자료와 분 입력도 학습하지 않음', () => {
  const at = Date.parse('2026-10-12T16:40:46+09:00');
  const exact = { capturedSecondsKnown: true, remainingSecondsKnown: true, precisionSeconds: 1 };
  const boss = { respawnHours: 12, observations: [
    { ...exact, source: 'screenshot-a', cycleId: 'a', spawnAt: new Date(at).toISOString() },
    { ...exact, source: 'screenshot-b', cycleId: 'b', consecutiveFrom: 'a', spawnAt: new Date(at + 12 * 3600000 + 15000).toISOString() }
  ] };
  assert.equal(estimate(boss).killSeconds, 0);
  assert.equal(estimate(boss).sampleCount, 0);
  assert.equal(estimate(boss).interval, 12 * 3600000);
  boss.observations.push({ source: 'admin-minutes', cycleId: 'b', spawnAt: new Date(at + 12 * 3600000 + 60000).toISOString(), precisionSeconds: 60 });
  assert.equal(estimate(boss).killSeconds, 0);
  assert.equal(estimate(boss).latest.source, 'admin-minutes');
  assert.equal(bossTiming(boss, at + 13 * 3600000).at, at + 12 * 3600000 + 60000 + 12 * 3600000);
});

// 지연이 크거나 정밀도가 달라도 리스폰 간격은 고정 리스폰 그대로입니다.
test('고정 리스폰 유지와 지연 자료가 있어도 처치시간 0초', () => {
  const at = Date.parse('2026-10-12T00:00:00+09:00');
  for (const [precision, delay] of [[1, 120], [60, 120], [120, 120], [1, 900]]) {
    const boss = { region: '자하브', respawnHours: 8, observations: [
      { source: 'screenshot-1', cycleId: 'a', capturedAt: new Date(at - 60000).toISOString(), spawnAt: new Date(at).toISOString(), capturedSecondsKnown: true, remainingSecondsKnown: precision === 1, precisionSeconds: precision },
      { source: 'screenshot-2', cycleId: 'b', consecutiveFrom: 'a', capturedAt: new Date(at + 8 * 3600000).toISOString(), spawnAt: new Date(at + 8 * 3600000 + delay * 1000).toISOString(), capturedSecondsKnown: true, remainingSecondsKnown: precision === 1, precisionSeconds: precision }
    ] };
    assert.equal(estimate(boss).killSeconds, 0);
    assert.equal(estimate(boss).interval, 8 * 3600000);
    assert.equal(estimate(boss).sampleCount, 0);
  }
});

// 지난 회차는 처치된 것으로 가정하되 추정을 실제 관측으로 학습하지 않습니다.
test('예정 시각 이후 반복 리스폰, 여러 회차·날짜 건너뛰기와 원본 보존', () => {
  const boss = catalog.bosses[0];
  const original = structuredClone(boss.observations);
  const at = Date.parse(estimate(boss).latest.spawnAt);
  const interval = estimate(boss).interval;
  assert.equal(bossTiming(boss, at - 1).kind, 'observed');
  assert.equal(bossTiming(boss, at).at, at + interval);
  assert.equal(bossTiming(boss, at + interval).at, at + 2 * interval);
  const later = bossTiming(boss, at + 9 * interval + 60000);
  assert.equal(later.kind, 'predicted');
  assert.equal(later.index, 10);
  assert.equal(later.at, at + 10 * interval);
  assert.equal(estimate(boss).sampleCount, estimate({ ...boss, observations: original }).sampleCount);
  assert.deepEqual(boss.observations, original);
});

// 화면과 같은 반복 회차를 예약하고 이미 지난 알림은 되살리지 않습니다.
test('반복 회차 푸시 예약, 매일 갱신해도 회차 키 유지와 미래 알림만 생성', () => {
  const boss = catalog.bosses.find(item => item.id === 'bedix');
  const at = Date.parse(estimate(boss).latest.spawnAt);
  const now = at + 3 * estimate(boss).interval + 60000;
  const prefs = { bosses: [boss.id], offsets: [300, 60], invasion: [] };
  const events = plannedEvents(catalog, prefs, now);
  const timing = bossTiming(boss, now);
  assert.ok(events.length > 2);
  assert.equal(events[0].dueAt, timing.at - 300000);
  assert.equal(events[1].dueAt, timing.at - 60000);
  assert.ok(events[0].key.includes(':4:300'));
  assert.ok(events[0].body.includes('반복 추정'));
  assert.ok(events.every(event => event.dueAt > now && event.dueAt <= now + 3 * 86400000));
  const renewed = plannedEvents(catalog, prefs, now + 86400000);
  assert.deepEqual(renewed.filter(event => event.dueAt <= now + 3 * 86400000).map(event => event.key), events.filter(event => event.dueAt > now + 86400000).map(event => event.key));
});

// 분 표시를 유지하며 기기 시각 경과·변경과 예정 시각 경계를 처리합니다.
test('분 단위 남은 시간, 시·분 경계, 기기 시각 변경과 만료', () => {
  const now = Date.parse('2026-10-12T13:52:00+09:00');
  const at = now + 3600000;
  assert.equal(remaining(at, now), '1시간 0분');
  assert.equal(remaining(at, now + 1000), '59분');
  assert.equal(remaining(at, now + 60000), '59분');
  assert.equal(remaining(at, now + 3540000), '1분');
  assert.equal(remaining(at, now + 3541000), '1분 미만');
  assert.equal(remaining(at, now + 3599999), '1분 미만');
  assert.equal(remaining(at, at), '0분');
  assert.equal(remaining(at, at + 60000), '0분');
  assert.equal(remaining(at, now - 60000), '1시간 1분');
  assert.equal(remaining(now + 12 * 3600000, now), '12시간 0분');
  assert.equal(remaining(null, now), '새 관측 대기');
  const fourMinutes = now + 240000;
  assert.deepEqual([0, 60000, 120000, 180000, 240000].map(elapsed => remaining(fourMinutes, now + elapsed)), ['4분', '3분', '2분', '1분', '0분']);
});

// 연속 간격이 많아도 간격은 항상 고정 리스폰입니다.
test('연속 간격 12개가 있어도 간격은 고정 리스폰', () => {
  const start = Date.parse('2026-10-01T00:00:00+09:00');
  let at = start;
  const precise = { capturedSecondsKnown: true, remainingSecondsKnown: true, precisionSeconds: 1 };
  const observations = [{ ...precise, cycleId: 'c0', spawnAt: new Date(at).toISOString() }];
  for (let i = 1; i <= 12; i++) {
    at += 8 * 3600000 + i * 1000;
    observations.push({ ...precise, cycleId: `c${i}`, consecutiveFrom: `c${i - 1}`, spawnAt: new Date(at).toISOString() });
  }
  const boss = { respawnHours: 8, observations };
  assert.equal(estimate(boss).sampleCount, 0);
  assert.equal(estimate(boss).killSeconds, 0);
  assert.equal(estimate(boss).interval, 8 * 3600000);
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
  const prefs = { bosses: ['chrysophagos'], offsets: [60, 180, 300], invasion: [] };
  const before = plannedEvents(previousCatalog, prefs, now);
  assert.equal(before.filter(event => event.key.includes(':0:')).length, 1);
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

// 레벨 자동 정렬은 별도로 저장된 사용자 순서에 영향을 받지 않습니다.
test('레벨 오름·내림차순과 동률 순서, 사용자 순서 보존', () => {
  const bosses = [{ id: 'a', level: 45 }, { id: 'b', level: 60 }, { id: 'c', level: 45 }];
  const order = ['c', 'b', 'a'];
  assert.deepEqual(orderedBosses(bosses, order, 'level-asc').map(boss => boss.id), ['a', 'c', 'b']);
  assert.deepEqual(orderedBosses(bosses, order, 'level-desc').map(boss => boss.id), ['b', 'a', 'c']);
  assert.deepEqual(orderedBosses(bosses, order, 'custom').map(boss => boss.id), order);
  assert.deepEqual(bosses.map(boss => boss.id), ['a', 'b', 'c']);
  assert.deepEqual(order, ['c', 'b', 'a']);
});

// 날짜가 넘어가거나 여러 회차가 지나도 다음 출현 시각을 비교합니다.
test('출현 시간 양방향 정렬, 날짜 넘김·동률·반복 회차 반영', () => {
  const bosses = [
    { id: 'late', level: 35, at: '2026-10-13T00:15:00+09:00' },
    { id: 'early', level: 45, at: '2026-10-12T23:55:00+09:00' },
    { id: 'tie', level: 60, at: '2026-10-12T23:55:00+09:00' },
    { id: 'stale', level: 65, at: '2026-10-12T08:00:00+09:00' }
  ].map(boss => ({ ...boss, respawnHours: 8, observations: [{ cycleId: 'c1', spawnAt: boss.at }] }));
  const now = Date.parse('2026-10-12T23:50:00+09:00');
  assert.deepEqual(orderedBosses(bosses, [], 'time-asc', now).map(boss => boss.id), ['tie', 'early', 'stale', 'late']);
  assert.deepEqual(orderedBosses(bosses, [], 'time-desc', now).map(boss => boss.id), ['late', 'stale', 'tie', 'early']);
  const next = Date.parse('2026-10-12T23:56:00+09:00');
  assert.deepEqual(orderedBosses(bosses, [], 'time-asc', next).map(boss => boss.id), ['stale', 'late', 'tie', 'early']);
  assert.equal(bossTiming(bosses[1], next).kind, 'predicted');
  const expired = Date.parse('2026-10-13T09:00:00+09:00');
  assert.deepEqual(orderedBosses(bosses, [], 'time-desc', expired).map(boss => boss.id), ['late', 'stale', 'tie', 'early']);
});
