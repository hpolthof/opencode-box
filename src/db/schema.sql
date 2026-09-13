CREATE TABLE IF NOT EXISTS api_keys (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  key_prefix     TEXT NOT NULL,
  key_hash       TEXT NOT NULL UNIQUE,
  allowed_models TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at     TEXT,
  last_used_at   TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id        INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  app_name          TEXT NOT NULL,
  model             TEXT NOT NULL,
  variant           TEXT,
  stream            INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  http_status       INTEGER NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  latency_ms        INTEGER NOT NULL,
  error_message     TEXT,
  request_body      TEXT,
  response_body     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_api_key_id ON requests(api_key_id);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);

-- Small key/value store for admin-configurable settings (e.g. log retention)
-- that need to survive restarts but don't warrant their own table/env var.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
