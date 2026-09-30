import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createModels, createProvider, type Api, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { Hono } from "hono";
import { createAlias } from "../src/db/modelAliases";
import type { OpenAIErrorBody } from "../src/openai/types";
import { classifyProviderError, parseProviderErrorBody, splitProviderErrorMessage } from "../src/piai/errors";
import { setPiModelsForTesting } from "../src/piai/models";
import { v1Router } from "../src/routes/v1";

// ---------------------------------------------------------------------------
// Parsing pi-ai's error messages
// ---------------------------------------------------------------------------

const INVALID_SCHEMA = {
  message: "Invalid schema for response_format 'answer': In context=(), 'additionalProperties' is required to be supplied and to be false.",
  type: "invalid_request_error",
  param: "text.format.schema",
  code: "invalid_json_schema",
};

describe("classifyProviderError", () => {
  test("OpenAI SDK error (prefix + status + JSON body) -> 400 with type/param/code, no failover", () => {
    const error = classifyProviderError(`OpenAI API error (400): ${JSON.stringify(INVALID_SCHEMA)}`);
    expect(error).toEqual({ status: 400, ...INVALID_SCHEMA, failover: false });
  });

  test("status repeated before the body (message carried the body)", () => {
    const error = classifyProviderError(`OpenAI API error (400): 400 ${JSON.stringify(INVALID_SCHEMA)}`);
    expect(error).toEqual({ status: 400, ...INVALID_SCHEMA, failover: false });
  });

  test("ChatGPT backend {detail} body", () => {
    const error = classifyProviderError('OpenAI API error (400): 400 {"detail":"Unsupported parameter: temperature"}');
    expect(error).toEqual({ status: 400, message: "Unsupported parameter: temperature", type: "invalid_request_error", failover: false });
  });

  test('{"error": {...}} wrapper and Anthropic\'s {"type":"error","error":{...}}', () => {
    expect(classifyProviderError(`404 ${JSON.stringify({ error: { message: "No such model", type: "invalid_request_error", code: "model_not_found" } })}`)).toEqual({
      status: 404,
      message: "No such model",
      type: "invalid_request_error",
      code: "model_not_found",
      failover: true,
    });
    expect(
      classifyProviderError('413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}')
    ).toEqual({ status: 413, message: "Request exceeds the maximum size", type: "request_too_large", failover: false });
  });

  test("429 / 401 / 403 keep their status but fail over", () => {
    expect(classifyProviderError('OpenAI API error (429): {"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}')).toEqual({
      status: 429,
      message: "Rate limit reached",
      type: "requests",
      code: "rate_limit_exceeded",
      failover: true,
    });
    expect(classifyProviderError("401 status code (no body)")).toEqual({
      status: 401,
      message: "status code (no body)",
      type: "authentication_error",
      failover: true,
    });
    expect(classifyProviderError("openrouter API error (403): Forbidden").status).toBe(403);
    expect(classifyProviderError("openrouter API error (403): Forbidden").failover).toBe(true);
  });

  test("5xx, network errors and unknown shapes -> 502 api_error with the raw message, failover", () => {
    const raw = 'OpenAI API error (500): {"message":"The server had an error","type":"server_error"}';
    expect(classifyProviderError(raw)).toEqual({ status: 502, message: raw, type: "api_error", failover: true });
    expect(classifyProviderError("Connection error.")).toEqual({ status: 502, message: "Connection error.", type: "api_error", failover: true });
    expect(classifyProviderError("Something odd happened")).toMatchObject({ status: 502, type: "api_error", failover: true });
  });

  test("an observed HTTP status and body win over the message text", () => {
    // ChatGPT/Codex: pi-ai's message carries neither status nor body.
    const error = classifyProviderError("Unsupported parameter: temperature", {
      status: 400,
      body: '{"detail":"Unsupported parameter: temperature"}',
    });
    expect(error).toEqual({ status: 400, message: "Unsupported parameter: temperature", type: "invalid_request_error", failover: false });
    // A successful last response says nothing about the failure.
    expect(classifyProviderError("stream broke", { status: 200 })).toMatchObject({ status: 502 });
  });

  test("splitProviderErrorMessage / parseProviderErrorBody", () => {
    expect(splitProviderErrorMessage('OpenAI API error (400): 400 {"a":1}')).toEqual({ status: 400, rest: '{"a":1}' });
    expect(splitProviderErrorMessage('400: {"a":1}')).toEqual({ status: 400, rest: '{"a":1}' });
    expect(splitProviderErrorMessage("Connection error.")).toEqual({ status: undefined, rest: "Connection error." });
    expect(parseProviderErrorBody('{"error":"bad key"}')).toMatchObject({ message: "bad key" });
    expect(parseProviderErrorBody("not json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routes, against a fake upstream
// ---------------------------------------------------------------------------

const app = new Hono().route("/v1", v1Router);
let authHeader: string;
let upstream: ReturnType<typeof Bun.serve>;
/** Upstream requests per model id. */
const hits: Record<string, number> = {};

function sseChat(text: string): Response {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return new Response(chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function fakeModel<TApi extends Api>(provider: string, id: string, api: TApi, baseUrl: string): Model<TApi> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4000,
  };
}

function fakeProvider(id: string, api: Api, streams: ProviderStreams, baseUrl: string, modelIds: string[]) {
  return createProvider({
    id,
    name: id,
    baseUrl,
    auth: { apiKey: { name: id, resolve: async () => ({ auth: { apiKey: "x" } }) } },
    models: modelIds.map((m) => fakeModel(id, m, api, baseUrl)),
    api: streams,
  });
}

beforeAll(async () => {
  const { createKey } = await import("../src/db/apiKeys");
  authHeader = `Bearer ${createKey("provider-errors-test").rawKey}`;

  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const model = String(((await req.json()) as { model?: unknown }).model);
      hits[model] = (hits[model] ?? 0) + 1;
      switch (model) {
        case "bad":
        case "bad-responses":
          return Response.json({ error: INVALID_SCHEMA }, { status: 400 });
        case "bad-anthropic":
          return Response.json(
            { type: "error", error: { type: "invalid_request_error", message: "max_tokens: Field required" } },
            { status: 400 }
          );
        case "down":
          return Response.json({ error: { message: "The server had an error", type: "server_error" } }, { status: 500 });
        case "gone":
          return Response.json({ error: { message: "The model `gone` does not exist", type: "invalid_request_error", code: "model_not_found" } }, { status: 404 });
        case "limited":
          return Response.json({ error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } }, { status: 429 });
        default:
          return sseChat("fine");
      }
    },
  });
  const base = `http://127.0.0.1:${upstream.port}`;

  const models = createModels();
  models.setProvider(fakeProvider("fake", "openai-completions", openAICompletionsApi(), `${base}/v1`, ["bad", "down", "gone", "limited", "good"]));
  models.setProvider(fakeProvider("fakeresp", "openai-responses", openAIResponsesApi(), `${base}/v1`, ["bad-responses"]));
  models.setProvider(fakeProvider("fakeanth", "anthropic-messages", anthropicMessagesApi(), base, ["bad-anthropic"]));
  // Available (has auth) but its endpoint refuses connections.
  models.setProvider(fakeProvider("refused", "openai-completions", openAICompletionsApi(), "http://127.0.0.1:9/v1", ["refused"]));
  setPiModelsForTesting(models);

  const target = (providerID: string, modelID: string) => ({ providerID, modelID, variant: "" });
  createAlias("err-bad-first", "priority", [target("fake", "bad"), target("fake", "good")]);
  createAlias("err-down-first", "priority", [target("fake", "down"), target("fake", "good")]);
  createAlias("err-refused-first", "priority", [target("refused", "refused"), target("fake", "good")]);
  createAlias("err-limited-first", "priority", [target("fake", "limited"), target("fake", "good")]);
  createAlias("err-gone-first", "priority", [target("fake", "gone"), target("fake", "good")]);
});

afterAll(() => {
  upstream?.stop(true);
  setPiModelsForTesting(null);
});

beforeEach(() => {
  for (const key of Object.keys(hits)) delete hits[key];
});

function post(path: "/v1/chat/completions" | "/v1/responses", body: object) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
}

function request(path: "/v1/chat/completions" | "/v1/responses", model: string, stream: boolean) {
  return path === "/v1/chat/completions"
    ? post(path, { model, stream, messages: [{ role: "user", content: "Hi" }] })
    : post(path, { model, stream, input: "Hi" });
}

const cases = (["/v1/chat/completions", "/v1/responses"] as const).flatMap((path) =>
  [false, true].map((stream) => ({ path, stream, label: `${path}${stream ? " (stream)" : ""}` }))
);

describe("provider 4xx errors are passed through", () => {
  for (const { path, stream, label } of cases) {
    test(`${label}: a provider 400 -> 400 with code/param, one upstream attempt through a two-target alias`, async () => {
      const res = await request(path, "err-bad-first", stream);
      expect(res.status).toBe(400);
      expect(((await res.json()) as OpenAIErrorBody).error).toEqual(INVALID_SCHEMA);
      expect(hits).toEqual({ bad: 1 });
    });
  }

  test("OpenAI Responses adapter: 400 with code/param", async () => {
    const res = await request("/v1/chat/completions", "fakeresp/bad-responses", false);
    expect(res.status).toBe(400);
    expect(((await res.json()) as OpenAIErrorBody).error).toEqual(INVALID_SCHEMA);
  });

  test("Anthropic adapter: 400 with the provider's type and message", async () => {
    const res = await request("/v1/responses", "fakeanth/bad-anthropic", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as OpenAIErrorBody).error).toEqual({ type: "invalid_request_error", message: "max_tokens: Field required" });
  });

  test("a direct 429 is passed through as 429", async () => {
    const res = await request("/v1/chat/completions", "fake/limited", false);
    expect(res.status).toBe(429);
    expect(((await res.json()) as OpenAIErrorBody).error).toMatchObject({ code: "rate_limit_exceeded", message: "Rate limit reached" });
  });

  test("a direct 500 is still a 502 api_error", async () => {
    const res = await request("/v1/chat/completions", "fake/down", false);
    expect(res.status).toBe(502);
    expect(((await res.json()) as OpenAIErrorBody).error.type).toBe("api_error");
  });
});

describe("failover still happens where another target may succeed", () => {
  for (const { path, stream, label } of cases) {
    test(`${label}: 500, 404 (model not found), connection refused and 429 fall over to the second target`, async () => {
      for (const [alias, failing] of [
        ["err-down-first", "down"],
        ["err-gone-first", "gone"],
        ["err-limited-first", "limited"],
        ["err-refused-first", null],
      ] as const) {
        for (const key of Object.keys(hits)) delete hits[key];
        const res = await request(path, alias, stream);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("fine");
        expect(hits).toEqual(failing ? { [failing]: 1, good: 1 } : { good: 1 });
      }
    });
  }
});
