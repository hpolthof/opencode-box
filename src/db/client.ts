import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../config";

const schemaPath = new URL("./schema.sql", import.meta.url);
const schemaSql = await Bun.file(schemaPath).text();

mkdirSync(dirname(CONFIG.dbPath), { recursive: true });

export const db = new Database(CONFIG.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(schemaSql);

// Lightweight migration: `CREATE TABLE IF NOT EXISTS` above never touches an
// already-existing `requests` table, so a column added after a database was
// first created (like `variant`) needs to be backfilled explicitly here.
const requestsColumns = db.query<{ name: string }, []>("PRAGMA table_info(requests)").all();
if (!requestsColumns.some((c) => c.name === "variant")) {
  db.exec("ALTER TABLE requests ADD COLUMN variant TEXT");
}
