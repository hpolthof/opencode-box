// ADMIN_PASSWORD / ADMIN_SESSION_SECRET / DB_PATH are supplied via the local,
// untracked .env file (Bun auto-loads it) - see admin.smoke.test.ts.
//
// These run with no provider configured, so the model catalog is empty:
// they cover the DB layer, the admin page with nothing to alias, and the
// resolver branches that don't need a model to be available (the
// allowedModels gate, an alias whose targets are all unavailable). The
// happy path - alias -> model + pinned level, failover across targets,
// through /v1/chat/completions and /v1/responses - is in catalog.test.ts,
// against fake providers.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAlias, deleteAlias, findAliasByName, listAliases, updateAlias } from "../src/db/modelAliases";
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

  test("updateAlias replaces name, mode, options and targets", () => {
    const record = createAlias("alias-db-test-upd", "priority", [{ providerID: "openai", modelID: "a", variant: "low" }]);
    const targets = [
      { providerID: "openai", modelID: "b", variant: "high" },
      { providerID: "anthropic", modelID: "c", variant: "medium" },
    ];
    expect(updateAlias(record.id, "alias-db-test-upd2", "random", targets, { clientEffortOverrides: true })).toBe(true);
    expect(findAliasByName("alias-db-test-upd")).toBeNull();
    expect(findAliasByName("alias-db-test-upd2")).toMatchObject({ id: record.id, mode: "random", clientEffortOverrides: true, targets });
    expect(updateAlias(999999, "x", "priority", targets)).toBe(false);
    expect(() => updateAlias(record.id, "alias-db-test-upd2", "priority", [])).toThrow();
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

describe("admin /admin/aliases (no provider configured)", () => {
  test("GET renders with nothing to alias yet", async () => {
    const cookie = await loginCookie();
    const res = await adminApp.request("/admin/aliases", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("nothing to alias yet");
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

describe("admin alias editing (no provider configured)", () => {
  async function edit(id: number, fields: Record<string, string>) {
    const cookie = await loginCookie();
    return adminApp.request(`/admin/aliases/${id}/edit`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  }

  test("an unchanged (currently unavailable) target is kept, so renaming works", async () => {
    const record = createAlias("alias-edit-test", "priority", [{ providerID: "openai", modelID: "gpt-x", variant: "high" }]);
    const res = await edit(record.id, { name: "alias-edit-renamed", mode: "random", targetModel: "openai/gpt-x", targetVariant: "high" });
    expect(res.status).toBe(302);
    expect(findAliasByName("alias-edit-renamed")).toMatchObject({ id: record.id, mode: "random", targets: record.targets });
  });

  test("a changed target that is not available is rejected and nothing changes", async () => {
    const record = createAlias("alias-edit-test2", "priority", [{ providerID: "openai", modelID: "gpt-x", variant: "high" }]);
    const res = await edit(record.id, { name: "alias-edit-test2", mode: "priority", targetModel: "openai/gpt-y", targetVariant: "high" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("has reasoning variants available");
    expect(findAliasByName("alias-edit-test2")!.targets[0]!.modelID).toBe("gpt-x");
  });

  test("editing an unknown alias is a 404", async () => {
    expect((await edit(999999, { name: "x", targetModel: "a/b", targetVariant: "c" })).status).toBe(404);
  });
});

describe("v1Router alias resolution (no provider configured)", () => {
  test("a key not allowed to use an existing alias is blocked with 403", async () => {
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

  test("an alias whose targets are all unavailable fails gracefully (502)", async () => {
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

  test("GET /v1/models lists aliases even with no models available", async () => {
    const { rawKey } = createKey("alias-models-degraded-key");
    const res = await v1App.request("/v1/models", { headers: { authorization: `Bearer ${rawKey}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; owned_by: string }[] };
    expect(body.data.find((m) => m.id === "alias-gate-test")?.owned_by).toBe("alias");
  });
});
