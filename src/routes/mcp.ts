import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { apiKeyAuth, getApiKey, type ApiKeyAuthEnv } from "../auth/apiKeyAuth";
import { getRequestBodiesForKey, getRequestDetailsForKey, queryRequestsForKey } from "../db/requests";
import { version } from "../../package.json";

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const requestIdSchema = z.object({ requestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}

function notFound() {
  // A foreign ID and a nonexistent ID must be indistinguishable.
  return { isError: true, content: [{ type: "text" as const, text: "Request not found." }] };
}

function createServer(apiKeyId: number) {
  const server = new McpServer({ name: "opencode-box-request-logs", version });

  server.registerTool("list_requests", {
    description: "List your API key's recorded requests, newest first, optionally between two timestamps (inclusive). Returns all stored metadata and body availability, without bodies. Model, appName and status filters match exactly.",
    inputSchema: z.object({
      model: z.string().min(1).optional(),
      appName: z.string().min(1).optional(),
      status: z.enum(["ok", "error"]).optional(),
      from: z.iso.datetime({ offset: true }).optional().describe("Inclusive start time in ISO 8601 with Z or a timezone offset, e.g. 2026-10-08T10:00:00+02:00."),
      to: z.iso.datetime({ offset: true }).optional().describe("Inclusive end time in ISO 8601 with Z or a timezone offset."),
      page: z.number().int().min(1).max(1_000_000).default(1),
      pageSize: z.number().int().min(1).max(100).default(50),
    }).strict().refine((filters) => !filters.from || !filters.to || Date.parse(filters.from) <= Date.parse(filters.to), {
      message: "from must be earlier than or equal to to", path: ["to"],
    }),
    annotations,
  }, async (filters) => {
    const { rows, total } = queryRequestsForKey(apiKeyId, {
      ...filters,
      from: filters.from ? new Date(filters.from).toISOString() : undefined,
      to: filters.to ? new Date(filters.to).toISOString() : undefined,
    });
    return result({ requests: rows, total, page: filters.page, pageSize: filters.pageSize,
      hasMore: filters.page * filters.pageSize < total });
  });

  server.registerTool("get_request", {
    description: "Get all stored metadata for one of your requests: model, reasoning, alias, notes, status, tokens, latency, errors, timestamp and body availability. Use get_request_bodies for its payloads.",
    inputSchema: requestIdSchema,
    annotations,
  }, async ({ requestId }) => {
    const details = getRequestDetailsForKey(apiKeyId, requestId);
    return details ? result(details) : notFound();
  });

  server.registerTool("get_request_bodies", {
    description: "Get a request's stored requestBody and responseBody as raw strings. A body is null if unavailable or purged. Stored bodies may be truncated; streaming responses use the gateway's logged response representation.",
    inputSchema: requestIdSchema,
    annotations,
  }, async ({ requestId }) => {
    const bodies = getRequestBodiesForKey(apiKeyId, requestId);
    return bodies ? result(bodies) : notFound();
  });

  return server;
}

export const mcpRouter = new Hono<ApiKeyAuthEnv>();
mcpRouter.use("*", async (c, next) => {
  // Native MCP clients omit Origin. Browser requests must come from this origin.
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "Invalid Origin" }, 403);
  await next();
  c.header("Cache-Control", "no-store");
});
mcpRouter.use("*", apiKeyAuth);

mcpRouter.post("/", async (c) => {
  // No shared sessions: each HTTP request gets its own server bound to the key
  // authenticated on that request, including after revocation or a key change.
  const server = createServer(getApiKey(c).id);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } finally {
    await server.close();
  }
});

// Stateless JSON transport has no standalone SSE stream or session to delete.
mcpRouter.all("/", (c) => {
  c.header("Allow", "POST");
  return c.json({ error: "Method not allowed" }, 405);
});
