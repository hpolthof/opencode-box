import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, createProvider, fauxAssistantMessage, fauxProvider, fauxText, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Hono } from "hono";
import { listCatalogModels } from "../src/catalog";
import { db } from "../src/db/client";
import { createAlias, findAliasByName, listAliases } from "../src/db/modelAliases";
import { parseModelId } from "../src/openai/translate";
import type { ChatCompletionResponse, OpenAIErrorBody } from "../src/openai/types";
import { setPiModelsForTesting } from "../src/piai/models";
import { adminRouter } from "../src/routes/admin/index";
import { v1Router } from "../src/routes/v1";

const app = new Hono().route("/v1", v1Router).route("/admin", adminRouter);
let authHeader: string;
let adminCookie: string;

const faux = fauxProvider({ provider: "faux", models: [{ id: "thinker", reasoning: true }] });

// Available (has auth) but its endpoint refuses connections, so every
// request to it fails - used as the first target of a failover alias.
const brokenModel: Model<"openai-completions"> = {
  id: "broken",
  name: "broken",
  api: "openai-completions",
  provider: "broken",
  baseUrl: "http://127.0.0.1:9/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

let thinkerVariant: string;

beforeAll(async () => {
  const models = createModels();
  models.setProvider(faux.provider);
  models.setProvider(
    createProvider({
      id: "broken",
      name: "broken",
      baseUrl: brokenModel.baseUrl,
      auth: { apiKey: { name: "broken", resolve: async () => ({ auth: { apiKey: "x" } }) } },
      models: [brokenModel],
      api: openAICompletionsApi(),
    })
  );
  setPiModelsForTesting(models);

  const { createKey } = await import("../src/db/apiKeys");
  authHeader = `Bearer ${createKey("pi-catalog-test").rawKey}`;
  const login = await app.request("/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD ?? "" }).toString(),
  });
  adminCookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const thinker = (await listCatalogModels()).find((m) => m.id === "faux/thinker")!;
  thinkerVariant = thinker.variants![0]!;
});

afterAll(() => setPiModelsForTesting(null));

function chat(body: object) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
}

describe("model catalog", () => {
  test("models of configured providers are listed with provider/model ids", async () => {
    const models = await listCatalogModels();
    const thinker = models.find((m) => m.id === "faux/thinker");
    expect(thinker).toMatchObject({ providerID: "faux", modelID: "thinker", reasoning: true });
    expect(thinker!.variants!.length).toBeGreaterThan(0);
  });

  test("GET /v1/models lists them, owned by their provider", async () => {
    const res = await app.request("/v1/models", { headers: { Authorization: authHeader } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; owned_by: string }[] };
    expect(body.data.find((m) => m.id === "faux/thinker")?.owned_by).toBe("faux");
  });

  test("admin Models, Keys, Aliases and Playground pages offer them", async () => {
    for (const page of ["/admin/models", "/admin/keys", "/admin/aliases", "/admin/playground"]) {
      const html = await (await app.request(page, { headers: { cookie: adminCookie } })).text();
      expect(html).toContain("faux/thinker");
    }
  });

  test('the alias form saves "client effort overrides the pinned level" and the list shows it', async () => {
    const create = (name: string, overrides: boolean) => {
      const form = new URLSearchParams({ name, mode: "priority", targetModel: "faux/thinker", targetVariant: thinkerVariant });
      if (overrides) form.set("clientEffortOverrides", "1");
      return app.request("/admin/aliases", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: adminCookie },
        body: form.toString(),
        redirect: "manual",
      });
    };
    expect((await create("form-effort-on", true)).status).toBe(302);
    expect((await create("form-effort-off", false)).status).toBe(302);
    expect(findAliasByName("form-effort-on")?.clientEffortOverrides).toBe(true);
    expect(findAliasByName("form-effort-off")?.clientEffortOverrides).toBe(false);

    const html = await (await app.request("/admin/aliases", { headers: { cookie: adminCookie } })).text();
    expect(html).toContain('name="clientEffortOverrides"');
    // One indicator per alias with the setting on (other test files share the database).
    expect(html.match(/client effort overrides</g)).toHaveLength(listAliases().filter((a) => a.clientEffortOverrides).length);
  });
});

