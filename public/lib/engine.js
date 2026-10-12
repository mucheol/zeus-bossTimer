export const HOURS = [0, 12, 18];
export const OFFSETS = [600, 300, 60, 0];
export const DAY = 86400000;
const KST = 9 * 3600000;

// 새 기기의 알림 기본 선택을 만듭니다.
export function defaultPreferences() {
  return { bosses: [], offsets: [300, 0], invasion: [] };
}

// 회차 보정은 마지막 관측으로 합치고 연속 회차만 학습합니다.
export function estimate(boss) {
  const cycles = new Map();
  for (const observation of boss.observations.filter(item => !item.source?.startsWith('admin-'))) {
    cycles.set(observation.cycleId, observation);
  }
  const samples = [...cycles.values()].sort((a, b) => Date.parse(a.spawnAt) - Date.parse(b.spawnAt));
  const base = boss.respawnHours * 3600000;
  const intervals = [];
  for (let i = 1; i < samples.length; i++) {
    const delta = Date.parse(samples[i].spawnAt) - Date.parse(samples[i - 1].spawnAt);
    if (samples[i].consecutiveFrom === samples[i - 1].cycleId && delta >= base && delta < base * 1.5) {
      intervals.push(delta);
    }
  }
  const recent = intervals.slice(-10).sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);
  const interval = recent.length ? (recent[mid] + recent[Math.ceil(recent.length / 2) - 1]) / 2 : base;
  return { latest: boss.observations.at(-1), interval, sampleCount: recent.length };
}

// 예정 시각이 지나면 처치된 것으로 가정하고 현재 이후 회차를 계산합니다.
export function bossTiming(boss, now = Date.now()) {
  const learned = estimate(boss);
  const observedAt = Date.parse(learned.latest.spawnAt);
  const index = now < observedAt ? 0 : Math.floor((now - observedAt) / learned.interval) + 1;
  return { ...learned, at: observedAt + index * learned.interval, kind: index ? 'predicted' : 'observed', index };
}

// 기기 시간대와 무관하게 한국시간 날짜와 시각을 표시합니다.
export function koreanTime(time, withDate = false) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {})
  }).format(time);
}

// 기기 현재 시각과의 차이를 분 단위로 표시합니다.
export function remaining(at, now = Date.now()) {
  if (at === null) return '새 관측 대기';
  const minutes = Math.max(0, Math.ceil((at - now) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
}

// 한국시간 자정부터 지정 일수의 침공 정각 일정을 만듭니다.
export function invasionTimes(now, days = 3) {
  const midnight = Math.floor((now + KST) / DAY) * DAY - KST;
  return Array.from({ length: days }, (_, day) => HOURS.map(hour => ({
    hour, at: midnight + day * DAY + hour * 3600000,
    key: `${new Date(midnight + KST + day * DAY).toISOString().slice(0, 10)}-${hour}`
  }))).flat();
}

// 반복 회차의 3일치 미래 알림을 만들며 침공은 정각만 예약합니다.
export function plannedEvents(catalog, preferences, now) {
  const events = [];
  for (const boss of catalog.bosses) {
    if (!preferences.bosses.includes(boss.id)) continue;
    const { latest, interval, sampleCount } = estimate(boss);
    const observedAt = Date.parse(latest.spawnAt);
    const first = Math.max(0, Math.floor((now - observedAt) / interval));
    for (let index = first; observedAt + index * interval <= now + 3 * DAY; index++) {
      const at = observedAt + index * interval;
      for (const offset of preferences.offsets) {
        const dueAt = at - offset * 1000;
        if (dueAt <= now) continue;
        const qualifier = index ? `${index === 1 ? '다음 회차' : '반복'} 추정` : '관측 기준 예정';
        events.push({
          key: `${boss.id}:${latest.cycleId}:${index}:${offset}`,
          dueAt, expiresAt: Math.min(dueAt + 120000, offset ? at : dueAt + 120000),
          title: `${boss.name} · ${offset ? `${offset / 60}분 전` : '예정 시각'}`,
          body: `${koreanTime(at)} 한국시간 · ${qualifier}${index && sampleCount < 2 ? ' / 보정자료 부족' : ''}`
        });
      }
    }
  }
  for (const event of invasionTimes(now)) {
    if (!preferences.invasion.includes(event.hour) || event.at <= now) continue;
    events.push({
      key: `invasion:${event.key}`, dueAt: event.at, expiresAt: event.at + 120000,
      title: `침공 보스 · ${String(event.hour).padStart(2, '0')}시`, body: '침공 보스 출현 시각입니다. (한국시간)'
    });
  }
  return events.sort((a, b) => a.dueAt - b.dueAt);
}

// 정렬 방식에 따라 레벨·다음 출현 시각·저장된 순서를 적용합니다.
export function orderedBosses(bosses, order = [], sort = 'custom', now = Date.now()) {
  const ranked = [...bosses].sort((a, b) => b.level - a.level);
  if (sort === 'level-desc') return ranked;
  if (sort === 'level-asc') return [...bosses].sort((a, b) => a.level - b.level);
  if (sort === 'time-asc' || sort === 'time-desc') {
    const times = new Map(bosses.map(boss => [boss.id, bossTiming(boss, now).at]));
    return ranked.sort((a, b) => {
      const left = times.get(a.id);
      const right = times.get(b.id);
      return (left - right) * (sort === 'time-asc' ? 1 : -1);
    });
  }
  const unique = [...new Set(order)].filter(id => ranked.some(boss => boss.id === id));
  return [...unique.map(id => ranked.find(boss => boss.id === id)), ...ranked.filter(boss => !unique.includes(boss.id))];
}
