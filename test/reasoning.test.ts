import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, createProvider, type Model, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { db } from "../src/db/client";
import { createAlias } from "../src/db/modelAliases";
import { listCatalogModels } from "../src/catalog";
import type { OpenAIErrorBody } from "../src/openai/types";
import { setPiModelsForTesting } from "../src/piai/models";
import { defaultReasoningVariant, isReasoningLevel, normalizeReasoningVariant, resolveReasoningVariant } from "../src/reasoning";
import { resolveRequestedModel, v1Router } from "../src/routes/v1";

// Level lists of real models, as the catalog reports them.
const GPT_55 = ["none", "low", "medium", "high", "xhigh"];
const GPT_5 = ["minimal", "low", "medium", "high"];
const SOL = ["low", "medium", "high", "xhigh", "max"]; // gpt-6.1-sol: can't switch reasoning off
const BUDGETS = ["high", "max"];

describe("resolveReasoningVariant", () => {
  test("nothing requested -> the default minimum", () => {
    expect(resolveReasoningVariant(undefined, SOL)).toEqual({ ok: true, variant: "low" });
    expect(resolveReasoningVariant("", GPT_55)).toEqual({ ok: true, variant: "none" });
  });

  test("an offered level is used as is; off/none interchangeably", () => {
    expect(resolveReasoningVariant("high", SOL)).toEqual({ ok: true, variant: "high" });
    expect(resolveReasoningVariant("none", GPT_55)).toEqual({ ok: true, variant: "none" });
    expect(resolveReasoningVariant("off", GPT_55)).toEqual({ ok: true, variant: "none" });
  });

  test.each([
    [SOL, "low"],
    [GPT_5, "minimal"],
    [BUDGETS, undefined],
    [[], undefined],
    [undefined, undefined],
  ] as [string[] | undefined, string | undefined][])('"none"/"off" on %j without an off level -> %p', (variants, expected) => {
    expect(resolveReasoningVariant("none", variants)).toEqual({ ok: true, variant: expected });
    expect(resolveReasoningVariant("off", variants)).toEqual({ ok: true, variant: expected });
  });

  test("any other level the model doesn't offer is an error without clamping", () => {
    expect(resolveReasoningVariant("turbo", SOL)).toEqual({ ok: false });
    expect(resolveReasoningVariant("minimal", SOL)).toEqual({ ok: false });
    expect(resolveReasoningVariant("high", [])).toEqual({ ok: false });
  });

  test("clamping prefers the next higher level, then the next lower", () => {
    const clamp = (level: string, variants: string[] | undefined) => resolveReasoningVariant(level, variants, { clamp: true });
    expect(clamp("minimal", SOL)).toEqual({ ok: true, variant: "low" });
    expect(clamp("medium", BUDGETS)).toEqual({ ok: true, variant: "high" });
    expect(clamp("xhigh", GPT_5)).toEqual({ ok: true, variant: "high" });
    expect(clamp("max", GPT_55)).toEqual({ ok: true, variant: "xhigh" });
    expect(clamp("medium", SOL)).toEqual({ ok: true, variant: "medium" });
    expect(clamp("none", SOL)).toEqual({ ok: true, variant: "low" });
    expect(clamp("high", [])).toEqual({ ok: true, variant: undefined });
    expect(clamp("high", ["none"])).toEqual({ ok: true, variant: "none" });
    expect(clamp("turbo", SOL)).toEqual({ ok: false });
  });

  test("isReasoningLevel", () => {
    for (const level of ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"]) expect(isReasoningLevel(level)).toBe(true);
    expect(isReasoningLevel("turbo")).toBe(false);
  });
});

describe("defaultReasoningVariant: as little reasoning as the model allows", () => {
  // Typical reasoning-level lists of real models.
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

function model(id: string, reasoning: boolean, thinkingLevelMap?: ThinkingLevelMap): Model<"openai-completions"> {
  return {
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
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
      models: [
        thinker,
        model("plain", false),
        // Like gpt-6.1-sol: reasoning can't be switched off.
        model("sol", true, { off: null, minimal: null, xhigh: "xhigh", max: "max" }),
        // Only high thinking budgets.
        model("budget", true, { off: null, minimal: null, low: null, medium: null, max: "max" }),
      ],
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
    expect(catalog.find((m) => m.id === "rmock/thinker")?.variants?.[0]).toBe("none");
    expect(catalog.find((m) => m.id === "rmock/plain")?.variants).toBeUndefined();
  });

  test("no level given -> reasoning off (logged as none, no effort sent)", async () => {
    const { res, payload } = await chat({ model: "rmock/thinker" });
    expect(res.status).toBe(200);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(lastLoggedVariant()).toBe("none");
  });

  test('explicit "none" and "off" -> off', async () => {
    for (const level of ["none", "off"]) {
      const { res, payload } = await chat({ model: "rmock/thinker", reasoning_effort: level });
      expect(res.status).toBe(200);
      expect(payload.reasoning_effort).toBeUndefined();
      expect(lastLoggedVariant()).toBe("none");
    }
  });

  test("an explicit level is passed through", async () => {
    const { res, payload } = await chat({ model: "rmock/thinker#low" });
    expect(res.status).toBe(200);
    expect(payload.reasoning_effort).toBe("low");
    expect(lastLoggedVariant()).toBe("low");
  });

  test('"none" on a model without reasoning is accepted; a real level is not', async () => {
    expect((await chat({ model: "rmock/plain", reasoning_effort: "none" })).res.status).toBe(200);
    const { res } = await chat({ model: "rmock/plain", reasoning_effort: "high" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as OpenAIErrorBody).error.code).toBe("variant_not_found");
  });
});

describe("an explicit none/off on a model that can't switch reasoning off", () => {
  test('"none" runs at the lowest effort level', async () => {
    for (const level of ["none", "off"]) {
      const { res, payload } = await chat({ model: "rmock/sol", reasoning_effort: level });
      expect(res.status).toBe(200);
      expect(payload.reasoning_effort).toBe("low");
      expect(lastLoggedVariant()).toBe("low");
    }
  });

  test('"none" on a model with only high budgets sends no level', async () => {
    const { res, payload } = await chat({ model: "rmock/budget#none" });
    expect(res.status).toBe(200);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(lastLoggedVariant()).toBeNull();
  });

  test("a name that isn't a reasoning level, or a level the model lacks, is still a 400", async () => {
    for (const level of ["turbo", "minimal"]) {
      const { res } = await chat({ model: "rmock/sol", reasoning_effort: level });
      expect(res.status).toBe(400);
      expect(((await res.json()) as OpenAIErrorBody).error.code).toBe("variant_not_found");
    }
  });
});

describe("aliases and the client's reasoning effort", () => {
  beforeAll(() => {
    createAlias("r-pinned", "priority", [
      { providerID: "rmock", modelID: "thinker", variant: "low" },
      { providerID: "rmock", modelID: "sol", variant: "none" },
    ]);
    createAlias(
      "r-override",
      "priority",
      [
        { providerID: "rmock", modelID: "sol", variant: "high" },
        { providerID: "rmock", modelID: "thinker", variant: "high" },
        { providerID: "rmock", modelID: "budget", variant: "max" },
      ],
      { clientEffortOverrides: true }
    );
    createAlias("r-sol-none", "priority", [{ providerID: "rmock", modelID: "sol", variant: "none" }]);
  });

  const levels = (resolution: Awaited<ReturnType<typeof resolveRequestedModel>>) =>
    resolution.ok ? resolution.targets.map((t) => `${t.modelID}:${t.variant ?? "-"}`) : resolution;

  test("setting off: pinned levels win and an explicit effort is flagged as ignored", async () => {
    let resolution = await resolveRequestedModel("r-pinned", "high", null);
    expect(levels(resolution)).toEqual(["thinker:low", "sol:low"]);
    expect(resolution.ok && resolution.clientEffortIgnored).toBe(true);

    resolution = await resolveRequestedModel("r-pinned", undefined, null);
    expect(resolution.ok && resolution.clientEffortIgnored).toBe(false);

    const { res, payload } = await chat({ model: "r-pinned", reasoning_effort: "high" });
    expect(res.status).toBe(200);
    expect(payload.reasoning_effort).toBe("low");
  });

  test("setting on: the client's effort goes to every target, clamped to what each offers", async () => {
    let resolution = await resolveRequestedModel("r-override", "minimal", null);
    expect(levels(resolution)).toEqual(["sol:low", "thinker:minimal", "budget:high"]);
    expect(resolution.ok && resolution.clientEffortIgnored).toBe(false);

    resolution = await resolveRequestedModel("r-override", "none", null);
    expect(levels(resolution)).toEqual(["sol:low", "thinker:none", "budget:-"]);

    // No effort sent -> the pinned levels.
    resolution = await resolveRequestedModel("r-override", undefined, null);
    expect(levels(resolution)).toEqual(["sol:high", "thinker:high", "budget:max"]);

    const { res, payload } = await chat({ model: "r-override", reasoning_effort: "minimal" });
    expect(res.status).toBe(200);
    expect(payload.reasoning_effort).toBe("low");
    expect(lastLoggedVariant()).toBe("low");

    const responses = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ model: "r-override", input: "Hi", reasoning: { effort: "medium" } }),
    });
    expect(responses.status).toBe(200);
    expect(payloads.at(-1)!.reasoning_effort).toBe("medium");
  });

  test("setting on: a name that isn't a reasoning level is a 400", async () => {
    const { res } = await chat({ model: "r-override", reasoning_effort: "turbo" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as OpenAIErrorBody).error.code).toBe("variant_not_found");
  });

  test("a pinned none on a target without none is mapped instead of failing over", async () => {
    const { res, payload } = await chat({ model: "r-sol-none" });
    expect(res.status).toBe(200);
    expect(payloads).toHaveLength(1);
    expect(payload.reasoning_effort).toBe("low");
    expect(lastLoggedVariant()).toBe("low");
  });
});

