import { Hono, type Context } from "hono";
import type { AuthType } from "@earendil-works/pi-ai";
import { answerLogin, cancelLogin, getLogin, LoginNotSupportedError, logoutProvider, startLogin } from "../../piai/login";
import { getCustomProvider } from "../../db/customProviders";
import { CustomProviderError, discoverModels, formatModelLines, parseCustomProviderInput, type CustomProviderInput } from "../../piai/customProviders";
import { addCustomProvider, editCustomProvider, listPiProviders, removeCustomProvider, type PiProviderStatus } from "../../piai/models";
import { ProviderLogin } from "../../views/providerLogin";
import { Providers, type CustomFormState } from "../../views/providers";

export const providersRouter = new Hono();

async function renderProviders(c: Context, flash?: { tone: "success" | "error"; message: string }, form?: CustomFormState, status: 200 | 400 = 200) {
  let providers: PiProviderStatus[] = [];
  let loadError = false;
  try {
    providers = await listPiProviders();
  } catch (err) {
    console.error("[routes/admin/providers] failed to list providers:", err);
    loadError = true;
  }
  const signedOut = c.req.query("signed_out");
  const added = c.req.query("custom");
  flash ??= signedOut
    ? { tone: "success", message: `Removed the credentials for ${signedOut}.` }
    : added
      ? { tone: "success", message: `Saved custom provider ${added}.` }
      : undefined;
  return c.html(Providers({ providers, loadError, flash, form }) as string, status);
}

providersRouter.get("/providers", (c) => renderProviders(c));

async function readCustomForm(c: Context): Promise<CustomProviderInput> {
  const body = await c.req.parseBody();
  const field = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
  return { id: field("id"), name: field("name"), baseUrl: field("baseUrl"), apiKey: field("apiKey"), models: field("models") };
}

/** Fetches the model list of an endpoint (a blank key falls back to the stored key of `providerId`) as form text. */
providersRouter.post("/providers/custom/fetch-models", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { baseUrl?: unknown; apiKey?: unknown; providerId?: unknown } | null;
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
  if (!/^https?:\/\//.test(baseUrl)) return c.json({ error: "Enter a valid http(s) base URL first." }, 400);
  const typedKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const stored = typeof body?.providerId === "string" ? getCustomProvider(body.providerId)?.apiKey ?? null : null;
  try {
    return c.json({ models: formatModelLines(await discoverModels(baseUrl, typedKey || stored)) });
  } catch (err) {
    if (!(err instanceof CustomProviderError)) throw err;
    return c.json({ error: err.message }, 502);
  }
});

function toFormState(mode: "add" | "edit", form: CustomProviderInput): CustomFormState {
  return { mode, id: form.id, name: form.name, baseUrl: form.baseUrl, models: form.models };
}

/** Add a custom OpenAI-compatible endpoint. */
providersRouter.post("/providers/custom", async (c) => {
  const form = await readCustomForm(c);
  try {
    const record = parseCustomProviderInput(form);
    addCustomProvider(record);
    return c.redirect(`/admin/providers?custom=${encodeURIComponent(record.id)}`, 302);
  } catch (err) {
    if (!(err instanceof CustomProviderError)) throw err;
    return renderProviders(c, { tone: "error", message: err.message }, toFormState("add", form), 400);
  }
});

/** Edit a custom endpoint; a blank API key keeps the current one. */
providersRouter.post("/providers/custom/:providerId/edit", async (c) => {
  const id = c.req.param("providerId");
  const existing = getCustomProvider(id);
  if (!existing) return c.text("Unknown custom provider", 404);
  const form = await readCustomForm(c);
  try {
    editCustomProvider(parseCustomProviderInput({ ...form, id }, existing.apiKey));
    return c.redirect(`/admin/providers?custom=${encodeURIComponent(id)}`, 302);
  } catch (err) {
    if (!(err instanceof CustomProviderError)) throw err;
    return renderProviders(c, { tone: "error", message: err.message }, toFormState("edit", { ...form, id }), 400);
  }
});

providersRouter.post("/providers/custom/:providerId/delete", (c) => {
  const id = c.req.param("providerId");
  removeCustomProvider(id);
  return c.redirect(`/admin/providers?signed_out=${encodeURIComponent(id)}`, 302);
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
