import { db } from "./client";
import type { ModelAliasMode, ModelAliasRecord, ModelAliasTarget } from "../types";

interface AliasRow {
  id: number;
  alias: string;
  mode: string;
  created_at: string;
}

interface TargetRow {
  id: number;
  alias_id: number;
  provider_id: string;
  model_id: string;
  variant: string;
  position: number;
}

function loadTargets(aliasId: number): ModelAliasTarget[] {
  const rows = db
    .query<TargetRow, [number]>("SELECT * FROM model_alias_targets WHERE alias_id = ? ORDER BY position ASC")
    .all(aliasId);
  return rows.map((r) => ({ providerID: r.provider_id, modelID: r.model_id, variant: r.variant }));
}

function rowToRecord(row: AliasRow): ModelAliasRecord {
  return {
    id: row.id,
    alias: row.alias,
    mode: row.mode as ModelAliasMode,
    targets: loadTargets(row.id),
    createdAt: row.created_at,
  };
}

function insertTargets(aliasId: number, targets: ModelAliasTarget[]): void {
  const insertTarget = db.query(
    "INSERT INTO model_alias_targets (alias_id, provider_id, model_id, variant, position) VALUES (?, ?, ?, ?, ?)"
  );
  targets.forEach((t, position) => insertTarget.run(aliasId, t.providerID, t.modelID, t.variant, position));
}

export function createAlias(alias: string, mode: ModelAliasMode, targets: ModelAliasTarget[]): ModelAliasRecord {
  if (targets.length === 0) throw new Error("An alias needs at least one target model");

  return db.transaction(() => {
    const row = db
      .query<AliasRow, [string, string]>("INSERT INTO model_aliases (alias, mode) VALUES (?, ?) RETURNING *")
      .get(alias, mode);
    if (!row) throw new Error("Failed to create model alias");
    insertTargets(row.id, targets);
    return { id: row.id, alias: row.alias, mode, targets, createdAt: row.created_at };
  })();
}

export function listAliases(): ModelAliasRecord[] {
  const rows = db.query<AliasRow, []>("SELECT * FROM model_aliases ORDER BY alias ASC").all();
  return rows.map(rowToRecord);
}

export function findAliasByName(alias: string): ModelAliasRecord | null {
  const row = db.query<AliasRow, [string]>("SELECT * FROM model_aliases WHERE alias = ?").get(alias);
  return row ? rowToRecord(row) : null;
}

export function deleteAlias(id: number): void {
  // model_alias_targets rows cascade via their ON DELETE CASCADE foreign key.
  db.query("DELETE FROM model_aliases WHERE id = ?").run(id);
}
