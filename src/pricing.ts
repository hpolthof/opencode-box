/**
 * $/1M-token reference pricing, used only as a fallback when a model's own
 * catalog data (OpenCode's `cost.input`/`cost.output`, from either the
 * curated `GET /api/model` catalog or the raw `GET /provider` model list)
 * doesn't report real pricing - either missing entirely, or explicitly
 * `{input: 0, output: 0}`. In this gateway's own testing, every connected
 * OpenAI model reports zero cost from OpenCode itself, most likely because
 * billing runs through a flat subscription rather than a metered API key -
 * not because the models are actually free - so a zero-cost report is
 * treated as "no real data" and falls back to this table.
 *
 * Sourced from OpenAI's API pricing page (developers.openai.com/api/docs/pricing)
 * on 2026-09-25. Short-context/standard-tier rates only - the >272K-token
 * long-context pricing tier some of these models have isn't modeled.
 * gpt-5.6-sol's $4/$20 is promotional pricing (listed through at least
 * 2026-11-21). `cacheWrite` is only listed for models that bill cache
 * writes; the others don't report cache-write tokens at all. "-fast"
 * suffixed variants aren't independently priced; they're derived as 2x
 * their base model's rates, per third-party trackers' documented "fast
 * mode doubles standard rates" rule.
 *
 * These are ESTIMATES for cost visibility, not real billing figures -
 * re-verify before relying on this for actual budgeting.
 */
type ReferenceRate = { input: number; output: number; cacheRead: number; cacheWrite?: number };

const REFERENCE_PRICING_PER_MILLION: Record<string, ReferenceRate> = {
  "openai/gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "openai/gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
  "openai/gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "openai/gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  "openai/gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  "openai/gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};

const FAST_SUFFIX = "-fast";

function referenceRate(modelId: string): ReferenceRate | null {
  const direct = REFERENCE_PRICING_PER_MILLION[modelId];
  if (direct) return direct;
  if (modelId.endsWith(FAST_SUFFIX)) {
    const base = REFERENCE_PRICING_PER_MILLION[modelId.slice(0, -FAST_SUFFIX.length)];
    if (base) {
      return {
        input: base.input * 2,
        output: base.output * 2,
        cacheRead: base.cacheRead * 2,
        ...(base.cacheWrite !== undefined ? { cacheWrite: base.cacheWrite * 2 } : {}),
      };
    }
  }
  return null;
}

export interface ModelRate {
  /** $ per 1,000,000 uncached input tokens. */
  input: number;
  /** $ per 1,000,000 output tokens (reasoning included). */
  output: number;
  /** $ per 1,000,000 cache-read input tokens. */
  cacheRead: number;
  /** $ per 1,000,000 cache-write input tokens. */
  cacheWrite: number;
  /** True when this came from the reference table above (an estimate), not the model's own reported cost. */
  estimated: boolean;
}

/**
 * Resolves the $/1M-token rate to use for a model: its own reported cost
 * when that looks real (non-zero), else the reference table, else `null`
 * (genuinely no pricing data available anywhere). A cache rate that isn't
 * known falls back to the plain input rate - a model that reports no cache
 * pricing is billing cached input like any other input, as far as we know.
 */
export function resolveModelRate(
  reported: { input?: number; output?: number; cache?: { read?: number; write?: number } } | undefined,
  modelId: string
): ModelRate | null {
  if (reported && ((reported.input ?? 0) > 0 || (reported.output ?? 0) > 0)) {
    const input = reported.input ?? 0;
    return {
      input,
      output: reported.output ?? 0,
      cacheRead: reported.cache?.read || input,
      cacheWrite: reported.cache?.write || input,
      estimated: false,
    };
  }
  const ref = referenceRate(modelId);
  if (ref) {
    return { input: ref.input, output: ref.output, cacheRead: ref.cacheRead, cacheWrite: ref.cacheWrite ?? ref.input, estimated: true };
  }
  return null;
}

export interface CostTokens {
  /** All input tokens, cached ones included. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** Subset of `promptTokens`. Null on rows logged before cache tokens were tracked. */
  cacheReadTokens?: number | null;
  /** Subset of `promptTokens`. */
  cacheWriteTokens?: number | null;
}

/** Estimated dollar cost for a request, or `null` if no rate could be resolved. */
export function estimateCost(rate: ModelRate | null, tokens: CostTokens): number | null {
  if (!rate) return null;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheWrite = tokens.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, (tokens.promptTokens ?? 0) - cacheRead - cacheWrite);
  const output = tokens.completionTokens ?? 0;
  return (uncached * rate.input + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite + output * rate.output) / 1_000_000;
}

export function formatCost(cost: number | null): string {
  if (cost === null) return "-";
  return "$" + cost.toFixed(5);
}

export function formatRate(rate: ModelRate | null): string {
  if (!rate) return "-";
  return `$${rate.input.toFixed(2)} / $${rate.output.toFixed(2)}`;
}
