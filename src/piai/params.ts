import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * The client's sampling / limit parameters (output token cap, temperature,
 * top_p, prompt_cache_key) and how each reaches a given model - as a pi-ai
 * option, through the `onPayload` hook, or not at all. A parameter the
 * model or auth can't take is dropped rather than failing the request, but
 * never silently: it's logged and reported back as `dropped`.
 */

export interface RequestParams {
  /** Output token cap, passed one-to-one (it includes reasoning tokens where the provider counts them so). */
  maxOutputTokens?: number;
  /** The client's name for the cap ("max_output_tokens", "max_completion_tokens" or "max_tokens"), used when reporting it dropped. */
  maxOutputTokensParam?: string;
  temperature?: number;
  topP?: number;
  promptCacheKey?: string;
}

export interface ParamPlan {
  /** Merged into the pi-ai stream options. */
  options: { maxTokens?: number; temperature?: number; samplingParams?: Record<string, unknown>; sessionId?: string };
  /** Payload edits pi-ai has no option for; composed with the structured-output hook. */
  onPayload?: (payload: unknown) => unknown;
  /** Wire names of the parameters the client sent that are not forwarded. */
  dropped: string[];
  /** Forwarded parameters a provider may still reject at runtime (see `noteRejectedParams`). */
  retryable: string[];
}

export interface ParamEnv {
  /** OpenAI is signed in with a ChatGPT account rather than an API key. */
  chatgptSignIn: boolean;
  /** Parameters this model rejected before (see `rejectedParams`). */
  rejected: ReadonlySet<string>;
}

/** APIs whose adapters merge pi-ai's `samplingParams` into the request body. */
const OPENAI_STYLE_APIS = new Set<string>(["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"]);

/** Anthropic needs `thinking.budget_tokens` >= 1024 and below `max_tokens`. */
const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

interface ModelCompatFlags {
  supportsTemperature?: boolean;
  supportsMidConvoEffort?: boolean;
  supportsMaxOutputTokens?: boolean;
}

/**
 * `reasoning` says whether a thinking level is sent (Anthropic can't take
 * a temperature alongside extended thinking).
 */
export function planParams(model: Model<Api>, reasoning: boolean, params: RequestParams, env: ParamEnv): ParamPlan {
  const compat = (model.compat ?? {}) as ModelCompatFlags;
  const isAnthropic = model.api === "anthropic-messages";
  // The ChatGPT backend answers 400 "Unsupported parameter" to
  // max_output_tokens, temperature and top_p (pi-ai already leaves out the
  // first two); prompt_cache_key is fine.
  const chatgpt = env.chatgptSignIn && model.provider === "openai";
  // Anthropic: temperature is unsupported on some models (Opus 4.7+),
  // incompatible with extended thinking, and pi-ai leaves it out for models
  // with managed effort. top_p is subject to the same restrictions.
  const anthropicNoSampling =
    isAnthropic && (compat.supportsTemperature === false || compat.supportsMidConvoEffort === true || reasoning);

  const options: ParamPlan["options"] = {};
  const dropped: string[] = [];
  const retryable: string[] = [];
  let anthropicTopP: number | undefined;

  if (params.maxOutputTokens !== undefined) {
    const responsesWithoutCap = model.api.endsWith("-responses") && compat.supportsMaxOutputTokens === false;
    if (chatgpt || responsesWithoutCap) {
      dropped.push(params.maxOutputTokensParam ?? "max_output_tokens");
    } else {
      // One-to-one, except that the openai-responses adapter raises it to
      // at least 16 - OpenAI rejects lower values for max_output_tokens.
      options.maxTokens = params.maxOutputTokens;
    }
  }

  if (params.temperature !== undefined) {
    if (chatgpt || anthropicNoSampling || env.rejected.has("temperature")) {
      dropped.push("temperature");
    } else {
      options.temperature = params.temperature;
      retryable.push("temperature");
    }
  }

  if (params.topP !== undefined) {
    // Current Claude models reject temperature and top_p together; the
    // temperature wins.
    const anthropicBoth = isAnthropic && options.temperature !== undefined;
    if (chatgpt || anthropicNoSampling || anthropicBoth || env.rejected.has("top_p") || !(isAnthropic || OPENAI_STYLE_APIS.has(model.api))) {
      dropped.push("top_p");
    } else if (isAnthropic) {
      anthropicTopP = params.topP;
    } else {
      options.samplingParams = { top_p: params.topP };
      retryable.push("top_p");
    }
  }

  if (params.promptCacheKey !== undefined) {
    // OpenAI-only; Anthropic caches through cache_control breakpoints. The
    // adapters send pi-ai's `sessionId` as `prompt_cache_key`.
    if (model.provider === "openai" && (model.api === "openai-responses" || model.api === "openai-completions")) {
      options.sessionId = params.promptCacheKey;
    } else {
      dropped.push("prompt_cache_key");
    }
  }

  const cap = options.maxTokens;
  const onPayload =
    isAnthropic && (cap !== undefined || anthropicTopP !== undefined)
      ? (p: unknown) => anthropicPayload(p, cap, anthropicTopP, model)
      : undefined;

  return { options, ...(onPayload ? { onPayload } : {}), dropped, retryable };
}

