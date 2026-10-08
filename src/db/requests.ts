import { db } from "./client";
import type { RequestLogEntry, RequestLogRow } from "../types";

const MAX_BODY_LEN = 1_000_000;

function truncate(value: string | null): string | null {
  if (value == null) return null;
  return value.length > MAX_BODY_LEN ? value.slice(0, MAX_BODY_LEN) + "...[truncated]" : value;
}

interface RequestRow {
  id: number;
  api_key_id: number | null;
  app_name: string;
  model: string;
  variant: string | null;
  alias: string | null;
  notes: string | null;
  stream: number;
  status: string;
  http_status: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  latency_ms: number;
  error_message: string | null;
  request_body: string | null;
  response_body: string | null;
  created_at: string;
}

function rowToEntry(row: RequestRow): RequestLogRow {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    appName: row.app_name,
    model: row.model,
    variant: row.variant,
    alias: row.alias,
    notes: row.notes,
    stream: Boolean(row.stream),
    status: row.status as "ok" | "error",
    httpStatus: row.http_status,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    latencyMs: row.latency_ms,
    errorMessage: row.error_message,
    requestBody: row.request_body,
    responseBody: row.response_body,
    createdAt: row.created_at,
  };
}

export function insertRequestLog(entry: RequestLogEntry): void {
  db.query(
    `INSERT INTO requests (
       api_key_id, app_name, model, variant, alias, notes, stream, status, http_status,
       prompt_tokens, completion_tokens, total_tokens,
       reasoning_tokens, cache_read_tokens, cache_write_tokens, latency_ms,
       error_message, request_body, response_body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.apiKeyId,
    entry.appName,
    entry.model,
    entry.variant,
    entry.alias ?? null,
    entry.notes ?? null,
    entry.stream ? 1 : 0,
    entry.status,
    entry.httpStatus,
    entry.promptTokens,
    entry.completionTokens,
    entry.totalTokens,
    entry.reasoningTokens,
    entry.cacheReadTokens,
    entry.cacheWriteTokens,
    entry.latencyMs,
    entry.errorMessage,
    truncate(entry.requestBody),
    truncate(entry.responseBody)
  );
}

export interface RequestFilters {
  model?: string;
  appName?: string;
  status?: "ok" | "error";
  page?: number;
  pageSize?: number;
}

export type RequestLogDetails = Omit<RequestLogRow, "requestBody" | "responseBody"> & {
  requestBodyAvailable: boolean;
  responseBodyAvailable: boolean;
};

// Keep bodies out of metadata queries: individual bodies can be up to 1 MB.
const DETAILS_COLUMNS = `id, api_key_id, app_name, model, variant, alias, notes,
  stream, status, http_status, prompt_tokens, completion_tokens, total_tokens,
  reasoning_tokens, cache_read_tokens, cache_write_tokens, latency_ms,
  error_message, created_at, NULL AS request_body, NULL AS response_body,
  request_body IS NOT NULL AS request_body_available,
  response_body IS NOT NULL AS response_body_available`;

type DetailsRow = RequestRow & { request_body_available: number; response_body_available: number };

function rowToDetails(row: DetailsRow): RequestLogDetails {
  const { requestBody, responseBody, ...details } = rowToEntry(row);
  return {
    ...details,
    requestBodyAvailable: Boolean(row.request_body_available),
    responseBodyAvailable: Boolean(row.response_body_available),
  };
}

/** Key ownership is mandatory and separate from client-controlled filters. */
export function queryRequestsForKey(apiKeyId: number, filters: RequestFilters & { from?: string; to?: string } = {}): {
  rows: RequestLogDetails[];
  total: number;
} {
  const pageSize = filters.pageSize ?? 50;
  const page = filters.page ?? 1;
  const conditions = ["api_key_id = ?"];
  const params: (string | number)[] = [apiKeyId];
  for (const [column, value] of [
    ["model", filters.model], ["app_name", filters.appName], ["status", filters.status],
  ] as const) {
    if (value !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (filters.from !== undefined) {
    conditions.push("created_at >= ?");
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    conditions.push("created_at <= ?");
    params.push(filters.to);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const rows = db.query<DetailsRow, (string | number)[]>(
    `SELECT ${DETAILS_COLUMNS} FROM requests ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  const total = db.query<{ count: number }, (string | number)[]>(
    `SELECT COUNT(*) AS count FROM requests ${where}`
  ).get(...params)?.count ?? 0;
  return { rows: rows.map(rowToDetails), total };
}

export function getRequestDetailsForKey(apiKeyId: number, requestId: number): RequestLogDetails | null {
  const row = db.query<DetailsRow, [number, number]>(
    `SELECT ${DETAILS_COLUMNS} FROM requests WHERE api_key_id = ? AND id = ?`
  ).get(apiKeyId, requestId);
  return row ? rowToDetails(row) : null;
}

export function getRequestBodiesForKey(apiKeyId: number, requestId: number): {
  id: number;
  requestBody: string | null;
  responseBody: string | null;
} | null {
  return db.query<{ id: number; requestBody: string | null; responseBody: string | null }, [number, number]>(
    `SELECT id, request_body AS requestBody, response_body AS responseBody
     FROM requests WHERE api_key_id = ? AND id = ?`
  ).get(apiKeyId, requestId);
}

export function queryRequests(filters: RequestFilters = {}): { rows: RequestLogRow[]; total: number } {
  const pageSize = filters.pageSize ?? 50;
  const page = filters.page ?? 1;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.model) {
    conditions.push("model = ?");
    params.push(filters.model);
  }
  if (filters.appName) {
    conditions.push("app_name = ?");
    params.push(filters.appName);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .query<RequestRow, (string | number)[]>(
      `SELECT * FROM requests ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  const totalRow = db
    .query<{ count: number }, (string | number)[]>(`SELECT COUNT(*) as count FROM requests ${whereClause}`)
    .get(...params);

  return { rows: rows.map(rowToEntry), total: totalRow?.count ?? 0 };
}

export interface ModelUsage {
  model: string;
  count: number;
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface AppUsage {
  appName: string;
  count: number;
}

export function usageByModel(sinceToday = false): ModelUsage[] {
  const whereClause = sinceToday ? "WHERE created_at >= date('now')" : "";
  return db
    .query<ModelUsage, []>(
      `SELECT model, COUNT(*) as count, SUM(total_tokens) as totalTokens,
              SUM(prompt_tokens) as promptTokens, SUM(completion_tokens) as completionTokens,
              SUM(reasoning_tokens) as reasoningTokens, SUM(cache_read_tokens) as cacheReadTokens,
              SUM(cache_write_tokens) as cacheWriteTokens
       FROM requests ${whereClause} GROUP BY model ORDER BY count DESC`
    )
    .all();
}

export function usageByApp(sinceToday = false): AppUsage[] {
  const whereClause = sinceToday ? "WHERE created_at >= date('now')" : "";
  return db
    .query<{ appName: string; count: number }, []>(
      `SELECT app_name as appName, COUNT(*) as count FROM requests ${whereClause} GROUP BY app_name ORDER BY count DESC`
    )
    .all();
}

export function countAllRequests(): number {
  const row = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM requests").get();
  return row?.n ?? 0;
}

export function oldestRequestDate(): string | null {
  const row = db.query<{ createdAt: string }, []>("SELECT created_at as createdAt FROM requests ORDER BY created_at ASC LIMIT 1").get();
  return row?.createdAt ?? null;
}

export function countRequestsOlderThan(days: number): number {
  const row = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) as n FROM requests WHERE created_at < datetime('now', ?)`)
    .get(`-${days} days`);
  return row?.n ?? 0;
}

/** Deletes request log rows older than `days`. Returns the number of rows deleted. */
export function purgeRequestsOlderThan(days: number): number {
  const count = countRequestsOlderThan(days);
  if (count > 0) {
    db.query(`DELETE FROM requests WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
  }
  return count;
}

/** Deletes every request log row. Returns the number of rows deleted. */
export function purgeAllRequests(): number {
  const count = countAllRequests();
  if (count > 0) {
    db.exec("DELETE FROM requests");
  }
  return count;
}

const HAS_BODY_CLAUSE = "(request_body IS NOT NULL OR response_body IS NOT NULL)";

export function countRequestsWithBodiesOlderThan(days: number): number {
  const row = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) as n FROM requests WHERE created_at < datetime('now', ?) AND ${HAS_BODY_CLAUSE}`)
    .get(`-${days} days`);
  return row?.n ?? 0;
}

/**
 * "Soft" purge: clears the (heavy) request/response body columns on rows
 * older than `days` but keeps the row itself, so dashboard stats (token
 * counts, latency, model/app usage) stay accurate forever. Returns the
 * number of rows affected.
 */
export function softPurgeRequestsOlderThan(days: number): number {
  const count = countRequestsWithBodiesOlderThan(days);
  if (count > 0) {
    db.query(`UPDATE requests SET request_body = NULL, response_body = NULL WHERE created_at < datetime('now', ?) AND ${HAS_BODY_CLAUSE}`).run(
      `-${days} days`
    );
  }
  return count;
}

/** Soft purge (see {@link softPurgeRequestsOlderThan}) applied to every row, regardless of age. */
export function softPurgeAllRequests(): number {
  const row = db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM requests WHERE ${HAS_BODY_CLAUSE}`).get();
  const count = row?.n ?? 0;
  if (count > 0) {
    db.exec(`UPDATE requests SET request_body = NULL, response_body = NULL WHERE ${HAS_BODY_CLAUSE}`);
  }
  return count;
}

/** Renders the full request log as CSV (RFC 4198-ish: quote-on-demand, doubled quotes). */
export function exportRequestsCsv(): string {
  const columns = [
    "id",
    "created_at",
    "api_key_id",
    "app_name",
    "model",
    "variant",
    "alias",
    "notes",
    "stream",
    "status",
    "http_status",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "latency_ms",
    "error_message",
  ] as const;

  const escape = (value: unknown): string => {
    if (value == null) return "";
    const str = String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const rows = db.query<Record<(typeof columns)[number], unknown>, []>(`SELECT ${columns.join(", ")} FROM requests ORDER BY created_at ASC`).all();

  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => escape(row[col])).join(","));
  }
  return lines.join("\n");
}

export function totals(): { requestsToday: number; requestsTotal: number; tokensToday: number; tokensTotal: number } {
  const today = db
    .query<{ n: number; tok: number | null }, []>(
      `SELECT COUNT(*) as n, SUM(total_tokens) as tok FROM requests WHERE created_at >= date('now')`
    )
    .get();
  const all = db.query<{ n: number; tok: number | null }, []>(`SELECT COUNT(*) as n, SUM(total_tokens) as tok FROM requests`).get();
  return {
    requestsToday: today?.n ?? 0,
    requestsTotal: all?.n ?? 0,
    tokensToday: today?.tok ?? 0,
    tokensTotal: all?.tok ?? 0,
  };
}
