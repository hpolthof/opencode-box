import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { Hono } from "hono";
import type { ResponseObject } from "../src/openai/responsesTypes";
import type { ChatCompletionResponse, ChatMessage } from "../src/openai/types";
import { setPiModelsForTesting } from "../src/piai/models";
import { planParams } from "../src/piai/params";
import { piComplete } from "../src/piai/run";
import { v1Router } from "../src/routes/v1";

// ---------------------------------------------------------------------------
// planParams: which parameter goes where, per model / auth
// ---------------------------------------------------------------------------

function fakeModel(api: Api, provider: string, compat?: object): Model<Api> {
  return {
    id: "m",
    name: "m",
    api,
    provider,
    baseUrl: "http://127.0.0.1:1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 8000,
    ...(compat ? { compat } : {}),
  } as Model<Api>;
}

const all = { maxOutputTokens: 600, temperature: 0, topP: 0.9, promptCacheKey: "k" };
const env = { chatgptSignIn: false, rejected: new Set<string>() };

describe("planParams", () => {
  test("OpenAI Responses with an API key: everything forwarded", () => {
    const plan = planParams(fakeModel("openai-responses", "openai"), false, all, env);
    expect(plan.options).toEqual({ maxTokens: 600, temperature: 0, samplingParams: { top_p: 0.9 }, sessionId: "k" });
    expect(plan.dropped).toEqual([]);
    expect(plan.retryable).toEqual(["temperature", "top_p"]);
  });

  test("Sign in with ChatGPT: cap, temperature and top_p dropped, prompt_cache_key kept", () => {
    const plan = planParams(fakeModel("openai-responses", "openai"), false, all, { ...env, chatgptSignIn: true });
    expect(plan.options).toEqual({ sessionId: "k" });
    expect(plan.dropped).toEqual(["max_output_tokens", "temperature", "top_p"]);
  });

  test("the dropped cap is reported under the client's own name", () => {
    const plan = planParams(fakeModel("openai-responses", "openai"), false, { maxOutputTokens: 5, maxOutputTokensParam: "max_tokens" }, { ...env, chatgptSignIn: true });
    expect(plan.dropped).toEqual(["max_tokens"]);
  });

  test("prompt_cache_key only goes to OpenAI itself", () => {
    expect(planParams(fakeModel("openai-completions", "openrouter"), false, { promptCacheKey: "k" }, env).dropped).toEqual(["prompt_cache_key"]);
    expect(planParams(fakeModel("anthropic-messages", "anthropic"), false, { promptCacheKey: "k" }, env).dropped).toEqual(["prompt_cache_key"]);
    expect(planParams(fakeModel("openai-completions", "openai"), false, { promptCacheKey: "k" }, env).options).toEqual({ sessionId: "k" });
  });

  test("a parameter the model rejected before is dropped up front", () => {
    const plan = planParams(fakeModel("openai-responses", "openai"), false, all, { ...env, rejected: new Set(["temperature"]) });
    expect(plan.options.temperature).toBeUndefined();
    expect(plan.dropped).toEqual(["temperature"]);
  });

  test("Anthropic without temperature support: temperature and top_p dropped", () => {
    const plan = planParams(fakeModel("anthropic-messages", "anthropic", { supportsTemperature: false }), false, all, env);
    expect(plan.dropped).toEqual(["temperature", "top_p", "prompt_cache_key"]);
    expect(plan.options).toEqual({ maxTokens: 600 });
  });

  test("Anthropic with extended thinking: temperature dropped", () => {
    expect(planParams(fakeModel("anthropic-messages", "anthropic"), true, { temperature: 0.5 }, env).dropped).toEqual(["temperature"]);
    expect(planParams(fakeModel("anthropic-messages", "anthropic"), false, { temperature: 0.5 }, env).options).toEqual({ temperature: 0.5 });
  });

  test("Anthropic: top_p through the payload hook, but not together with temperature", () => {
    const plan = planParams(fakeModel("anthropic-messages", "anthropic"), false, { topP: 0.9 }, env);
    expect(plan.onPayload!({ max_tokens: 8000 })).toEqual({ max_tokens: 8000, top_p: 0.9 });
    expect(planParams(fakeModel("anthropic-messages", "anthropic"), false, { temperature: 0, topP: 0.9 }, env).dropped).toEqual(["top_p"]);
  });

  test("Anthropic: the cap is sent one-to-one, the thinking budget shrunk to fit", () => {
    const hook = planParams(fakeModel("anthropic-messages", "anthropic"), true, { maxOutputTokens: 3000 }, env).onPayload!;
    // pi-ai adds the budget on top of the cap; that is undone.
    expect(hook({ max_tokens: 11192, thinking: { type: "enabled", budget_tokens: 8192 } })).toEqual({
      max_tokens: 3000,
      thinking: { type: "enabled", budget_tokens: 2999 },
    });
    const tiny = planParams(fakeModel("anthropic-messages", "anthropic"), true, { maxOutputTokens: 500 }, env).onPayload!;
    expect(tiny({ max_tokens: 8692, thinking: { type: "enabled", budget_tokens: 8192 } })).toEqual({ max_tokens: 500, thinking: { type: "disabled" } });
  });
});

