import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Hono } from "hono";
import { db } from "../src/db/client";
import { listCatalogModels } from "../src/catalog";
import type { OpenAIErrorBody } from "../src/openai/types";
import { setPiModelsForTesting } from "../src/piai/models";
import { defaultReasoningVariant, normalizeReasoningVariant } from "../src/reasoning";
import { v1Router } from "../src/routes/v1";

describe("defaultReasoningVariant: as little reasoning as the model allows", () => {
  // Variant lists as OpenCode 1.18.30 / pi-ai report them.
  test.each([
    [["none", "low", "medium", "high", "xhigh"], "none"], // gpt-5.5: reasoning off
    [["minimal", "low", "medium", "high"], "minimal"], // gpt-5: no off, minimal is lowest
    [["low", "medium", "high", "xhigh", "max"], "low"], // gpt-6-astra, claude-opus-5-5
    [["high", "max"], undefined], // claude-sonnet-4-5 / gemini-2.5-pro budgets: no variant is lowest
    [[], undefined],
    [undefined, undefined],
  ] as [string[] | undefined, string | undefined][])("%j -> %p", (variants, expected) => {
    expect(defaultReasoningVariant(variants)).toBe(expected);
  });

  test("off and none are interchangeable", () => {
    expect(normalizeReasoningVariant("off", ["none", "low"])).toBe("none");
    expect(normalizeReasoningVariant("none", ["off", "low"])).toBe("off");
    expect(normalizeReasoningVariant("low", ["none", "low"])).toBe("low");
    expect(normalizeReasoningVariant(undefined, ["none"])).toBeUndefined();
  });
});

// End to end through /v1 with a pi-ai model on a fake OpenAI-compatible
// upstream that records what it is sent.
const app = new Hono().route("/v1", v1Router);
let authHeader: string;
const payloads: Record<string, unknown>[] = [];
let upstream: ReturnType<typeof Bun.serve>;

function model(id: string, reasoning: boolean): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "rmock",
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    compat: { supportsReasoningEffort: true },
  };
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      payloads.push((await req.json()) as Record<string, unknown>);
      const frame = (o: object) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`;
      return new Response(
        frame({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }) +
          frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    },
  });
  const models = createModels();
  const thinker = model("thinker", true);
  models.setProvider(
    createProvider({
      id: "rmock",
      name: "rmock",
      baseUrl: thinker.baseUrl,
      auth: { apiKey: { name: "rmock", resolve: async () => ({ auth: { apiKey: "x" } }) } },
      models: [thinker, model("plain", false)],
      api: openAICompletionsApi(),
    })
  );
  setPiModelsForTesting(models);
  const { createKey } = await import("../src/db/apiKeys");
  authHeader = `Bearer ${createKey("reasoning-test").rawKey}`;
});

afterAll(() => {
  upstream?.stop(true);
  setPiModelsForTesting(null);
});

async function chat(body: object) {
  payloads.length = 0;
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }], ...body }),
  });
  return { res, payload: payloads[0] };
}

function lastLoggedVariant(): string | null {
  return db.query<{ variant: string | null }, []>("SELECT variant FROM requests ORDER BY id DESC LIMIT 1").get()!.variant;
}

describe("reasoning levels on pi-ai models", () => {
  test('a reasoning model lists "none" first; a non-reasoning model lists nothing', async () => {
    const catalog = await listCatalogModels();
    expect(catalog.find((m) => m.id === "pi/rmock/thinker")?.variants?.[0]).toBe("none");
    expect(catalog.find((m) => m.id === "pi/rmock/plain")?.variants).toBeUndefined();
  });

  test("no level given -> reasoning off (logged as none, no effort sent)", async () => {
    const { res, payload } = await chat({ model: "pi/rmock/thinker" });
    expect(res.status).toBe(200);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(lastLoggedVariant()).toBe("none");
  });

  test('explicit "none" and "off" -> off', async () => {
    for (const level of ["none", "off"]) {
      const { res, payload } = await chat({ model: "pi/rmock/thinker", reasoning_effort: level });
      expect(res.status).toBe(200);
      expect(payload.reasoning_effort).toBeUndefined();
      expect(lastLoggedVariant()).toBe("none");
    }
  });

  test("an explicit level is passed through", async () => {
    const { res, payload } = await chat({ model: "pi/rmock/thinker#low" });
    expect(res.status).toBe(200);
    expect(payload.reasoning_effort).toBe("low");
    expect(lastLoggedVariant()).toBe("low");
  });

  test('"none" on a model without reasoning is accepted; a real level is not', async () => {
    expect((await chat({ model: "pi/rmock/plain", reasoning_effort: "none" })).res.status).toBe(200);
    const { res } = await chat({ model: "pi/rmock/plain", reasoning_effort: "high" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as OpenAIErrorBody).error.code).toBe("variant_not_found");
  });
});
