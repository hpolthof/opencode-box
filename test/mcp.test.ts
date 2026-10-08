import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { app } from "../src/app";
import { createKey, revokeKey } from "../src/db/apiKeys";
import { db } from "../src/db/client";
import { insertRequestLog } from "../src/db/requests";
import type { RequestLogEntry } from "../src/types";
import type { RequestLogDetails } from "../src/db/requests";

type ToolData<Name extends string> = Name extends "get_request" ? RequestLogDetails
  : Name extends "get_request_bodies" ? { id: number; requestBody: string | null; responseBody: string | null }
  : { requests: RequestLogDetails[]; total: number; page: number; pageSize: number; hasMore: boolean };

type ToolResult<Name extends string> = {
  isError?: boolean;
  structuredContent: ToolData<Name>;
};

const owner = createKey("mcp-owner");
// Deliberately the same app name: ownership must use key ID, never app name.
const other = createKey("mcp-owner");
const revoked = createKey("mcp-revoked");
revokeKey(revoked.record.id);
const keyIds = [owner.record.id, other.record.id, revoked.record.id];
const requestIds: number[] = [];

function seed(apiKeyId: number | null, overrides: Partial<RequestLogEntry> = {}) {
  insertRequestLog({
    apiKeyId, appName: "mcp-owner", model: "openai/test", variant: "low", alias: "test-alias",
    notes: "failover", stream: false, status: "ok", httpStatus: 200,
    promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 5,
    cacheReadTokens: 2, cacheWriteTokens: 0, latencyMs: 123, errorMessage: null,
    requestBody: '{"input":"private prompt"}', responseBody: '{"output":"private answer"}',
    ...overrides,
  });
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id);
  requestIds.push(id);
  return id;
}

const ownId = seed(owner.record.id);
const emptyId = seed(owner.record.id, { model: "anthropic/test", status: "error", httpStatus: 502,
  errorMessage: "upstream failed", requestBody: null, responseBody: null });
const foreignId = seed(other.record.id, { requestBody: "foreign secret", responseBody: "foreign answer" });
const orphanId = seed(null);

afterAll(() => {
  for (const id of requestIds) db.query("DELETE FROM requests WHERE id = ?").run(id);
  for (const id of keyIds) db.query("DELETE FROM api_keys WHERE id = ?").run(id);
});

function rpc(key: string | null, method: string, params?: unknown, extraHeaders: Record<string, string> = {}) {
  return app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
}

