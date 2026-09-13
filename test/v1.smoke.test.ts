import { describe, expect, test } from "bun:test";
import type { OpenAIErrorBody } from "../src/openai/types";
import { Hono } from "hono";
import { v1Router } from "../src/routes/v1";

// Mounts v1Router the same way the final integration pass will
// (`app.route("/v1", v1Router)`), on a throwaway Hono app.
const app = new Hono().route("/v1", v1Router);

describe("v1Router auth", () => {
  test("POST /v1/chat/completions with no Authorization header -> 401", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/foo", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as OpenAIErrorBody;
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("POST /v1/chat/completions with malformed Authorization header -> 401", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Token abc" },
      body: JSON.stringify({ model: "opencode/foo", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /v1/chat/completions with unknown API key -> 401", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-ob-does-not-exist" },
      body: JSON.stringify({ model: "opencode/foo", messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as OpenAIErrorBody;
    expect(body.error.message).toBe("Invalid API key");
  });

  test("GET /v1/models with no Authorization header -> 401", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
  });

  test("POST /v1/responses with no Authorization header -> 401", async () => {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/foo", input: "hi" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("v1Router with a valid API key", () => {
  test("malformed JSON body -> 400", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("smoke-test-app");

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as OpenAIErrorBody;
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("invalid model id (no slash) -> 400", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("smoke-test-app-2");

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ model: "not-a-valid-model-id", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
  });

  test("model id with empty #variant suffix -> 400", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("smoke-test-app-3");

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ model: "openai/gpt-5.4#", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as OpenAIErrorBody;
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("v1Router POST /v1/responses", () => {
  test("malformed JSON body -> 400", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("responses-test-app");

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as OpenAIErrorBody;
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("missing `input` -> 400", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("responses-test-app-2");

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ model: "openai/gpt-5.4" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as OpenAIErrorBody;
    expect(body.error.message).toContain("input");
  });

  test("empty string `input` -> 400", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("responses-test-app-3");

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ model: "openai/gpt-5.4", input: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("invalid model id (no slash) -> 400", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("responses-test-app-4");

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ model: "not-a-valid-model-id", input: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  test("`previous_response_id` is rejected - this gateway is stateless", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("responses-test-app-5");

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ model: "openai/gpt-5.4", input: "hi", previous_response_id: "resp_abc" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as OpenAIErrorBody;
    expect(body.error.message).toContain("previous_response_id");
  });

  test("non-object `text.format.schema` -> 400", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("responses-test-app-6");

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({
        model: "openai/gpt-5.4",
        input: "hi",
        text: { format: { type: "json_schema", name: "x", schema: "not-an-object" } },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as OpenAIErrorBody;
    expect(body.error.message).toContain("schema");
  });

  test("model not found on this gateway -> 404 (no live OpenCode needed - listModels() itself fails first) or 502", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("responses-test-app-7");

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ model: "openai/gpt-5.4", input: "hi" }),
    });
    // No live OpenCode server in this test env, so listModels() throws
    // before any model can ever be "matched" -> 502, not 404.
    expect(res.status).toBe(502);
  });

  test("array-form `input` with a bad model id -> 400 (accepts the structured input shape)", async () => {
    const { createKey } = await import("../src/db/apiKeys");
    const { rawKey } = createKey("responses-test-app-8");

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({
        model: "not-a-valid-model-id",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });
    expect(res.status).toBe(400);
  });
});
