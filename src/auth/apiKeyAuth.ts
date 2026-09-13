import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { findByHash, hashKey, touchLastUsed } from "../db/apiKeys";
import type { ApiKeyRecord } from "../types";
import { openAIError } from "../openai/types";

type ApiKeyAuthEnv = {
  Variables: {
    apiKey: ApiKeyRecord;
  };
};

function unauthorized(c: Context, message: string) {
  return c.json(openAIError(message, "invalid_request_error"), 401);
}

/**
 * Hono middleware enforcing `Authorization: Bearer <key>` auth for the
 * gateway's OpenAI-compatible routes. On success, attaches the matched
 * `ApiKeyRecord` to context under the `apiKey` variable (read it back with
 * `getApiKey(c)`).
 */
export const apiKeyAuth = createMiddleware<ApiKeyAuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return unauthorized(c, "Missing or malformed Authorization header. Expected: Bearer <api key>");
  }

  const rawKey = header.slice("Bearer ".length).trim();
  if (!rawKey) {
    return unauthorized(c, "Missing or malformed Authorization header. Expected: Bearer <api key>");
  }

  const record = findByHash(hashKey(rawKey));
  if (!record || record.revokedAt) {
    return unauthorized(c, "Invalid API key");
  }

  // Fire-and-forget - don't block the request on this write.
  Promise.resolve()
    .then(() => touchLastUsed(record.id))
    .catch((err) => console.error("[auth/apiKeyAuth] failed to touch last_used_at:", err));

  c.set("apiKey", record);
  await next();
});

/** Reads the authenticated API key record attached by `apiKeyAuth`. */
export function getApiKey(c: Context<ApiKeyAuthEnv>): ApiKeyRecord {
  return c.get("apiKey");
}

export type { ApiKeyAuthEnv };
