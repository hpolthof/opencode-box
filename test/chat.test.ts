import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Hono } from "hono";
import {
  messagesToPiContext,
  piUsageToTokenUsage,
  structuredOutputHook,
  UnsupportedResponseFormatError,
} from "../src/piai/chat";
import { setPiModelsForTesting } from "../src/piai/models";
import type { ChatCompletionResponse, OpenAIErrorBody } from "../src/openai/types";
import { v1Router } from "../src/routes/v1";

const schemaFormat = {
  type: "json_schema" as const,
  json_schema: { name: "answer", strict: true, schema: { type: "object", properties: { a: { type: "string" } } } },
};

describe("structuredOutputHook", () => {
  test("OpenAI Chat Completions gets response_format", () => {
    const hook = structuredOutputHook("openai-completions", schemaFormat)!;
    expect(hook({ model: "m" })).toEqual({
      model: "m",
      response_format: { type: "json_schema", json_schema: schemaFormat.json_schema },
    });
  });

  test("OpenAI Responses gets text.format, keeping other text options", () => {
    const hook = structuredOutputHook("openai-responses", schemaFormat)!;
    expect(hook({ text: { verbosity: "low" } })).toEqual({
      text: { verbosity: "low", format: { type: "json_schema", ...schemaFormat.json_schema } },
    });
  });

  test("Anthropic gets output_config.format merged with pi-ai's effort", () => {
    const hook = structuredOutputHook("anthropic-messages", schemaFormat)!;
    expect(hook({ output_config: { effort: "high" } })).toEqual({
      output_config: { effort: "high", format: { type: "json_schema", schema: schemaFormat.json_schema.schema } },
    });
  });

  test("defaults name to 'response' and strict to false", () => {
    const hook = structuredOutputHook("openai-completions", { type: "json_schema", json_schema: { schema: {} } })!;
    expect(hook({})).toEqual({ response_format: { type: "json_schema", json_schema: { name: "response", schema: {}, strict: false } } });
  });

  test("json_schema on an API without support throws", () => {
    expect(() => structuredOutputHook("google-generative-ai", schemaFormat)).toThrow(UnsupportedResponseFormatError);
  });

  test("text / absent format -> no hook; json_object ignored where there is no equivalent", () => {
    expect(structuredOutputHook("openai-completions", undefined)).toBeUndefined();
    expect(structuredOutputHook("openai-completions", { type: "text" })).toBeUndefined();
    expect(structuredOutputHook("anthropic-messages", { type: "json_object" })).toBeUndefined();
  });
});

describe("messagesToPiContext", () => {
  const model = { api: "openai-completions", provider: "p", id: "m" } as Model<"openai-completions">;

  test("keeps turns as turns and collects system/developer messages", () => {
    const ctx = messagesToPiContext(
      [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "developer" as "system", content: "Answer in Dutch." },
        { role: "user", content: [{ type: "text", text: "How " }, { type: "text", text: "are you?" }] as unknown as string },
      ],
      model
    );
    expect(ctx.systemPrompt).toBe("Be brief.\n\nAnswer in Dutch.");
    expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(ctx.messages[2]).toMatchObject({ role: "user", content: "How are you?" });
    expect(ctx.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Hello!" }], provider: "p", model: "m" });
  });
});

describe("piUsageToTokenUsage", () => {
  test("adds cached input to prompt tokens; output already includes reasoning", () => {
    const usage = piUsageToTokenUsage({
      input: 100,
      output: 50,
      reasoning: 20,
      cacheRead: 1000,
      cacheWrite: 10,
      totalTokens: 1160,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(usage).toEqual({
      promptTokens: 1110,
      completionTokens: 50,
      totalTokens: 1160,
      reasoningTokens: 20,
      cacheReadTokens: 1000,
      cacheWriteTokens: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// Route: /v1/chat/completions with "pi/..." models
// ---------------------------------------------------------------------------

const app = new Hono().route("/v1", v1Router);
let authHeader: string;

// A fake OpenAI-compatible upstream: records each payload and streams a
// fixed answer in three chunks, so the real openai-completions adapter
// (including the onPayload hook) is exercised end to end.
const payloads: Record<string, unknown>[] = [];
let upstream: ReturnType<typeof Bun.serve>;

const faux = fauxProvider({ provider: "faux", models: [{ id: "chat", reasoning: true }] });

beforeAll(async () => {
  const { createKey } = await import("../src/db/apiKeys");
  authHeader = `Bearer ${createKey("piai-test-app").rawKey}`;

  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      payloads.push((await req.json()) as Record<string, unknown>);
      const chunk = (delta: object, extra: object = {}) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
      const body =
        chunk({ role: "assistant", content: '{"a":' }) +
        chunk({ content: '"b"' }) +
        chunk({ content: "}" }) +
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });

  const mockModel: Model<"openai-completions"> = {
    id: "json",
    name: "json",
    api: "openai-completions",
    provider: "mock",
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4000,
  };
  const models = createModels();
  models.setProvider(faux.provider);
  models.setProvider(
    createProvider({
      id: "mock",
      name: "mock",
      baseUrl: mockModel.baseUrl,
      auth: { apiKey: { name: "mock", resolve: async () => ({ auth: { apiKey: "x" } }) } },
      models: [mockModel],
      api: openAICompletionsApi(),
    })
  );
  setPiModelsForTesting(models);
});

afterAll(() => {
  upstream?.stop(true);
  setPiModelsForTesting(null);
});

function post(body: object) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/chat/completions via pi-ai", () => {
  test("non-streaming: returns the faux answer with usage", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("Hallo daar")])]);
    const res = await post({ model: "faux/chat", messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatCompletionResponse;
    expect(body.model).toBe("faux/chat");
    expect(body.choices[0].message.content).toBe("Hallo daar");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage?.completion_tokens).toBeGreaterThan(0);
  });

  test("unknown pi model -> 404", async () => {
    const res = await post({ model: "faux/nope", messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as OpenAIErrorBody).error.code).toBe("model_not_found");
  });

  test("unsupported reasoning level -> 400", async () => {
    const res = await post({ model: "mock/json#high", messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as OpenAIErrorBody).error.code).toBe("variant_not_found");
  });

  test("upstream error before any content -> 502 JSON error", async () => {
    faux.setResponses([]);
    const res = await post({ model: "faux/chat", stream: true, messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as OpenAIErrorBody).error.message).toContain("No more faux responses");
  });

  test("streaming + json_schema: payload carries response_format, chunks stream through, usage on request", async () => {
    payloads.length = 0;
    const res = await post({
      model: "mock/json",
      stream: true,
      stream_options: { include_usage: true },
      response_format: schemaFormat,
      messages: [
        { role: "system", content: "Only JSON." },
        { role: "user", content: "Go" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Exactly what went upstream: our system prompt only, no agent prompt, plus the native format.
    expect(payloads).toHaveLength(1);
    expect(payloads[0].messages).toEqual([
      { role: "system", content: "Only JSON." },
      { role: "user", content: "Go" },
    ]);
    expect(payloads[0].response_format).toEqual({ type: "json_schema", json_schema: schemaFormat.json_schema });

    const frames = (await res.text())
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice(6));
    expect(frames.at(-1)).toBe("[DONE]");
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe('{"a":"b"}');
    expect(chunks.filter((c) => c.choices[0]?.delta?.content).length).toBe(3);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  });

});
