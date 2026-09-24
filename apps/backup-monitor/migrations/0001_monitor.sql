CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  armed_at INTEGER NOT NULL,
  last_success INTEGER,
  reason TEXT,
  stage TEXT
);
CREATE TABLE runs (
  monitor TEXT NOT NULL REFERENCES monitors(id),
  id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed')),
  stage TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(monitor,id)
);
CREATE INDEX runs_by_time ON runs(monitor,started_at DESC);
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  monitor TEXT NOT NULL REFERENCES monitors(id),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  reason TEXT NOT NULL,
  stage TEXT
);
CREATE UNIQUE INDEX one_open_incident ON incidents(monitor) WHERE closed_at IS NULL;
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  incident TEXT NOT NULL REFERENCES incidents(id),
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  sent_at INTEGER,
  first_attempt INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pending_notifications ON notifications(sent_at,blocked,lease_until);