interface AnthropicPayload {
  max_tokens?: number;
  top_p?: number;
  thinking?: { type: string; budget_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * pi-ai adds the thinking budget on top of `maxTokens` for budget-based
 * thinking; the client's cap is put back one-to-one here, with the budget
 * shrunk to fit under it (or thinking switched off when it can't fit).
 */
function anthropicPayload(p: unknown, cap: number | undefined, topP: number | undefined, model: Model<Api>): AnthropicPayload {
  const payload = { ...(p as AnthropicPayload) };
  if (topP !== undefined) payload.top_p = topP;
  if (cap !== undefined) {
    payload.max_tokens = cap;
    const thinking = payload.thinking;
    if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number" && thinking.budget_tokens >= cap) {
      const budget = cap - 1;
      if (budget >= ANTHROPIC_MIN_THINKING_BUDGET) {
        payload.thinking = { ...thinking, budget_tokens: budget };
      } else {
        console.warn(`[piai] ${model.provider}/${model.id}: max_tokens ${cap} leaves no room for a thinking budget, thinking disabled`);
        payload.thinking = { type: "disabled" };
      }
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Parameters rejected at runtime
// ---------------------------------------------------------------------------

/** Per "<provider>/<model>": parameters the provider rejected, dropped up front from then on. In memory only. */
const rejectedByModel = new Map<string, Set<string>>();

const NO_PARAMS: ReadonlySet<string> = new Set();

export function rejectedParams(modelKey: string): ReadonlySet<string> {
  return rejectedByModel.get(modelKey) ?? NO_PARAMS;
}

/**
 * Some OpenAI reasoning models reject temperature/top_p with a 400
 * "Unsupported parameter: 'temperature' ..." (or "Unsupported value: ...
 * Only the default (1) value is supported"). When `errorMessage` is such a
 * rejection of a parameter in `forwarded`, it's remembered for the model
 * and true is returned: the caller should retry without it.
 */
export function noteRejectedParams(modelKey: string, forwarded: readonly string[], errorMessage: string): boolean {
  if (!/unsupported (parameter|value)/i.test(errorMessage)) return false;
  const named = forwarded.filter((param) => new RegExp(`\\b${param}\\b`).test(errorMessage));
  if (named.length === 0) return false;
  const set = rejectedByModel.get(modelKey) ?? new Set<string>();
  for (const param of named) set.add(param);
  rejectedByModel.set(modelKey, set);
  console.warn(`[piai] ${modelKey} rejected ${named.join(", ")}; retrying without and dropping it for this model from now on`);
  return true;
}
