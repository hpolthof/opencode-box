import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createModels, createProvider, type Model, type OAuthCredential } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Hono } from "hono";
import { SqliteCredentialStore } from "../src/db/piCredentials";
import { findPiModel, setPiModelsForTesting } from "../src/piai/models";
import type { LoginSnapshot } from "../src/piai/login";
import { adminRouter } from "../src/routes/admin/index";

const app = new Hono().route("/admin", adminRouter);
let cookie: string;
const store = new SqliteCredentialStore();

// A provider whose OAuth flow looks like Anthropic's from the outside: it
// announces an auth URL, then waits for the pasted code.
const model: Model<"openai-completions"> = {
  id: "m",
  name: "m",
  api: "openai-completions",
  provider: "fakeoauth",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};
const fakeOAuthProvider = createProvider({
  id: "fakeoauth",
  name: "Fake OAuth",
  auth: {
    oauth: {
      name: "Fake (subscription)",
      async login(interaction) {
        interaction.notify({ type: "auth_url", url: "https://example.com/authorize?state=1", instructions: "Paste the code." });
        const code = await interaction.prompt({ type: "manual_code", message: "Paste the code", placeholder: "code" });
        if (code !== "good-code") throw new Error("Invalid authorization code");
        interaction.notify({ type: "progress", message: "Exchanging code..." });
        return { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3_600_000 };
      },
      async refresh(credential: OAuthCredential) {
        return credential;
      },
      async toAuth(credential: OAuthCredential) {
        return { apiKey: credential.access };
      },
    },
  },
  models: [model],
  api: openAICompletionsApi(),
});

beforeAll(async () => {
  const models = createModels({ credentials: store });
  models.setProvider(fakeOAuthProvider);
  setPiModelsForTesting(models, store);
  await store.delete("fakeoauth");

  const res = await app.request("/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD ?? "" }).toString(),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(() => setPiModelsForTesting(null));

function admin(path: string, init: RequestInit = {}) {
  return app.request(path, { ...init, headers: { ...(init.headers ?? {}), cookie } });
}

async function startLogin(): Promise<string> {
  const res = await admin("/admin/providers/pi/fakeoauth/login", { method: "POST" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  expect(location).toMatch(/^\/admin\/providers\/pi\/login\/[0-9a-f-]+$/);
  return location;
}

async function waitForState(base: string, until: (s: LoginSnapshot) => boolean): Promise<LoginSnapshot> {
  for (let i = 0; i < 100; i++) {
    const state = (await (await admin(`${base}/state`)).json()) as LoginSnapshot;
    if (until(state)) return state;
    await Bun.sleep(10);
  }
  throw new Error("login state never reached the expected condition");
}

function answer(base: string, promptId: string, value: string) {
  return admin(`${base}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ promptId, value }),
  });
}

describe("pi-ai OAuth login from the dashboard", () => {
  test("providers page lists the pi provider with its sign-in button", async () => {
    const html = await (await admin("/admin/providers")).text();
    expect(html).toContain("pi-ai providers");
    expect(html).toContain("/admin/providers/pi/fakeoauth/login");
    expect(html).toContain("Fake (subscription)");
    expect(html).toContain("not configured");
  });

  test("full flow: auth URL, pasted code, credential stored, models available", async () => {
    expect(await findPiModel("pi/fakeoauth/m")).toBeNull();
    const base = await startLogin();

    const page = await (await admin(base)).text();
    expect(page).toContain(`data-base="${base}"`);

    const waiting = await waitForState(base, (s) => s.prompt !== null);
    expect(waiting.status).toBe("running");
    expect(waiting.events[0]).toEqual({ type: "auth_url", url: "https://example.com/authorize?state=1", instructions: "Paste the code." });
    expect(waiting.prompt).toMatchObject({ type: "manual_code", message: "Paste the code", placeholder: "code" });

    // A stale prompt id is rejected and leaves the prompt open.
    expect((await answer(base, "not-the-prompt", "good-code")).status).toBe(409);

    expect((await answer(base, waiting.prompt!.id, "good-code")).status).toBe(200);
    const done = await waitForState(base, (s) => s.status !== "running");
    expect(done.status).toBe("succeeded");
    expect(done.prompt).toBeNull();

    expect(await store.read("fakeoauth")).toMatchObject({ type: "oauth", access: "access-token", refresh: "refresh-token" });
    expect(await findPiModel("pi/fakeoauth/m")).not.toBeNull();

    const html = await (await admin("/admin/providers")).text();
    expect(html).toContain("signed in");
    expect(html).toContain("/admin/providers/pi/fakeoauth/logout");
  });

  test("sign out removes the stored credential", async () => {
    const res = await admin("/admin/providers/pi/fakeoauth/logout", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/providers?signed_out=fakeoauth");
    expect(await store.read("fakeoauth")).toBeUndefined();
    expect(await findPiModel("pi/fakeoauth/m")).toBeNull();
  });

  test("a wrong code fails the login with the provider's message", async () => {
    const base = await startLogin();
    const waiting = await waitForState(base, (s) => s.prompt !== null);
    await answer(base, waiting.prompt!.id, "bad-code");
    const done = await waitForState(base, (s) => s.status !== "running");
    expect(done.status).toBe("failed");
    expect(done.error).toContain("Invalid authorization code");
    expect(await store.read("fakeoauth")).toBeUndefined();
  });

  test("cancel ends a running login", async () => {
    const base = await startLogin();
    await waitForState(base, (s) => s.prompt !== null);
    const res = await admin(`${base}/cancel`, { method: "POST" });
    expect(res.status).toBe(302);
    const done = await waitForState(base, (s) => s.status !== "running");
    expect(done.status).toBe("cancelled");
    expect(done.prompt).toBeNull();
  });

  test("login for a provider without OAuth -> 404; unknown session -> 404 state", async () => {
    expect((await admin("/admin/providers/pi/nope/login", { method: "POST" })).status).toBe(404);
    expect((await admin("/admin/providers/pi/login/unknown/state")).status).toBe(404);
  });

  test("login routes require an admin session", async () => {
    const res = await app.request("/admin/providers/pi/fakeoauth/login", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
  });
});

describe("SqliteCredentialStore", () => {
  test("modify returning undefined keeps the current credential", async () => {
    await store.modify("keep-test", async () => ({ type: "api_key", key: "k1" }));
    const result = await store.modify("keep-test", async () => undefined);
    expect(result).toEqual({ type: "api_key", key: "k1" });
    expect(await store.read("keep-test")).toEqual({ type: "api_key", key: "k1" });
    expect((await store.list()).some((c) => c.providerId === "keep-test" && c.type === "api_key")).toBe(true);
    await store.delete("keep-test");
    expect(await store.read("keep-test")).toBeUndefined();
  });

  test("concurrent modifies for one provider are serialized", async () => {
    await store.modify("count", async () => ({ type: "api_key", key: "0" }));
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.modify("count", async (current) => {
          const n = Number((current as { key: string }).key);
          await Bun.sleep(1);
          return { type: "api_key", key: String(n + 1) };
        })
      )
    );
    expect(await store.read("count")).toEqual({ type: "api_key", key: "10" });
    await store.delete("count");
  });
});
