import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import catalog from '../public/data/catalog.json' with { type: 'json' };

// 관측 데이터의 날짜·회차·초상화 필수값을 검사합니다.
function checkData() {
  assert.equal(new Set(catalog.bosses.map(boss => boss.id)).size, catalog.bosses.length, '보스 ID가 중복됩니다.');
  assert.ok(catalog.revision && Number.isFinite(Date.parse(catalog.capturedAt)));
  for (const boss of catalog.bosses) {
    assert.match(boss.id, /^[a-z0-9-]+$/);
    assert.ok(boss.name && boss.region && Number.isInteger(boss.level) && boss.level > 0);
    assert.ok(boss.respawnHours > 0 && boss.respawnHours <= 48);
    assert.ok(boss.portrait.length === 2 && boss.portrait.every(Number.isFinite));
    assert.ok(boss.observations.length);
    const cycles = new Set();
    let previousCapture = 0;
    for (const observation of boss.observations) {
      assert.ok(observation.source && observation.cycleId);
      const captured = Date.parse(observation.capturedAt);
      const spawn = Date.parse(observation.spawnAt);
      assert.ok(Number.isFinite(captured) && Number.isFinite(spawn) && spawn > captured);
      assert.ok(captured >= previousCapture, '관측은 촬영 순서로 추가해야 합니다.');
      assert.ok(Number.isFinite(observation.precisionSeconds) && observation.precisionSeconds > 0);
      if (observation.consecutiveFrom) {
        assert.ok(cycles.has(observation.consecutiveFrom) && observation.consecutiveFrom !== observation.cycleId);
      }
      previousCapture = captured;
      cycles.add(observation.cycleId);
    }
  }
}

// 배포 파일 내용이 달라질 때 서비스 워커 캐시 버전도 바꿉니다.
function versionWorker() {
  const hash = createHash('sha256');
  const files = readdirSync('public', { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== 'sw.js')
    .map(entry => `${entry.parentPath}/${entry.name}`).sort();
  for (const path of files) hash.update(readFileSync(path));
  const path = 'public/sw.js';
  const source = readFileSync(path, 'utf8').replace(/const VERSION = '[^']+';/, `const VERSION = 'zeus-${hash.digest('hex').slice(0, 16)}';`);
  writeFileSync(path, source);
}

checkData();
versionWorker();
console.log(`공통 데이터 ${catalog.bosses.length}마리 검증 및 캐시 버전 갱신 완료.`);