describe("routing targets", () => {
  test("an alias whose first target fails falls over to the next one", async () => {
    createAlias("pi-failover", "priority", [
      { providerID: "broken", modelID: "broken", variant: thinkerVariant },
      { providerID: "faux", modelID: "thinker", variant: thinkerVariant },
    ]);
    faux.setResponses([fauxAssistantMessage([fauxText("from the second target")])]);
    const res = await chat({ model: "pi-failover", messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatCompletionResponse;
    expect(body.model).toBe("pi-failover");
    expect(body.choices[0].message.content).toBe("from the second target");
  });

  test("served-by headers and log notes: which target and level answered (issue 4)", async () => {
    const lastLog = () =>
      db.query<{ model: string; variant: string | null; alias: string | null; notes: string | null }, []>(
        "SELECT model, variant, alias, notes FROM requests ORDER BY id DESC LIMIT 1"
      ).get()!;

    // Failover through an alias, non-streaming and streaming.
    for (const stream of [false, true]) {
      faux.setResponses([fauxAssistantMessage([fauxText("served")])]);
      const res = await chat({ model: "pi-failover", stream, messages: [{ role: "user", content: "Hi" }] });
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get("x-served-model")).toBe("faux/thinker");
      expect(res.headers.get("x-served-reasoning")).toBe(thinkerVariant);
      expect(res.headers.get("x-alias-target-index")).toBe("1");
      expect(res.headers.get("x-failover")).toBe("true");
      await Bun.sleep(5); // streaming logs once the stream is done
      expect(lastLog()).toMatchObject({ model: "faux/thinker", variant: thinkerVariant, alias: "pi-failover" });
      expect(lastLog().notes).toContain("failover: served by target 2 of 2");
    }

    // A client effort sent to an alias that pins its levels is flagged.
    faux.setResponses([fauxAssistantMessage([fauxText("pinned")])]);
    let res = await chat({ model: "pi-failover", reasoning_effort: "high", messages: [{ role: "user", content: "Hi" }] });
    await res.text();
    expect(res.headers.get("x-reasoning-overridden")).toBe("true");
    expect(lastLog().notes).toContain("client reasoning effort ignored");

    // A direct model: no alias headers, and the defaulted level is reported.
    faux.setResponses([fauxAssistantMessage([fauxText("direct")])]);
    res = await chat({ model: "faux/thinker", messages: [{ role: "user", content: "Hi" }] });
    await res.text();
    expect(res.headers.get("x-served-model")).toBe("faux/thinker");
    expect(res.headers.get("x-served-reasoning")).toBeTruthy();
    expect(res.headers.get("x-alias-target-index")).toBeNull();
    expect(res.headers.get("x-failover")).toBeNull();
    expect(lastLog()).toMatchObject({ alias: null, notes: null });
  });

  test("streaming through an alias", async () => {
    createAlias("pi-stream", "priority", [{ providerID: "faux", modelID: "thinker", variant: thinkerVariant }]);
    faux.setResponses([fauxAssistantMessage([fauxText("gestreamd antwoord")])]);
    const res = await chat({ model: "pi-stream", stream: true, messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(200);
    const text = (await res.text())
      .split("\n\n")
      .filter((f) => f.startsWith("data: {"))
      .map((f) => JSON.parse(f.slice(6)).choices[0]?.delta?.content ?? "")
      .join("");
    expect(text).toBe("gestreamd antwoord");
  });

  test("an alias whose only target fails -> 502 with the provider's error", async () => {
    createAlias("pi-broken-only", "priority", [{ providerID: "broken", modelID: "broken", variant: thinkerVariant }]);
    const res = await chat({ model: "pi-broken-only", messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(502);
  });

  test("a reasoning level the model doesn't support -> 400", async () => {
    const res = await chat({ model: "faux/thinker#no-such-level", messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as OpenAIErrorBody).error.code).toBe("variant_not_found");
  });

  test("/v1/responses: plain, streamed, and through a failover alias", async () => {
    const responses = (body: object) =>
      app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(body),
      });

    faux.setResponses([fauxAssistantMessage([fauxText("responses ok")])]);
    let res = await responses({ model: "faux/thinker", input: "Hi", instructions: "Be brief." });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: "response", status: "completed", output_text: "responses ok", instructions: "Be brief." });

    faux.setResponses([fauxAssistantMessage([fauxText("gestreamd")])]);
    res = await responses({ model: "faux/thinker", input: "Hi", stream: true });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = (await res.text())
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)));
    expect(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("")).toBe("gestreamd");
    expect(events.at(-1)).toMatchObject({ type: "response.completed", response: { output_text: "gestreamd" } });

    faux.setResponses([fauxAssistantMessage([fauxText("via alias")])]);
    res = await responses({ model: "pi-failover", input: "Hi" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { output_text: string }).output_text).toBe("via alias");
  });

  test("playground runs models, streaming and not", async () => {
    const run = (stream: boolean) =>
      app.request("/admin/playground/run", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ model: "faux/thinker", prompt: "Hi", stream }),
      });

    faux.setResponses([fauxAssistantMessage([fauxText("playground ok")])]);
    const res = await run(false);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe("playground ok");

    faux.setResponses([fauxAssistantMessage([fauxText("playground stream")])]);
    const frames = (await (await run(true)).text())
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)));
    expect(frames.filter((f) => f.type === "delta").map((f) => f.text).join("")).toBe("playground stream");
    expect(frames.at(-1)).toMatchObject({ type: "done", content: "playground stream" });
  });
});
