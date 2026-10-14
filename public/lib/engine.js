export const HOURS = [0, 12, 18];
export const OFFSETS = [60, 180, 300];
export const DAY = 86400000;
const KST = 9 * 3600000;

// 새 기기의 알림 기본 선택을 만듭니다.
export function defaultPreferences() {
  return { enabled: true, bosses: [], offsets: [300], invasion: [] };
}

// 기존 알림 선택을 새 시점과 전체 알림 상태로 이관합니다.
export function normalizePreferences(value, bossIds) {
  const defaults = defaultPreferences();
  const offsets = Array.isArray(value?.offsets) ? [...new Set(value.offsets.filter(item => OFFSETS.includes(item)))] : defaults.offsets;
  if (!offsets.length && value?.offsets?.some(item => item === 0 || item === 600)) offsets.push(300);
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : true,
    bosses: Array.isArray(value?.bosses) ? [...new Set(value.bosses.filter(item => !bossIds || bossIds.includes(item)))] : [],
    offsets,
    invasion: Array.isArray(value?.invasion) ? [...new Set(value.invasion.filter(item => HOURS.includes(item)))] : []
  };
}

// 처치시간 보정은 0초로 고정하며 관측 자료로 학습하지 않습니다.
export const KILL_SECONDS = 0;

// 고정 리스폰 간격과 최신 관측을 반환합니다. 처치시간은 항상 0초입니다.
export function estimate(boss) {
  return { latest: boss.observations.at(-1), interval: boss.respawnHours * 3600000 + KILL_SECONDS * 1000, killSeconds: KILL_SECONDS, sampleCount: 0, manualSampleCount: 0 };
}

// 예정 시각이 지나면 처치된 것으로 가정하고 현재 이후 회차를 계산합니다.
export function bossTiming(boss, now = Date.now()) {
  const learned = estimate(boss);
  const observedAt = Date.parse(learned.latest.spawnAt);
  let index = now < observedAt ? 0 : Math.floor((now - observedAt) / learned.interval) + 1;
  if (observedAt + index * learned.interval <= now) index++;
  return { ...learned, at: observedAt + index * learned.interval, kind: index ? 'predicted' : 'observed', index };
}

// 기기 시간대와 무관하게 한국시간 날짜와 시각을 표시합니다.
export function koreanTime(time, withDate = false, withSeconds = false) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
    ...(withSeconds ? { second: '2-digit' } : {})
  }).format(time);
}

// 기기 현재 시각과의 차이를 분 단위로 표시합니다.
export function remaining(at, now = Date.now()) {
  if (at === null) return '새 관측 대기';
  if (at > now && at - now < 60000) return '1분 미만';
  const minutes = Math.max(0, Math.floor((at - now) / 60000));
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
  preferences = normalizePreferences(preferences, catalog.bosses.map(boss => boss.id));
  if (!preferences.enabled) return [];
  const events = [];
  for (const boss of catalog.bosses) {
    if (!preferences.bosses.includes(boss.id)) continue;
    const { latest, interval } = estimate(boss);
    const observedAt = Date.parse(latest.spawnAt);
    const first = Math.max(0, Math.floor((now - observedAt) / interval));
    for (let index = first; observedAt + index * interval <= now + 3 * DAY + Math.max(0, ...preferences.offsets) * 1000; index++) {
      const at = observedAt + index * interval;
      for (const offset of preferences.offsets) {
        const dueAt = at - offset * 1000;
        if (dueAt <= now || dueAt > now + 3 * DAY) continue;
        const qualifier = index ? `${index === 1 ? '다음 회차' : '반복'} 추정` : '관측 기준 예정';
        events.push({
          key: `${boss.id}:${latest.cycleId}:${index}:${offset}`,
          dueAt, expiresAt: Math.min(dueAt + 120000, offset ? at : dueAt + 120000),
          title: `${boss.name} · ${offset ? `${offset / 60}분 전` : '예정 시각'}`,
          body: `${koreanTime(at)} 한국시간 · ${qualifier}`
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
