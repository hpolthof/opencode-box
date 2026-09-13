// ADMIN_PASSWORD / ADMIN_SESSION_SECRET / DB_PATH are supplied via the local,
// untracked .env file (Bun auto-loads it) - see admin.smoke.test.ts.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRouter } from "../src/routes/admin/index";

const app = new Hono();
app.route("/admin", adminRouter);

function getCookieFromResponse(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no set-cookie header");
  return setCookie.split(";")[0]!;
}

async function loginCookie(): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/admin/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-password" }).toString(),
      redirect: "manual",
    })
  );
  return getCookieFromResponse(res);
}

describe("admin playground", () => {
  test("GET /admin/playground renders the unreachable banner when OpenCode is not running", async () => {
    const cookie = await loginCookie();
    const res = await app.fetch(new Request("http://localhost/admin/playground", { headers: { cookie } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("OpenCode is not reachable");
  });

  test("POST /admin/playground/run without a cookie redirects to login", async () => {
    const res = await app.fetch(
      new Request("http://localhost/admin/playground/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.4", prompt: "hi" }),
        redirect: "manual",
      })
    );
    expect(res.status).toBe(302);
  });

  test("POST /admin/playground/run with an empty prompt -> 400", async () => {
    const cookie = await loginCookie();
    const res = await app.fetch(
      new Request("http://localhost/admin/playground/run", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ model: "openai/gpt-5.4", prompt: "   " }),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("prompt");
  });

  test("POST /admin/playground/run with an invalid model id -> 400", async () => {
    const cookie = await loginCookie();
    const res = await app.fetch(
      new Request("http://localhost/admin/playground/run", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ model: "not-a-valid-model-id", prompt: "hi" }),
      })
    );
    expect(res.status).toBe(400);
  });

  test("POST /admin/playground/run with a non-object responseFormat.schema -> 400", async () => {
    const cookie = await loginCookie();
    const res = await app.fetch(
      new Request("http://localhost/admin/playground/run", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          model: "openai/gpt-5.4",
          prompt: "hi",
          responseFormat: { type: "json_schema", schema: "not-an-object" },
        }),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("schema");
  });

  test("POST /admin/playground/run when OpenCode is unreachable -> 404 model lookup failure", async () => {
    const cookie = await loginCookie();
    const res = await app.fetch(
      new Request("http://localhost/admin/playground/run", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ model: "openai/gpt-5.4", prompt: "hi" }),
      })
    );
    // No live OpenCode server in this test env, so listModels() itself
    // throws before any model can ever be "matched" -> 502, not 404.
    expect(res.status).toBe(502);
  });
});
