import { createProvider, type Model, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { CustomModelSpec, CustomProviderRecord } from "../db/customProviders";

/**
 * User-defined OpenAI-compatible endpoints (Chat Completions API), added
 * from Admin > Providers. Each becomes its own pi-ai provider.
 */

/** Ids of the built-in providers; a custom provider can't reuse them. */
export const BUILTIN_PROVIDER_IDS = ["openai", "anthropic", "openrouter"];

export class CustomProviderError extends Error {}

export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_LEVELS = ["low", "medium", "high"];

/**
 * Unknown servers (Ollama, vLLM, LiteLLM, ...) often lack the `developer`
 * role, so it isn't sent. `reasoning_effort` is only sent for models with
 * reasoning levels; unlisted levels are marked unsupported.
 */
function toModel(provider: CustomProviderRecord, spec: CustomModelSpec): Model<"openai-completions"> {
  const reasoning = spec.levels.length > 0;
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const level of REASONING_LEVELS) thinkingLevelMap[level] = spec.levels.includes(level) ? level : null;
  return {
    id: spec.id,
    name: spec.id,
    api: "openai-completions",
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning,
    ...(reasoning ? { thinkingLevelMap } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: reasoning },
  };
}

export function buildCustomProvider(record: CustomProviderRecord): Provider {
  return createProvider({
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    // Always "configured": a keyless endpoint resolves with no key.
    auth: {
      apiKey: {
        name: record.name,
        resolve: async () => ({ auth: record.apiKey ? { apiKey: record.apiKey } : {}, source: record.apiKey ? "stored key" : "no key" }),
      },
    },
    models: record.models.map((spec) => toModel(record, spec)),
    api: openAICompletionsApi(),
  }) as Provider;
}

export interface CustomProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** One model per line: "id" or "id | low,medium,high" (reasoning levels). */
  models: string;
}

/** Validates form input; `existingKey` is kept when the key field is left blank (edit). */
export function parseCustomProviderInput(input: CustomProviderInput, existingKey: string | null = null): CustomProviderRecord {
  const id = input.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
    throw new CustomProviderError("The ID must be 1-40 characters: lowercase letters, digits and dashes.");
  }
  if (BUILTIN_PROVIDER_IDS.includes(id)) throw new CustomProviderError(`"${id}" is a built-in provider; pick another ID.`);
  let baseUrl: string;
  try {
    const url = new URL(input.baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    baseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    throw new CustomProviderError("The base URL must be a valid http(s) URL, e.g. https://example.com/v1.");
  }
  const models = parseModelLines(input.models);
  if (models.length === 0) throw new CustomProviderError("Add at least one model ID.");
  const name = input.name.trim() || id;
  return { id, name, baseUrl, apiKey: input.apiKey.trim() || existingKey, models };
}

export function parseModelLines(text: string): CustomModelSpec[] {
  const byId = new Map<string, CustomModelSpec>();
  for (const line of text.split("\n")) {
    const [rawId = "", rawLevels = ""] = line.split("|");
    const id = rawId.trim();
    if (!id) continue;
    const levels = rawLevels.split(",").map((l) => l.trim().toLowerCase()).filter((l) => (REASONING_LEVELS as readonly string[]).includes(l));
    byId.set(id, { id, levels: REASONING_LEVELS.filter((l) => levels.includes(l)) });
  }
  return [...byId.values()];
}

export function formatModelLines(models: CustomModelSpec[]): string {
  return models.map((m) => (m.levels.length > 0 ? `${m.id} | ${m.levels.join(",")}` : m.id)).join("\n");
}

/**
 * Lists the models of an OpenAI-compatible endpoint (GET <baseUrl>/models).
 * The standard response only has ids; reasoning levels are read from the
 * metadata some servers add: an explicit list of efforts, or a
 * "reasoning"/"reasoning_effort" capability (then low/medium/high).
 */
export async function discoverModels(baseUrl: string, apiKey: string | null): Promise<CustomModelSpec[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new CustomProviderError(`Could not reach ${baseUrl}/models: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new CustomProviderError(`${baseUrl}/models answered HTTP ${response.status}.`);
  const body = (await response.json().catch(() => null)) as unknown;
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new CustomProviderError("The /models response has no model list.");
  const models: CustomModelSpec[] = [];
  for (const item of list) {
    const entry = (typeof item === "string" ? { id: item } : item) as Record<string, unknown> | null;
    if (!entry || typeof entry.id !== "string" || !entry.id) continue;
    models.push({ id: entry.id, levels: reasoningLevelsOf(entry) });
  }
  if (models.length === 0) throw new CustomProviderError("The endpoint listed no models.");
  return models;
}

function reasoningLevelsOf(entry: Record<string, unknown>): string[] {
  const known = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()).filter((x) => (REASONING_LEVELS as readonly string[]).includes(x)) : []);
  const explicit = [entry.reasoning_efforts, entry.supported_reasoning_efforts, entry.reasoning_effort_levels, entry.reasoning_levels]
    .map(known)
    .find((l) => l.length > 0);
  if (explicit) return REASONING_LEVELS.filter((l) => explicit.includes(l));
  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  const caps = (entry.capabilities ?? {}) as Record<string, unknown>;
  const reasons =
    entry.reasoning === true || caps.reasoning === true || params.includes("reasoning") || params.includes("reasoning_effort") || params.includes("include_reasoning");
  return reasons ? DEFAULT_LEVELS : [];
}
