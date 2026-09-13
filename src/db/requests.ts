import { db } from "./client";
import type { RequestLogEntry, RequestLogRow } from "../types";

const MAX_BODY_LEN = 8192;

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
  stream: number;
  status: string;
  http_status: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
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
    stream: Boolean(row.stream),
    status: row.status as "ok" | "error",
    httpStatus: row.http_status,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
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
       api_key_id, app_name, model, variant, stream, status, http_status,
       prompt_tokens, completion_tokens, total_tokens, latency_ms,
       error_message, request_body, response_body
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.apiKeyId,
    entry.appName,
    entry.model,
    entry.variant,
    entry.stream ? 1 : 0,
    entry.status,
    entry.httpStatus,
    entry.promptTokens,
    entry.completionTokens,
    entry.totalTokens,
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
}

export interface AppUsage {
  appName: string;
  count: number;
}

export function usageByModel(sinceToday = false): ModelUsage[] {
  const whereClause = sinceToday ? "WHERE created_at >= date('now')" : "";
  return db
    .query<{ model: string; count: number; totalTokens: number | null }, []>(
      `SELECT model, COUNT(*) as count, SUM(total_tokens) as totalTokens
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