test("migration: existing aliases get the setting off", () => {
  const dir = mkdtempSync(join(tmpdir(), "alias-migration-"));
  try {
    const dbPath = join(dir, "old.db");
    const old = new Database(dbPath, { create: true });
    old.exec(`
      CREATE TABLE model_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT NOT NULL UNIQUE, mode TEXT NOT NULL DEFAULT 'priority', created_at TEXT NOT NULL DEFAULT 'then');
      CREATE TABLE model_alias_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, alias_id INTEGER NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, variant TEXT NOT NULL, position INTEGER NOT NULL);
      INSERT INTO model_aliases (alias) VALUES ('old-alias');
      INSERT INTO model_alias_targets (alias_id, provider_id, model_id, variant, position) VALUES (1, 'openai', 'gpt-5.6-luna', 'none', 0);
    `);
    old.close();
    const script = 'const { listAliases } = await import("./src/db/modelAliases"); console.log(JSON.stringify(listAliases()));';
    // Twice: the migration must be idempotent.
    for (let run = 0; run < 2; run++) {
      const proc = Bun.spawnSync(["bun", "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DB_PATH: dbPath } });
      expect(proc.exitCode).toBe(0);
      expect(JSON.parse(proc.stdout.toString())).toMatchObject([{ alias: "old-alias", clientEffortOverrides: false }]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
