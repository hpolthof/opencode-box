import { randomBytes, createHash } from "node:crypto";
import { db } from "./client";
import type { ApiKeyRecord } from "../types";

interface ApiKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  allowed_models: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    allowedModels: row.allowed_models ? JSON.parse(row.allowed_models) : null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Generates a new raw API key and persists only its hash. Returns the raw key once. */
export function createKey(name: string, allowedModels: string[] | null = null): { record: ApiKeyRecord; rawKey: string } {
  const rawKey = `sk-ob-${randomBytes(16).toString("base64url")}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);
  const allowedModelsJson = allowedModels ? JSON.stringify(allowedModels) : null;

  const row = db
    .query<ApiKeyRow, [string, string, string, string | null]>(
      `INSERT INTO api_keys (name, key_prefix, key_hash, allowed_models)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    .get(name, keyPrefix, keyHash, allowedModelsJson);

  if (!row) throw new Error("Failed to create API key");
  return { record: rowToRecord(row), rawKey };
}

export function findByHash(keyHash: string): ApiKeyRecord | null {
  const row = db.query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash);
  return row ? rowToRecord(row) : null;
}

export function listKeys(): ApiKeyRecord[] {
  const rows = db.query<ApiKeyRow, []>("SELECT * FROM api_keys ORDER BY created_at DESC").all();
  return rows.map(rowToRecord);
}

export function revokeKey(id: number): void {
  db.query("UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
}

export function updateAllowedModels(id: number, allowedModels: string[] | null): void {
  const allowedModelsJson = allowedModels && allowedModels.length > 0 ? JSON.stringify(allowedModels) : null;
  db.query("UPDATE api_keys SET allowed_models = ? WHERE id = ?").run(allowedModelsJson, id);
}

export function touchLastUsed(id: number): void {
  db.query("UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
}

export function countRevokedKeysOlderThan(days: number): number {
  const row = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) as n FROM api_keys WHERE revoked_at IS NOT NULL AND revoked_at < datetime('now', ?)`)
    .get(`-${days} days`);
  return row?.n ?? 0;
}

/** Deletes revoked keys older than `days`. Historic request log rows keep their own data; `api_key_id` is nulled out. */
export function purgeRevokedKeysOlderThan(days: number): number {
  const count = countRevokedKeysOlderThan(days);
  if (count > 0) {
    db.query(`DELETE FROM api_keys WHERE revoked_at IS NOT NULL AND revoked_at < datetime('now', ?)`).run(`-${days} days`);
  }
  return count;
}