// ---------------------------------------------------------------------------
// End to end against a fake upstream
// ---------------------------------------------------------------------------

const app = new Hono().route("/v1", v1Router);
let authHeader: string;
const payloads: Record<string, unknown>[] = [];
let upstream: ReturnType<typeof Bun.serve>;

const UNSUPPORTED_TEMPERATURE = {
  error: {
    message: "Unsupported parameter: 'temperature' is not supported with this model.",
    type: "invalid_request_error",
    param: "temperature",
    code: "unsupported_parameter",
  },
};

function chatStream(finishReason: "stop" | "length"): Response {
  const frame = (o: object) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`;
  return new Response(
    frame({ choices: [{ index: 0, delta: { role: "assistant", content: "Once upon" }, finish_reason: null }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  );
}

/** A Responses API stream that stops on max_output_tokens. */
function responsesIncompleteStream(): Response {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] };
  const events = [
    { type: "response.created", response: { id: "resp_up", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "Once upon" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, status: "incomplete", content: [{ type: "output_text", text: "Once upon", annotations: [] }] },
    },
    {
      type: "response.incomplete",
      response: {
        id: "resp_up",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 3, output_tokens: 16, total_tokens: 19, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      },
    },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function completionsModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "pmock",
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4000,
  };
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const payload = (await req.json()) as Record<string, unknown>;
      payloads.push(payload);
      if (new URL(req.url).pathname.endsWith("/responses")) return responsesIncompleteStream();
      if (String(payload.model).startsWith("picky") && "temperature" in payload) {
        return Response.json(UNSUPPORTED_TEMPERATURE, { status: 400 });
      }
      if (payload.model === "broken") return Response.json({ error: { message: "Invalid schema", type: "invalid_request_error" } }, { status: 400 });
      return chatStream(payload.model === "capped" ? "length" : "stop");
    },
  });
  const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
  const responsesModel: Model<"openai-responses"> = {
    id: "resp",
    name: "resp",
    api: "openai-responses",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4000,
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "pmock",
      name: "pmock",
      baseUrl,
      auth: { apiKey: { name: "pmock", resolve: async () => ({ auth: { apiKey: "x" } }) } },
      models: ["plain", "capped", "picky", "picky-stream", "broken"].map(completionsModel),
      api: openAICompletionsApi(),
    })
  );
  // Stands in for OpenAI itself (with an API key), so prompt_cache_key is forwarded.
  models.setProvider(
    createProvider({
      id: "openai",
      name: "openai",
      baseUrl,
      auth: { apiKey: { name: "openai", resolve: async () => ({ auth: { apiKey: "sk-test" } }) } },
      models: [responsesModel],
      api: openAIResponsesApi(),
    })
  );
  setPiModelsForTesting(models);
  const { createKey } = await import("../src/db/apiKeys");
  authHeader = `Bearer ${createKey("params-test").rawKey}`;
});

afterAll(() => {
  upstream?.stop(true);
  setPiModelsForTesting(null);
});

function post(path: string, body: object) {
  payloads.length = 0;
  return app.request(`/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
}

function sseData(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)));
}

const messages: ChatMessage[] = [{ role: "user", content: "Tell me a long story" }];

