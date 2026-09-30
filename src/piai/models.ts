import { createModels, getSupportedThinkingLevels, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/**
 * Proof of concept: calls models directly through pi-ai (in-process, no
 * agent prompt) instead of through `opencode serve`. Only models whose id
 * starts with this prefix take the pi-ai path - e.g.
 * "pi/anthropic/claude-sonnet-4-5" - so both backends can be compared side
 * by side on the same gateway.
 */
export const PIAI_MODEL_PREFIX = "pi/";

let models: MutableModels | null = null;

/**
 * Anthropic and OpenAI only for now. Auth resolves from the standard env
 * vars (ANTHROPIC_API_KEY, OPENAI_API_KEY) - a provider without one is
 * simply "unavailable", which `listPiModels` filters out.
 */
export function getPiModels(): MutableModels {
  if (!models) {
    models = createModels();
    models.setProvider(anthropicProvider());
    models.setProvider(openaiProvider());
  }
  return models;
}

/** Test hook: swap in a Models collection wired to fake providers. */
export function setPiModelsForTesting(replacement: MutableModels | null): void {
  models = replacement;
}

export function isPiModelId(model: string): boolean {
  return model.startsWith(PIAI_MODEL_PREFIX);
}

export interface PiModelSummary {
  /** Gateway-facing id, e.g. "pi/openai/gpt-5-mini". */
  id: string;
  model: Model<Api>;
  /** Reasoning levels accepted as `reasoning_effort`, "off" excluded. */
  variants: string[];
}

function summarize(model: Model<Api>): PiModelSummary {
  return {
    id: `${PIAI_MODEL_PREFIX}${model.provider}/${model.id}`,
    model,
    variants: getSupportedThinkingLevels(model).filter((level) => level !== "off"),
  };
}

/** Models whose provider has credentials configured. */
export async function listPiModels(): Promise<PiModelSummary[]> {
  const available = await getPiModels().getAvailable();
  return available.map(summarize);
}

/**
 * Resolves "pi/<provider>/<model>" to an available model, or null when the
 * id is malformed, unknown, or its provider has no credentials.
 */
export async function findPiModel(id: string): Promise<PiModelSummary | null> {
  if (!isPiModelId(id)) return null;
  const rest = id.slice(PIAI_MODEL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const providerId = rest.slice(0, slash);
  const modelId = rest.slice(slash + 1);
  let available: readonly Model<Api>[];
  try {
    available = await getPiModels().getAvailable(providerId);
  } catch {
    return null;
  }
  const model = available.find((m) => m.id === modelId);
  return model ? summarize(model) : null;
}

/**
 * Pi models in the shape the admin pricing code expects from
 * `opencode/client.listModels()` ($/1M tokens), so request-log and
 * dashboard cost columns work for "pi/..." rows too.
 */
export async function listPiModelRates(): Promise<
  { id: string; cost: { input: number; output: number; cache: { read: number; write: number } } }[]
> {
  return (await listPiModels()).map(({ id, model }) => ({
    id,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache: { read: model.cost.cacheRead, write: model.cost.cacheWrite },
    },
  }));
}
