/**
 * Reasoning level used when a request doesn't name one: as little as the
 * model allows, on both backends. Measured against OpenCode 1.18.30, whose
 * own default is *not* "off" (e.g. `effort: "medium"` for gpt-5.x):
 *
 * - a "none"/"off" level switches reasoning off;
 * - otherwise "minimal" / "low" are the lowest effort levels, which beats
 *   the provider default (medium-ish) of such models;
 * - lists with only higher levels (e.g. Claude 4.5 or Gemini 2.5
 *   "high"/"max" thinking budgets) belong to models whose no-variant
 *   default is already the minimum - thinking off, or the provider's
 *   dynamic default - so no variant is sent then.
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
