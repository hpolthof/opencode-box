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
 * Sourced from third-party OpenAI pricing trackers on 2026-09-12 (OpenAI's
 * own pricing page blocks automated fetches). Short-context/base rates
 * only - the >272K-token long-context pricing tier some of these models
 * have isn't modeled. "-fast" suffixed variants aren't independently
 * priced by those sources; they're derived as 2x their base model's rate,
 * per those sources' documented "fast mode doubles standard rates" rule.
 *
 * These are ESTIMATES for cost visibility, not real billing figures -
 * re-verify before relying on this for actual budgeting.
 */
const REFERENCE_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "openai/gpt-5.4": { input: 2.5, output: 15 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "openai/gpt-5.5": { input: 5, output: 30 },
  "openai/gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "openai/gpt-5.6-sol": { input: 5, output: 30 },
  "openai/gpt-5.6-terra": { input: 2, output: 12 },
  "openai/gpt-6-astra": { input: 10, output: 50 },
};

const FAST_SUFFIX = "-fast";

function referenceRate(modelId: string): { input: number; output: number } | null {
  const direct = REFERENCE_PRICING_PER_MILLION[modelId];
  if (direct) return direct;
  if (modelId.endsWith(FAST_SUFFIX)) {
    const base = REFERENCE_PRICING_PER_MILLION[modelId.slice(0, -FAST_SUFFIX.length)];
    if (base) return { input: base.input * 2, output: base.output * 2 };
  }
  return null;
}

export interface ModelRate {
  /** $ per 1,000,000 input tokens. */
  input: number;
  /** $ per 1,000,000 output tokens. */
  output: number;
  /** True when this came from the reference table above (an estimate), not the model's own reported cost. */
  estimated: boolean;
}

/**
 * Resolves the $/1M-token rate to use for a model: its own reported cost
 * when that looks real (non-zero), else the reference table, else `null`
 * (genuinely no pricing data available anywhere).
 */
export function resolveModelRate(reported: { input?: number; output?: number } | undefined, modelId: string): ModelRate | null {
  if (reported && ((reported.input ?? 0) > 0 || (reported.output ?? 0) > 0)) {
    return { input: reported.input ?? 0, output: reported.output ?? 0, estimated: false };
  }
  const ref = referenceRate(modelId);
  if (ref) return { ...ref, estimated: true };
  return null;
}

/** Estimated dollar cost for a request, or `null` if no rate could be resolved. */
export function estimateCost(rate: ModelRate | null, promptTokens: number | null, completionTokens: number | null): number | null {
  if (!rate) return null;
  const input = promptTokens ?? 0;
  const output = completionTokens ?? 0;
  return (input / 1_000_000) * rate.input + (output / 1_000_000) * rate.output;
}

export function formatCost(cost: number | null): string {
  if (cost === null) return "-";
  return "$" + cost.toFixed(5);
}

export function formatRate(rate: ModelRate | null): string {
  if (!rate) return "-";
  return `$${rate.input.toFixed(2)} / $${rate.output.toFixed(2)}`;
}
