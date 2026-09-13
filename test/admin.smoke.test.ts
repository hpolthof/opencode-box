// ADMIN_PASSWORD / ADMIN_SESSION_SECRET / DB_PATH are supplied via the local,
// untracked .env file (Bun auto-loads it). They can't be set here with
// `process.env.X = ...` because ES module imports are hoisted above any
// top-level statements, so config.ts would already have been evaluated.
import { describe, expect, test, afterAll } from "bun:test";
import { Hono } from "hono";
import { unlinkSync } from "node:fs";
import { adminRouter } from "../src/routes/admin/index";

const app = new Hono();
app.route("/admin", adminRouter);

function getCookieFromResponse(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no set-cookie header");
  return setCookie.split(";")[0]!;
}

describe("admin dashboard", () => {
  afterAll(() => {
    try {
      unlinkSync("./data/admin-smoke-test.sqlite");
      unlinkSync("./data/admin-smoke-test.sqlite-shm");
      unlinkSync("./data/admin-smoke-test.sqlite-wal");
    } catch {}
  });

  test("GET /admin without a cookie redirects to /admin/login", async () => {
    const res = await app.fetch(new Request("http://localhost/admin", { redirect: "manual" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  test("GET /admin/login is publicly accessible", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/login"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Admin password");
  });

  test("POST /admin/login with wrong password re-renders with error, no cookie", async () => {
    const form = new URLSearchParams({ password: "wrong" });
    const res = await app.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      })
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const text = await res.text();
    expect(text).toContain("Incorrect password");
  });

  test("POST /admin/login with correct password sets a cookie and redirects to /admin", async () => {
    const form = new URLSearchParams({ password: "test-password" });
    const res = await app.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "manual",
      })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin");
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
  });

  test("GET /admin with a valid session cookie renders the dashboard", async () => {
    const loginRes = await app.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "test-password" }).toString(),
        redirect: "manual",
      })
    );
    const cookie = getCookieFromResponse(loginRes);

    const res = await app.fetch(
      new Request("http://localhost/admin", { headers: { cookie } })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Dashboard");
  });

  test("GET /admin/keys without a cookie redirects to login", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/keys", { redirect: "manual" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  test("POST /admin/keys with a valid session creates a key and shows the raw key once", async () => {
    const loginRes = await app.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "test-password" }).toString(),
        redirect: "manual",
      })
    );
    const cookie = getCookieFromResponse(loginRes);

    const res = await app.fetch(
      new Request("http://localhost/admin/keys", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ name: "my-test-key", allowedModels: "" }).toString(),
      })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("sk-ob-");
    expect(text).toContain("my-test-key");
  });

  test("GET /admin/logout clears the cookie and redirects to login", async () => {
    const res = await app.fetch(new Request("http://localhost/admin/logout", { redirect: "manual" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  test("GET /admin/providers renders the unreachable banner when OpenCode is not running", async () => {
    const loginRes = await app.fetch(
      new Request("http://localhost/admin/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "test-password" }).toString(),
        redirect: "manual",
      })
    );
    const cookie = getCookieFromResponse(loginRes);

    const res = await app.fetch(new Request("http://localhost/admin/providers", { headers: { cookie } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("OpenCode is not reachable");
  });
});
