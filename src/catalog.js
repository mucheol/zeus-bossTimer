import original from '../public/data/catalog.json' with { type: 'json' };

// 파일 관측보다 최신인 관리자 수정값을 공통 자료에 합칩니다.
export async function loadCatalog(env) {
  const { results } = await env.DB.prepare('SELECT * FROM boss_updates WHERE id IN (SELECT MAX(id) FROM boss_updates GROUP BY boss_id)').all();
  const catalog = structuredClone(original);
  const applied = [];
  for (const update of results) {
    const boss = catalog.bosses.find(item => item.id === update.boss_id);
    if (!boss || update.recorded_at < Date.parse(boss.observations.at(-1).capturedAt)) continue;
    boss.observations.push({
      source: `admin-${update.id}`, cycleId: `admin-${update.id}`, capturedAt: new Date(update.recorded_at).toISOString(),
      spawnAt: new Date(update.spawn_at).toISOString(), precisionSeconds: 60
    });
    applied.push(update);
  }
  if (applied.length) {
    catalog.revision += `:admin-${Math.max(...applied.map(update => update.id))}`;
    const latest = applied.reduce((left, right) => left.recorded_at > right.recorded_at ? left : right);
    if (latest.recorded_at >= Date.parse(catalog.capturedAt)) {
      catalog.capturedAt = new Date(latest.recorded_at).toISOString();
      catalog.capturedSecondsKnown = true;
      catalog.source = 'admin';
    }
  }
  return catalog;
}
