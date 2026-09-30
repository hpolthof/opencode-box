/**
 * Reasoning level used when a request doesn't name one: as little as the
 * model allows (providers' own defaults are often not "off" - e.g. effort
 * "medium" for GPT-5.x):
 *
 * - a "none"/"off" level switches reasoning off;
 * - otherwise "minimal" / "low" are the lowest effort levels;
 * - a list with only higher levels (e.g. "high"/"max" thinking budgets)
 *   means the model's no-level default is already its minimum, so no level
 *   is sent then.
 */
const DEFAULT_REASONING_PREFERENCE = ["none", "off", "minimal", "low"];

export function defaultReasoningVariant(variants: readonly string[] | undefined): string | undefined {
  if (!variants || variants.length === 0) return undefined;
  return DEFAULT_REASONING_PREFERENCE.find((v) => variants.includes(v));
}

/** Accepts "off" and "none" interchangeably, mapped onto whichever of the two the model uses. */
export function normalizeReasoningVariant(variant: string | undefined, variants: readonly string[] | undefined): string | undefined {
  if (!variant || !variants) return variant;
  if (variant === "off" && !variants.includes("off") && variants.includes("none")) return "none";
  if (variant === "none" && !variants.includes("none") && variants.includes("off")) return "off";
  return variant;
}
