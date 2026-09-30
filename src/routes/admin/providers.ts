import { Hono, type Context } from "hono";
import type { AuthType } from "@earendil-works/pi-ai";
import { answerLogin, cancelLogin, getLogin, LoginNotSupportedError, logoutProvider, startLogin } from "../../piai/login";
import { listPiProviders, type PiProviderStatus } from "../../piai/models";
import { ProviderLogin } from "../../views/providerLogin";
import { Providers } from "../../views/providers";

export const providersRouter = new Hono();

providersRouter.get("/providers", async (c) => {
  let providers: PiProviderStatus[] = [];
  let loadError = false;
  try {
    providers = await listPiProviders();
  } catch (err) {
    console.error("[routes/admin/providers] failed to list providers:", err);
    loadError = true;
  }
  const signedOut = c.req.query("signed_out");
  const flash = signedOut ? { tone: "success" as const, message: `Removed the credentials for ${signedOut}.` } : undefined;
  return c.html(Providers({ providers, loadError, flash }) as string);
});

function begin(type: AuthType) {
  return (c: Context) => {
    try {
      const login = startLogin(c.req.param("providerId") ?? "", type);
      return c.redirect(`/admin/providers/sessions/${login.id}`, 302);
    } catch (err) {
      if (err instanceof LoginNotSupportedError) return c.text(err.message, 404);
      throw err;
    }
  };
}

/** OAuth sign-in (subscription accounts). */
providersRouter.post("/providers/:providerId/login", begin("oauth"));
/** Enter an API key - runs pi-ai's API-key login, which asks for the key as a secret prompt. */
providersRouter.post("/providers/:providerId/api-key", begin("api_key"));

providersRouter.post("/providers/:providerId/logout", async (c) => {
  const providerId = c.req.param("providerId");
  await logoutProvider(providerId);
  return c.redirect(`/admin/providers?signed_out=${encodeURIComponent(providerId)}`, 302);
});

providersRouter.get("/providers/sessions/:sessionId", (c) => {
  const login = getLogin(c.req.param("sessionId"));
  if (!login) return c.redirect("/admin/providers", 302);
  return c.html(ProviderLogin({ sessionId: login.id, providerId: login.providerId, type: login.type }) as string);
});

providersRouter.get("/providers/sessions/:sessionId/state", (c) => {
  const login = getLogin(c.req.param("sessionId"));
  if (!login) return c.json({ error: "Unknown or expired sign-in session" }, 404);
  return c.json(login);
});

providersRouter.post("/providers/sessions/:sessionId/answer", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { promptId?: unknown; value?: unknown } | null;
  if (!body || typeof body.promptId !== "string" || typeof body.value !== "string") {
    return c.json({ error: "Expected { promptId, value }" }, 400);
  }
  const accepted = answerLogin(c.req.param("sessionId"), body.promptId, body.value);
  return c.json({ accepted }, accepted ? 200 : 409);
});

providersRouter.post("/providers/sessions/:sessionId/cancel", (c) => {
  cancelLogin(c.req.param("sessionId"));
  return c.redirect("/admin/providers", 302);
});
