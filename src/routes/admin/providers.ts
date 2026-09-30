import { Hono } from "hono";
import { listProviders } from "../../opencode/client";
import { answerLogin, cancelLogin, getLogin, LoginNotSupportedError, logoutProvider, startLogin } from "../../piai/login";
import { listPiProviders, type PiProviderStatus } from "../../piai/models";
import { PiLogin } from "../../views/piLogin";
import { Providers } from "../../views/providers";

export const providersRouter = new Hono();

providersRouter.get("/providers", async (c) => {
  const piProviders: PiProviderStatus[] = await listPiProviders().catch((err) => {
    console.error("[routes/admin/providers] failed to list pi-ai providers:", err);
    return [];
  });
  const signedOut = c.req.query("signed_out");
  const flash = signedOut ? { tone: "success" as const, message: `Signed out of ${signedOut}.` } : undefined;
  try {
    const providers = await listProviders();
    return c.html(Providers({ providers, piProviders, flash }) as string);
  } catch {
    return c.html(Providers({ unreachable: true, piProviders, flash }) as string);
  }
});

// --- pi-ai OAuth login (experimental backend, see src/piai) ----------------

providersRouter.post("/providers/pi/:providerId/login", (c) => {
  try {
    const login = startLogin(c.req.param("providerId"));
    return c.redirect(`/admin/providers/pi/login/${login.id}`, 302);
  } catch (err) {
    if (err instanceof LoginNotSupportedError) return c.text(err.message, 404);
    throw err;
  }
});

providersRouter.post("/providers/pi/:providerId/logout", async (c) => {
  const providerId = c.req.param("providerId");
  await logoutProvider(providerId);
  return c.redirect(`/admin/providers?signed_out=${encodeURIComponent(providerId)}`, 302);
});

providersRouter.get("/providers/pi/login/:sessionId", (c) => {
  const login = getLogin(c.req.param("sessionId"));
  if (!login) return c.redirect("/admin/providers", 302);
  return c.html(PiLogin({ sessionId: login.id, providerId: login.providerId }) as string);
});

providersRouter.get("/providers/pi/login/:sessionId/state", (c) => {
  const login = getLogin(c.req.param("sessionId"));
  if (!login) return c.json({ error: "Unknown or expired sign-in session" }, 404);
  return c.json(login);
});

providersRouter.post("/providers/pi/login/:sessionId/answer", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { promptId?: unknown; value?: unknown } | null;
  if (!body || typeof body.promptId !== "string" || typeof body.value !== "string") {
    return c.json({ error: "Expected { promptId, value }" }, 400);
  }
  const accepted = answerLogin(c.req.param("sessionId"), body.promptId, body.value);
  return c.json({ accepted }, accepted ? 200 : 409);
});

providersRouter.post("/providers/pi/login/:sessionId/cancel", (c) => {
  cancelLogin(c.req.param("sessionId"));
  return c.redirect("/admin/providers", 302);
});
