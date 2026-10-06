import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRouter } from "../src/routes/admin/index";
import { findPiModel, listPiModels, removeCustomProvider } from "../src/piai/models";
import { CustomProviderError, parseCustomProviderInput } from "../src/piai/customProviders";

const app = new Hono().route("/admin", adminRouter);
let cookie: string;

async function post(path: string, fields: Record<string, string>) {
  return app.fetch(
    new Request(`http://localhost/admin${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams(fields).toString(),
    })
  );
}

beforeAll(async () => {
  const res = await app.fetch(
    new Request("http://localhost/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
    })
  );
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(() => {
  removeCustomProvider("srv-a");
  removeCustomProvider("srv-b");
});

describe("custom OpenAI-compatible providers", () => {
  test("input validation", () => {
    const ok = { id: "x", name: "", baseUrl: "http://h:1/v1/", apiKey: "", models: "a\nb\na" };
    expect(parseCustomProviderInput(ok)).toMatchObject({ id: "x", name: "x", baseUrl: "http://h:1/v1", apiKey: null, models: [{ id: "a", levels: [] }, { id: "b", levels: [] }] });
    expect(() => parseCustomProviderInput({ ...ok, id: "openai" })).toThrow(CustomProviderError);
    expect(() => parseCustomProviderInput({ ...ok, baseUrl: "ftp://x" })).toThrow(CustomProviderError);
    expect(() => parseCustomProviderInput({ ...ok, models: " " })).toThrow(CustomProviderError);
  });

  test("model lines carry reasoning levels into variants", async () => {
    expect(parseCustomProviderInput({ id: "x", name: "", baseUrl: "http://h", apiKey: "", models: "r | low, high, bogus\nplain" }).models).toEqual([
      { id: "r", levels: ["low", "high"] },
      { id: "plain", levels: [] },
    ]);
    await post("/providers/custom", { id: "srv-b", name: "", baseUrl: "http://127.0.0.1:1", apiKey: "", models: "r | low,high\nplain" });
    expect((await findPiModel("srv-b/r"))?.variants).toEqual(["none", "low", "high"]);
    expect((await findPiModel("srv-b/plain"))?.variants).toEqual([]);
    removeCustomProvider("srv-b");
  });

  test("fetches models and their reasoning levels from /models", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.headers.get("authorization") !== "Bearer k") return new Response("no", { status: 401 });
        return Response.json({
          data: [
            { id: "plain" },
            { id: "thinker", supported_parameters: ["reasoning", "tools"] },
            { id: "custom-levels", reasoning_efforts: ["low", "xhigh"] },
          ],
        });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const call = (body: object) =>
        app.fetch(new Request("http://localhost/admin/providers/custom/fetch-models", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
      const ok = await call({ baseUrl: url, apiKey: "k" });
      expect(((await ok.json()) as { models: string }).models).toBe("plain\nthinker | low,medium,high\ncustom-levels | low,xhigh");
      expect((await call({ baseUrl: url, apiKey: "" })).status).toBe(502);
    } finally {
      server.stop(true);
    }
  });

  test("several endpoints can be added; their models become available and removable", async () => {
    for (const id of ["srv-a", "srv-b"]) {
      const res = await post("/providers/custom", { id, name: id, baseUrl: `http://127.0.0.1:1/${id}`, apiKey: "k", models: "m1\nm2" });
      expect(res.status).toBe(302);
    }
    expect((await findPiModel("srv-a/m1"))?.model.baseUrl).toBe("http://127.0.0.1:1/srv-a");
    expect(await findPiModel("srv-b/m2")).not.toBeNull();
    expect((await listPiModels()).filter((m) => m.id.startsWith("srv-"))).toHaveLength(4);

    const dup = await post("/providers/custom", { id: "srv-a", name: "", baseUrl: "http://x", apiKey: "", models: "m" });
    expect(dup.status).toBe(400);

    const page = await app.fetch(new Request("http://localhost/admin/providers", { headers: { cookie } }));
    expect(await page.text()).toContain("srv-b");

    await post("/providers/custom/srv-a/delete", {});
    expect(await findPiModel("srv-a/m1")).toBeNull();
    expect(await findPiModel("srv-b/m1")).not.toBeNull();
  });
});