describe("request parameters reach the provider", () => {
  test("Chat: temperature 0, top_p and max_completion_tokens are in the upstream payload", async () => {
    const res = await post("/chat/completions", { model: "pmock/plain", messages, temperature: 0, top_p: 0.3, max_completion_tokens: 123 });
    expect(res.status).toBe(200);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ temperature: 0, top_p: 0.3, max_completion_tokens: 123 });
  });

  test("Chat: legacy max_tokens is the cap when max_completion_tokens is absent", async () => {
    await post("/chat/completions", { model: "pmock/plain", messages, max_tokens: 77 });
    expect(payloads[0].max_completion_tokens).toBe(77);
  });

  test("Responses: max_output_tokens and prompt_cache_key reach OpenAI", async () => {
    const res = await post("/responses", { model: "openai/resp", input: "Tell me a long story", max_output_tokens: 50, prompt_cache_key: "static-prefix-1", temperature: 0 });
    expect(res.status).toBe(200);
    expect(payloads[0]).toMatchObject({ max_output_tokens: 50, prompt_cache_key: "static-prefix-1", temperature: 0 });
  });

  test("Responses: max_output_tokens below 16 is raised to OpenAI's minimum", async () => {
    await post("/responses", { model: "openai/resp", input: "Hi", max_output_tokens: 5 });
    expect(payloads[0].max_output_tokens).toBe(16);
  });
});

describe("stopping on the token cap", () => {
  test("Chat non-streaming: finish_reason length", async () => {
    const res = await post("/chat/completions", { model: "pmock/capped", messages, max_tokens: 2 });
    expect(((await res.json()) as ChatCompletionResponse).choices[0].finish_reason).toBe("length");
  });

  test("Chat streaming: the last choice has finish_reason length", async () => {
    const res = await post("/chat/completions", { model: "pmock/capped", messages, max_tokens: 2, stream: true });
    const chunks = sseData(await res.text()) as unknown as { choices: { finish_reason: string | null }[] }[];
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe("length");
  });

  test("Responses non-streaming: status incomplete with reason max_output_tokens", async () => {
    const res = await post("/responses", { model: "openai/resp", input: "Tell me a long story", max_output_tokens: 16 });
    const body = (await res.json()) as ResponseObject;
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(body.output[0].status).toBe("incomplete");
    expect(body.output_text).toBe("Once upon");
  });

  test("Responses streaming: ends with response.incomplete instead of response.completed", async () => {
    const res = await post("/responses", { model: "openai/resp", input: "Tell me a long story", max_output_tokens: 16, stream: true });
    const events = sseData(await res.text());
    expect(events.map((e) => e.type)).not.toContain("response.completed");
    expect(events.at(-1)).toMatchObject({
      type: "response.incomplete",
      response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    });
  });
});

describe("a provider that rejects temperature at runtime", () => {
  test("is retried once without it, and remembered for the model", async () => {
    payloads.length = 0;
    const target = { providerID: "pmock", modelID: "picky", variant: undefined };
    const first = await piComplete(target, { messages, temperature: 0 }, 5000);
    expect(first).toMatchObject({ ok: true, droppedParams: ["temperature"] });
    expect(payloads).toHaveLength(2);
    expect(payloads[0].temperature).toBe(0);
    expect("temperature" in payloads[1]).toBe(false);

    // Later calls drop it up front: no failing request first.
    payloads.length = 0;
    const second = await piComplete(target, { messages, temperature: 0.5 }, 5000);
    expect(second).toMatchObject({ ok: true, droppedParams: ["temperature"] });
    expect(payloads).toHaveLength(1);
  });

  test("streaming: retried before anything reaches the client", async () => {
    const res = await post("/chat/completions", { model: "pmock/picky-stream", messages, temperature: 0, stream: true });
    expect(res.status).toBe(200);
    expect(payloads).toHaveLength(2);
    expect(sseData(await res.text()).length).toBeGreaterThan(0);
  });

  test("other failures are not retried", async () => {
    payloads.length = 0;
    const result = await piComplete({ providerID: "pmock", modelID: "broken", variant: undefined }, { messages, temperature: 0 }, 5000);
    expect(result.ok).toBe(false);
    expect(payloads).toHaveLength(1);
  });
});
