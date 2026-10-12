CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE boss_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  boss_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  spawn_at INTEGER NOT NULL
);

CREATE INDEX boss_updates_latest ON boss_updates(boss_id, id);
