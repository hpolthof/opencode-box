import { db } from "./client";

/** A model of a custom endpoint; `levels` are its reasoning levels ("minimal".."max", without "none"), empty = no reasoning. */
export interface CustomModelSpec {
  id: string;
  levels: string[];
}

export interface CustomProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  models: CustomModelSpec[];
}

interface Row {
  id: string;
  name: string;
  base_url: string;
  api_key: string | null;
  models: string;
}

function fromRow(row: Row): CustomProviderRecord {
  return { id: row.id, name: row.name, baseUrl: row.base_url, apiKey: row.api_key, models: (JSON.parse(row.models) as (string | CustomModelSpec)[]).map((m) => (typeof m === "string" ? { id: m, levels: [] } : m)) };
}

export function listCustomProviders(): CustomProviderRecord[] {
  return db.query<Row, []>("SELECT id, name, base_url, api_key, models FROM custom_providers ORDER BY id").all().map(fromRow);
}

export function getCustomProvider(id: string): CustomProviderRecord | null {
  const row = db.query<Row, [string]>("SELECT id, name, base_url, api_key, models FROM custom_providers WHERE id = ?").get(id);
  return row ? fromRow(row) : null;
}

export function insertCustomProvider(p: CustomProviderRecord): void {
  db.query("INSERT INTO custom_providers (id, name, base_url, api_key, models) VALUES (?, ?, ?, ?, ?)").run(
    p.id,
    p.name,
    p.baseUrl,
    p.apiKey,
    JSON.stringify(p.models)
  );
}

export function updateCustomProvider(p: CustomProviderRecord): void {
  db.query("UPDATE custom_providers SET name = ?, base_url = ?, api_key = ?, models = ? WHERE id = ?").run(
    p.name,
    p.baseUrl,
    p.apiKey,
    JSON.stringify(p.models),
    p.id
  );
}

export function deleteCustomProvider(id: string): void {
  db.query("DELETE FROM custom_providers WHERE id = ?").run(id);
}
