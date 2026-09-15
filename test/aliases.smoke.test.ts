// ADMIN_PASSWORD / ADMIN_SESSION_SECRET / DB_PATH are supplied via the local,
// untracked .env file (Bun auto-loads it) - see admin.smoke.test.ts.
//
// Like the rest of the v1/admin smoke tests, this deliberately avoids
// needing a live OpenCode server (see v1.smoke.test.ts's comments) - so it
// only covers the parts of alias resolution that don't require
// `listModels()` to succeed: the DB layer itself, the admin page's
// degraded "OpenCode unreachable" rendering, and the resolver branches that
// return before ever calling `listModels()` (the allowedModels gate) or
// that go on to call it and are expected to fail gracefully without a live
// server. The full happy path (alias -> real model + pinned variant,
// multi-target priority/random ordering, and failover on error/timeout,
// end to end through POST /v1/chat/completions and /v1/responses calls)
// was verified manually against a stand-in OpenCode server during
// development.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAlias, deleteAlias, findAliasByName, listAliases } from "../src/db/modelAliases";
import { createKey } from "../src/db/apiKeys";
import { adminRouter } from "../src/routes/admin/index";
import { v1Router } from "../src/routes/v1";

const adminApp = new Hono().route("/admin", adminRouter);
const v1App = new Hono().route("/v1", v1Router);

describe("db/modelAliases", () => {
  test("create, find, list and delete round-trip (single target)", () => {
    const record = createAlias("alias-db-test-1", "priority", [{ providerID: "openai", modelID: "gpt-5.6-luna", variant: "xhigh" }]);
    expect(record.alias).toBe("alias-db-test-1");
    expect(record.mode).toBe("priority");
    expect(record.targets).toEqual([{ providerID: "openai", modelID: "gpt-5.6-luna", variant: "xhigh" }]);

    expect(findAliasByName("alias-db-test-1")).toEqual(record);
    expect(findAliasByName("does-not-exist")).toBeNull();
    expect(listAliases().some((a) => a.alias === "alias-db-test-1")).toBe(true);

    deleteAlias(record.id);
    expect(findAliasByName("alias-db-test-1")).toBeNull();
  });

  test("multi-target aliases preserve target order by position", () => {
    const targets = [
      { providerID: "openai", modelID: "gpt-5.6-luna", variant: "xhigh" },
      { providerID: "openai", modelID: "gpt-5.1", variant: "high" },
      { providerID: "anthropic", modelID: "claude-z", variant: "medium" },
    ];
    const record = createAlias("alias-db-test-multi", "random", targets);
    expect(record.mode).toBe("random");
    expect(record.targets).toEqual(targets);
    expect(findAliasByName("alias-db-test-multi")!.targets).toEqual(targets);
  });

  test("creating with zero targets throws", () => {
    expect(() => createAlias("alias-db-test-empty", "priority", [])).toThrow();
  });

  test("alias names must be unique", () => {
    createAlias("alias-db-test-unique", "priority", [{ providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" }]);
    expect(() =>
      createAlias("alias-db-test-unique", "priority", [{ providerID: "openai", modelID: "gpt-5.1", variant: "low" }])
    ).toThrow();
  });
});

async function loginCookie(): Promise<string> {
  const { CONFIG } = await import("../src/config");
  const res = await adminApp.request("/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=" + CONFIG.adminPassword,
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

describe("admin /admin/aliases (no live OpenCode)", () => {
  test("GET renders the unreachable state instead of crashing", async () => {
    const cookie = await loginCookie();
    const res = await adminApp.request("/admin/aliases", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OpenCode is not reachable");
  });

  test("POST fails gracefully (no model can ever be picked) instead of crashing", async () => {
    const cookie = await loginCookie();
    const res = await adminApp.request("/admin/aliases", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "alias-unreachable",
        mode: "priority",
        targetModel: "openai/gpt-5.6-luna",
        targetVariant: "xhigh",
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(findAliasByName("alias-unreachable")).toBeNull();
  });
});

describe("v1Router alias resolution (no live OpenCode)", () => {
  test("a key not allowed to use an existing alias is blocked with 403 before any OpenCode call", async () => {
    createAlias("alias-gate-test", "priority", [{ providerID: "openai", modelID: "gpt-5.6-luna", variant: "xhigh" }]);
    const { rawKey } = createKey("alias-gate-test-key", ["some-other-model"]);

    const res = await v1App.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "alias-gate-test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("model_not_allowed");
  });

  test("an existing alias for an unrestricted key fails gracefully (502) without a live OpenCode server", async () => {
    createAlias("alias-degraded-test", "priority", [{ providerID: "openai", modelID: "gpt-5.6-luna", variant: "xhigh" }]);
    const { rawKey } = createKey("alias-degraded-test-key");

    const res = await v1App.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "alias-degraded-test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(502);
  });

  test("a non-alias, invalid model id still 400s exactly as before (alias lookup doesn't change the plain-model path)", async () => {
    const { rawKey } = createKey("alias-passthrough-test-key");
    const res = await v1App.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "not-a-valid-model-id", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /v1/models still degrades to 502 without a live OpenCode server (aliases never reached)", async () => {
    const { rawKey } = createKey("alias-models-degraded-key");
    const res = await v1App.request("/v1/models", { headers: { authorization: `Bearer ${rawKey}` } });
    expect(res.status).toBe(502);
  });
});
