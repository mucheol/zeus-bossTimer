CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  subscription TEXT NOT NULL,
  preferences TEXT NOT NULL,
  revision TEXT NOT NULL,
  planned_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  test_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX jobs_due ON jobs(state, due_at, lease_until);
CREATE INDEX jobs_device ON jobs(device_id);
CREATE INDEX devices_plan ON devices(revision, planned_until);
