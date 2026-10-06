import { db } from "./client";
import type { ModelAliasMode, ModelAliasRecord, ModelAliasTarget } from "../types";

interface AliasRow {
  id: number;
  alias: string;
  mode: string;
  client_effort_overrides: number;
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
    clientEffortOverrides: row.client_effort_overrides === 1,
    createdAt: row.created_at,
  };
}

function insertTargets(aliasId: number, targets: ModelAliasTarget[]): void {
  const insertTarget = db.query(
    "INSERT INTO model_alias_targets (alias_id, provider_id, model_id, variant, position) VALUES (?, ?, ?, ?, ?)"
  );
  targets.forEach((t, position) => insertTarget.run(aliasId, t.providerID, t.modelID, t.variant, position));
}

export function createAlias(
  alias: string,
  mode: ModelAliasMode,
  targets: ModelAliasTarget[],
  options: { clientEffortOverrides?: boolean } = {}
): ModelAliasRecord {
  if (targets.length === 0) throw new Error("An alias needs at least one target model");
  const clientEffortOverrides = options.clientEffortOverrides ?? false;

  return db.transaction(() => {
    const row = db
      .query<AliasRow, [string, string, number]>(
        "INSERT INTO model_aliases (alias, mode, client_effort_overrides) VALUES (?, ?, ?) RETURNING *"
      )
      .get(alias, mode, clientEffortOverrides ? 1 : 0);
    if (!row) throw new Error("Failed to create model alias");
    insertTargets(row.id, targets);
    return { id: row.id, alias: row.alias, mode, targets, clientEffortOverrides, createdAt: row.created_at };
  })();
}

/** Replaces an alias's name, mode, options and targets. Throws on a duplicate name or no targets; false when the id is unknown. */
export function updateAlias(
  id: number,
  alias: string,
  mode: ModelAliasMode,
  targets: ModelAliasTarget[],
  options: { clientEffortOverrides?: boolean } = {}
): boolean {
  if (targets.length === 0) throw new Error("An alias needs at least one target model");
  return db.transaction(() => {
    const result = db
      .query("UPDATE model_aliases SET alias = ?, mode = ?, client_effort_overrides = ? WHERE id = ?")
      .run(alias, mode, options.clientEffortOverrides ? 1 : 0, id);
    if (result.changes === 0) return false;
    db.query("DELETE FROM model_alias_targets WHERE alias_id = ?").run(id);
    insertTargets(id, targets);
    return true;
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
