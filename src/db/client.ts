import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../config";

const schemaPath = new URL("./schema.sql", import.meta.url);
const schemaSql = await Bun.file(schemaPath).text();

mkdirSync(dirname(CONFIG.dbPath), { recursive: true });

export const db = new Database(CONFIG.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
// Without this, `requests.api_key_id`'s `ON DELETE SET NULL` (schema.sql) is
// inert - SQLite ignores declared foreign keys unless this is turned on -
// and purging a revoked API key would leave orphaned ids in `requests`.
db.exec("PRAGMA foreign_keys = ON;");

// Migration: `model_aliases` originally stored one target directly on the
// alias row (provider_id/model_id/variant columns). It's since moved to a
// separate model_alias_targets table supporting multiple targets per alias.
// `CREATE TABLE IF NOT EXISTS` below is a no-op against an existing table of
// the old shape, so the old table has to be moved out of the way first -
// its rows are carried over as single-target "priority" aliases once the
// new tables exist.
let legacyAliasRows: { id: number; alias: string; provider_id: string; model_id: string; variant: string; created_at: string }[] = [];
const existingAliasColumns = db.query<{ name: string }, []>("PRAGMA table_info(model_aliases)").all();
if (existingAliasColumns.some((c) => c.name === "provider_id")) {
  legacyAliasRows = db.query<(typeof legacyAliasRows)[number], []>("SELECT * FROM model_aliases").all();
  db.exec("DROP TABLE model_aliases");
}

db.exec(schemaSql);

if (legacyAliasRows.length > 0) {
  const insertAlias = db.query("INSERT INTO model_aliases (id, alias, mode, created_at) VALUES (?, ?, 'priority', ?)");
  const insertTarget = db.query(
    "INSERT INTO model_alias_targets (alias_id, provider_id, model_id, variant, position) VALUES (?, ?, ?, ?, 0)"
  );
  db.transaction(() => {
    for (const row of legacyAliasRows) {
      insertAlias.run(row.id, row.alias, row.created_at);
      insertTarget.run(row.id, row.provider_id, row.model_id, row.variant);
    }
  })();
}

// Lightweight migration: `CREATE TABLE IF NOT EXISTS` above never touches an
// already-existing `requests` table, so a column added after a database was
// first created (like `variant`) needs to be backfilled explicitly here.
const requestsColumns = db.query<{ name: string }, []>("PRAGMA table_info(requests)").all();
for (const column of ["variant TEXT", "reasoning_tokens INTEGER", "cache_read_tokens INTEGER", "cache_write_tokens INTEGER", "alias TEXT", "notes TEXT"]) {
  const name = column.split(" ")[0];
  if (!requestsColumns.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE requests ADD COLUMN ${column}`);
  }
}

// Same for `model_aliases.client_effort_overrides`: existing aliases get 0,
// i.e. they keep pinning their targets' reasoning levels.
const aliasColumns = db.query<{ name: string }, []>("PRAGMA table_info(model_aliases)").all();
if (!aliasColumns.some((c) => c.name === "client_effort_overrides")) {
  db.exec("ALTER TABLE model_aliases ADD COLUMN client_effort_overrides INTEGER NOT NULL DEFAULT 0");
}

// Migration: during the pi-ai proof of concept, pi-ai models were addressed
// as "pi/<provider>/<model>" next to OpenCode's "<provider>/<model>". With
// OpenCode gone they use the plain form, so strip the prefix from stored
// alias targets, key allow-lists and logged request models. Idempotent.
db.transaction(() => {
  db.exec("UPDATE model_alias_targets SET provider_id = substr(provider_id, 4) WHERE provider_id LIKE 'pi/%'");
  db.exec("UPDATE requests SET model = substr(model, 4) WHERE model LIKE 'pi/%'");
  const keys = db
    .query<{ id: number; allowed_models: string }, []>("SELECT id, allowed_models FROM api_keys WHERE allowed_models LIKE '%\"pi/%'")
    .all();
  const update = db.query("UPDATE api_keys SET allowed_models = ? WHERE id = ?");
  for (const key of keys) {
    const models = (JSON.parse(key.allowed_models) as string[]).map((m) => (m.startsWith("pi/") ? m.slice(3) : m));
    update.run(JSON.stringify([...new Set(models)]), key.id);
  }
})();
