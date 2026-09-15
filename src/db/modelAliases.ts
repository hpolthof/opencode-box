import { db } from "./client";
import type { ModelAliasRecord } from "../types";

interface ModelAliasRow {
  id: number;
  alias: string;
  provider_id: string;
  model_id: string;
  variant: string;
  created_at: string;
}

function rowToRecord(row: ModelAliasRow): ModelAliasRecord {
  return {
    id: row.id,
    alias: row.alias,
    providerID: row.provider_id,
    modelID: row.model_id,
    variant: row.variant,
    createdAt: row.created_at,
  };
}

export function createAlias(alias: string, providerID: string, modelID: string, variant: string): ModelAliasRecord {
  const row = db
    .query<ModelAliasRow, [string, string, string, string]>(
      `INSERT INTO model_aliases (alias, provider_id, model_id, variant) VALUES (?, ?, ?, ?) RETURNING *`
    )
    .get(alias, providerID, modelID, variant);
  if (!row) throw new Error("Failed to create model alias");
  return rowToRecord(row);
}

export function listAliases(): ModelAliasRecord[] {
  const rows = db.query<ModelAliasRow, []>("SELECT * FROM model_aliases ORDER BY alias ASC").all();
  return rows.map(rowToRecord);
}

export function findAliasByName(alias: string): ModelAliasRecord | null {
  const row = db.query<ModelAliasRow, [string]>("SELECT * FROM model_aliases WHERE alias = ?").get(alias);
  return row ? rowToRecord(row) : null;
}

export function deleteAlias(id: number): void {
  db.query("DELETE FROM model_aliases WHERE id = ?").run(id);
}
