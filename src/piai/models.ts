import { createModels, getSupportedThinkingLevels, type Api, type CredentialStore, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { deleteCustomProvider, getCustomProvider, insertCustomProvider, listCustomProviders, updateCustomProvider, type CustomModelSpec, type CustomProviderRecord } from "../db/customProviders";
import { SqliteCredentialStore } from "../db/piCredentials";
import { buildCustomProvider, CustomProviderError } from "./customProviders";

/**
 * The gateway's model backend: providers called in-process through pi-ai
 * (@earendil-works/pi-ai). Models are addressed as "<provider>/<model>",
 * e.g. "openai/gpt-5.6-luna" or "openrouter/anthropic/claude-sonnet-4.5"
 * (the model id itself may contain "/").
 */

let models: MutableModels | null = null;
let credentialStore: CredentialStore | null = null;

/**
 * OpenAI, Anthropic and OpenRouter. Credentials resolve from what was set
 * up in Admin > Providers (an API key or an OAuth sign-in, stored in
 * SQLite) first, then from the standard env vars (OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, OPENROUTER_API_KEY). A provider with neither is
 * "unavailable", which `listPiModels` filters out.
 */
export function getPiModels(): MutableModels {
  if (!models) {
    credentialStore = new SqliteCredentialStore();
    models = createModels({ credentials: credentialStore });
    models.setProvider(openaiProvider());
    models.setProvider(anthropicProvider());
    models.setProvider(openrouterProvider());
    for (const record of listCustomProviders()) models.setProvider(buildCustomProvider(record));
  }
  return models;
}

/** Adds a custom OpenAI-compatible provider (its id must be new) and registers it right away. */
export function addCustomProvider(record: CustomProviderRecord): void {
  if (getPiModels().getProvider(record.id)) throw new CustomProviderError(`A provider with ID "${record.id}" already exists.`);
  insertCustomProvider(record);
  getPiModels().setProvider(buildCustomProvider(record));
}

/** Replaces an existing custom provider's settings (the id is fixed). */
export function editCustomProvider(record: CustomProviderRecord): void {
  if (!getCustomProvider(record.id)) throw new CustomProviderError(`No custom provider "${record.id}".`);
  updateCustomProvider(record);
  getPiModels().setProvider(buildCustomProvider(record));
}

export function removeCustomProvider(id: string): void {
  if (!getCustomProvider(id)) return;
  deleteCustomProvider(id);
  getPiModels().deleteProvider(id);
}

/** Test hook: swap in a Models collection wired to fake providers. */
export function setPiModelsForTesting(replacement: MutableModels | null, credentials: CredentialStore | null = null): void {
  models = replacement;
  credentialStore = credentials;
}

export interface PiModelSummary {
  /** Gateway-facing id, e.g. "openai/gpt-5.6-luna". */
  id: string;
  model: Model<Api>;
  /**
   * Reasoning levels accepted as `reasoning_effort`. pi-ai's "off" is
   * exposed as "none" (OpenAI's name for it); models without reasoning have
   * none at all.
   */
  variants: string[];
}

/** Gateway name for pi-ai's "off" thinking level. */
export const PI_REASONING_OFF = "none";

function summarize(model: Model<Api>): PiModelSummary {
  return {
    id: `${model.provider}/${model.id}`,
    model,
    variants: model.reasoning
      ? getSupportedThinkingLevels(model).map((level) => (level === "off" ? PI_REASONING_OFF : level))
      : [],
  };
}

/**
 * With "Sign in with ChatGPT" the OpenAI provider only serves the models a
 * ChatGPT subscription includes - others fail with "model is not supported
 * when using Codex with a ChatGPT account". pi-ai's openai catalog doesn't
 * filter for that, but its (legacy) openai-codex catalog is exactly that
 * subscription set, so it's used as the allow-list while OpenAI's auth is
 * OAuth. With an API key every OpenAI model stays available.
 */
const CHATGPT_SUBSCRIPTION_MODEL_IDS = new Set<string>(Object.values(OPENAI_CODEX_MODELS).map((m) => m.id));

/** True while the OpenAI provider is signed in with a ChatGPT account (OAuth) rather than an API key. */
export async function isChatGPTSignIn(): Promise<boolean> {
  const auth = await getPiModels().checkAuth("openai").catch(() => undefined);
  return auth?.type === "oauth";
}

async function withoutUnsupportedSubscriptionModels(models: readonly Model<Api>[]): Promise<Model<Api>[]> {
  if (!models.some((m) => m.provider === "openai")) return [...models];
  if (!(await isChatGPTSignIn())) return [...models];
  return models.filter((m) => m.provider !== "openai" || CHATGPT_SUBSCRIPTION_MODEL_IDS.has(m.id));
}

/** Models whose provider has credentials configured. */
export async function listPiModels(): Promise<PiModelSummary[]> {
  const available = await withoutUnsupportedSubscriptionModels(await getPiModels().getAvailable());
  return available.map(summarize);
}

/**
 * Resolves "<provider>/<model>" to an available model, or null when the id
 * is malformed, unknown, or its provider has no credentials.
 */
export async function findPiModel(id: string): Promise<PiModelSummary | null> {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  const providerId = id.slice(0, slash);
  const modelId = id.slice(slash + 1);
  if (!getPiModels().getProvider(providerId)) return null;
  let available: readonly Model<Api>[];
  try {
    available = await withoutUnsupportedSubscriptionModels(await getPiModels().getAvailable(providerId));
  } catch {
    return null;
  }
  const model = available.find((m) => m.id === modelId);
  return model ? summarize(model) : null;
}

export interface PiProviderStatus {
  id: string;
  name: string;
  /** Label of the provider's OAuth login (e.g. "Anthropic (Claude Pro/Max)"), if it has one. */
  oauthLabel: string | null;
  /** Whether an API key can be entered from the dashboard. */
  supportsApiKey: boolean;
  /** Where auth currently comes from, e.g. "OAuth", "stored credential" or an env var name; null when unconfigured. */
  authSource: string | null;
  authType: "api_key" | "oauth" | null;
  /** True when a credential is stored in the database (i.e. something to sign out of). */
  hasStoredCredential: boolean;
  /** Set for user-defined OpenAI-compatible endpoints. */
  custom?: { baseUrl: string; models: CustomModelSpec[]; hasKey: boolean };
}

export async function listPiProviders(): Promise<PiProviderStatus[]> {
  const piModels = getPiModels();
  const customById = new Map(listCustomProviders().map((p) => [p.id, p]));
  const stored = new Set((await credentialStore?.list())?.map((c) => c.providerId) ?? []);
  return Promise.all(
    piModels.getProviders().map(async (provider) => {
      const check = await piModels.checkAuth(provider.id).catch(() => undefined);
      const oauth = provider.auth.oauth;
      const custom = customById.get(provider.id);
      return {
        ...(custom ? { custom: { baseUrl: custom.baseUrl, models: custom.models, hasKey: custom.apiKey !== null } } : {}),
        id: provider.id,
        name: provider.name,
        oauthLabel: oauth ? oauth.loginLabel ?? oauth.name : null,
        supportsApiKey: typeof provider.auth.apiKey?.login === "function",
        authSource: check ? check.source ?? check.type : null,
        authType: check?.type ?? null,
        hasStoredCredential: stored.has(provider.id),
      };
    })
  );
}
