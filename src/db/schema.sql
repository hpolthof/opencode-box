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

-- Client-selectable "virtual" models that route to one or more real
-- provider/model+variant targets, so a client can pick e.g. "gpt-xhigh" as
-- `model` without needing to know about variants (or, with multiple
-- targets, load-balancing/failover) at all. `mode` picks how the targets in
-- model_alias_targets are tried on each request: "priority" (in `position`
-- order, falling over to the next on error/timeout) or "random" (a random
-- order each time, still falling over through the rest of that order).
CREATE TABLE IF NOT EXISTS model_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  alias       TEXT NOT NULL UNIQUE,
  mode        TEXT NOT NULL DEFAULT 'priority',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS model_alias_targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_id    INTEGER NOT NULL REFERENCES model_aliases(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  variant     TEXT NOT NULL,
  position    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_alias_targets_alias_id ON model_alias_targets(alias_id);