async function call<Name extends string>(name: Name, args: Record<string, unknown> = {}, key = owner.rawKey) {
  const response = await rpc(key, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return ((await response.json()) as { result: ToolResult<Name> }).result;
}

describe("request log MCP", () => {
  test("requires a valid, active API key on all methods", async () => {
    for (const key of [null, "unknown", revoked.rawKey]) {
      expect((await rpc(key, "tools/list")).status).toBe(401);
    }
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      expect((await app.request("/mcp", { method })).status).toBe(401);
    }
  });

  test("works with the official Streamable HTTP client, including initialization and notifications", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${owner.rawKey}` } },
      fetch: (input, init) => Promise.resolve(app.fetch(new Request(input.toString(), init))),
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["get_request", "get_request_bodies", "list_requests"]);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
      const details = await client.callTool({ name: "get_request", arguments: { requestId: ownId } });
      expect(details.structuredContent).toMatchObject({ id: ownId });
      expect(transport.sessionId).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test("lists and counts only the caller's rows, without loading bodies", async () => {
    const { structuredContent: data } = await call("list_requests");
    expect(data.total).toBe(2);
    expect(data.requests.map((row: { id: number }) => row.id).sort()).toEqual([ownId, emptyId].sort());
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(50);
    expect(data.hasMore).toBe(false);
    expect(JSON.stringify(data)).not.toContain("private prompt");
    expect(JSON.stringify(data)).not.toContain("requestBody\"");
    const theirs = await call("list_requests", {}, other.rawKey);
    expect(theirs.structuredContent.total).toBe(1);
    expect(theirs.structuredContent.requests[0].id).toBe(foreignId);
  });

  test("filters and paginates with key-scoped totals", async () => {
    const first = (await call("list_requests", { pageSize: 1 })).structuredContent;
    const second = (await call("list_requests", { pageSize: 1, page: 2 })).structuredContent;
    expect(first.total).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(first.requests[0].id).not.toBe(second.requests[0].id);
    const filtered = (await call("list_requests", { model: "anthropic/test", status: "error", appName: "mcp-owner" })).structuredContent;
    expect(filtered.total).toBe(1);
    expect(filtered.requests[0].id).toBe(emptyId);
    expect((await call("list_requests", { model: "openai/test' OR 1=1 --" })).structuredContent.total).toBe(0);
  });

  test("returns all stored metadata separately from payloads", async () => {
    const details = (await call("get_request", { requestId: ownId })).structuredContent;
    expect(details).toMatchObject({ id: ownId, apiKeyId: owner.record.id, appName: "mcp-owner",
      model: "openai/test", variant: "low", alias: "test-alias", notes: "failover", stream: false,
      status: "ok", httpStatus: 200, promptTokens: 10, completionTokens: 20, totalTokens: 30,
      reasoningTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, latencyMs: 123, errorMessage: null,
      requestBodyAvailable: true, responseBodyAvailable: true });
    expect(typeof details.createdAt).toBe("string");
    expect(details).not.toHaveProperty("requestBody");
    expect(details).not.toHaveProperty("responseBody");
    expect((await call("get_request_bodies", { requestId: ownId })).structuredContent).toEqual({
      id: ownId, requestBody: '{"input":"private prompt"}', responseBody: '{"output":"private answer"}',
    });
  });

  test("foreign, orphaned and missing IDs return the same error for both retrieval tools", async () => {
    for (const name of ["get_request", "get_request_bodies"]) {
      const missing = await call(name, { requestId: Number.MAX_SAFE_INTEGER });
      expect(missing.isError).toBe(true);
      for (const requestId of [foreignId, orphanId]) expect(await call(name, { requestId })).toEqual(missing);
    }
  });

  test("missing or purged bodies are explicit nulls", async () => {
    expect((await call("get_request", { requestId: emptyId })).structuredContent).toMatchObject({
      requestBodyAvailable: false, responseBodyAvailable: false, errorMessage: "upstream failed",
    });
    expect((await call("get_request_bodies", { requestId: emptyId })).structuredContent).toEqual({
      id: emptyId, requestBody: null, responseBody: null,
    });
    const partialId = seed(owner.record.id, { responseBody: null });
    expect((await call("get_request_bodies", { requestId: partialId })).structuredContent.responseBody).toBeNull();
    db.query("UPDATE requests SET request_body = NULL, response_body = NULL WHERE id = ?").run(partialId);
    expect((await call("get_request", { requestId: partialId })).structuredContent.requestBodyAvailable).toBe(false);
  });

  test("rejects invalid arguments and ownership overrides", async () => {
    for (const args of [{ page: 0 }, { pageSize: 101 }, { pageSize: 1.5 }, { status: "pending" }, { apiKeyId: other.record.id }]) {
      expect((await call("list_requests", args)).isError).toBe(true);
    }
    for (const args of [{}, { requestId: -1 }, { requestId: "1" }, { requestId: ownId, apiKeyId: other.record.id }]) {
      expect((await call("get_request", args)).isError).toBe(true);
      expect((await call("get_request_bodies", args)).isError).toBe(true);
    }
  });

  test("validates Origin and refuses standalone streams and session deletion", async () => {
    expect((await rpc(owner.rawKey, "tools/list", undefined, { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await rpc(owner.rawKey, "tools/list", undefined, { Origin: "http://localhost" })).status).toBe(200);
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("/mcp", { method, headers: { Authorization: `Bearer ${owner.rawKey}` } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  test("SDK handles malformed JSON and unknown protocol methods", async () => {
    const invalid = await app.request("/mcp", { method: "POST", headers: {
      Authorization: `Bearer ${owner.rawKey}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }, body: "{invalid" });
    expect(invalid.status).toBe(400);
    const unknown = await rpc(owner.rawKey, "unknown/method");
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  test("revocation takes effect on the next call after initialization", async () => {
    const temporary = createKey("mcp-temporary");
    keyIds.push(temporary.record.id);
    const init = await rpc(temporary.rawKey, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    revokeKey(temporary.record.id);
    expect((await rpc(temporary.rawKey, "tools/call", { name: "get_request", arguments: { requestId: ownId } })).status).toBe(401);
  });

  test("lists between inclusive timestamps, normalizes offsets and scopes both rows and counts", async () => {
    const dated = createKey("mcp-dates");
    keyIds.push(dated.record.id);
    const ids = ["2026-10-08T07:59:59.999Z", "2026-10-08T08:00:00.000Z",
      "2026-10-08T09:00:00.000Z", "2026-10-08T10:00:00.000Z", "2026-10-08T10:00:00.001Z"].map((timestamp) => {
      const id = seed(dated.record.id);
      db.query("UPDATE requests SET created_at = ? WHERE id = ?").run(timestamp, id);
      return id;
    });
    const foreign = seed(other.record.id);
    db.query("UPDATE requests SET created_at = ? WHERE id = ?").run("2026-10-08T09:00:00.000Z", foreign);
    const range = { from: "2026-10-08T10:00:00+02:00", to: "2026-10-08T12:00:00+02:00" };
    const listed = (await call("list_requests", range, dated.rawKey)).structuredContent;
    expect(listed.total).toBe(3);
    expect(listed.requests.map((row: { id: number }) => row.id)).toEqual([ids[3], ids[2], ids[1]]);
    const paged = (await call("list_requests", { ...range, pageSize: 2 }, dated.rawKey)).structuredContent;
    expect(paged.total).toBe(3);
    expect(paged.hasMore).toBe(true);
    expect((await call("list_requests", { from: range.from }, dated.rawKey)).structuredContent.total).toBe(4);
    expect((await call("list_requests", { to: range.to }, dated.rawKey)).structuredContent.total).toBe(4);
    expect((await call("list_requests", { from: "2026-10-08T09:00:00Z", to: "2026-10-08T09:00:00Z" }, dated.rawKey)).structuredContent.total).toBe(1);
    for (const args of [
      { from: "yesterday" }, { to: "2026-10-08T12:00:00" }, { from: "2026-02-30T00:00:00Z" },
      { from: "2026-10-09T00:00:00Z", to: "2026-10-08T00:00:00Z" },
    ]) expect((await call("list_requests", args, dated.rawKey)).isError).toBe(true);
  });
});
