import original from '../public/data/catalog.json' with { type: 'json' };

// 모든 관리자 수정 이력을 원본 관측과 촬영 순서로 합칩니다.
export async function loadCatalog(env) {
  const { results } = await env.DB.prepare('SELECT * FROM boss_updates ORDER BY recorded_at,id').all();
  const catalog = structuredClone(original);
  const undone = new Set(results.filter(update => update.undo_of !== null && update.undo_of !== undefined).map(update => update.undo_of));
  for (const update of results) {
    if (update.undo_of != null || undone.has(update.id)) continue;
    const boss = catalog.bosses.find(item => item.id === update.boss_id);
    if (!boss) continue;
    boss.observations.push({
      source: `admin-${update.id}`, cycleId: `admin-${update.id}`, capturedAt: new Date(update.recorded_at).toISOString(),
      spawnAt: new Date(update.spawn_at).toISOString(), precisionSeconds: 60
    });
  }
  for (const boss of catalog.bosses) boss.observations.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  if (results.length) {
    catalog.revision += `:admin-${Math.max(...results.map(update => update.id))}`;
    const latest = results.at(-1);
    if (latest.recorded_at >= Date.parse(catalog.capturedAt)) {
      catalog.capturedAt = new Date(latest.recorded_at).toISOString();
      catalog.capturedSecondsKnown = true;
      catalog.source = 'admin';
    }
  }
  return catalog;
}
