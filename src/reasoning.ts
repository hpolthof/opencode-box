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

/** pi-ai's effort levels (ThinkingLevel), lowest to highest. */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** True for a name the gateway recognises as a reasoning level on some model (so not a typo like "turbo"). */
export function isReasoningLevel(level: string): boolean {
  return level === "none" || level === "off" || EFFORT_LEVELS.includes(level);
}

export type ReasoningVariantResolution = { ok: true; variant: string | undefined } | { ok: false };

/**
 * The level to actually send for a requested one, given the levels the
 * model offers (`variants`). `ok: false` means the request can't be served
 * at a level the client would accept - the caller answers 400.
 *
 * - Nothing requested -> `defaultReasoningVariant` (the minimum).
 * - A level the model offers is used as is ("off"/"none" interchangeably).
 * - "none"/"off" on a model that can't switch reasoning off means "as
 *   little as the model allows" -> `defaultReasoningVariant` too: its
 *   lowest effort level, or no level at all when it only offers high
 *   thinking budgets (or has no reasoning levels).
 * - Any other level the model doesn't offer is an error, unless `clamp` is
 *   set (an alias passing the client's effort on to each of its targets):
 *   then a recognised effort level becomes the nearest one the model has,
 *   preferring the next HIGHER level and only then the next lower - the
 *   same rule as pi-ai's `clampThinkingLevel`, so a client never gets less
 *   reasoning than it asked for when more is available. A model without
 *   effort levels then gets none. A name that isn't a reasoning level at
 *   all (e.g. "turbo") stays an error.
 */
export function resolveReasoningVariant(
  requested: string | undefined,
  variants: readonly string[] | undefined,
  options: { clamp?: boolean } = {}
): ReasoningVariantResolution {
  if (!requested) return { ok: true, variant: defaultReasoningVariant(variants) };
  const offered = variants ?? [];
  const variant = normalizeReasoningVariant(requested, offered);
  if (variant && offered.includes(variant)) return { ok: true, variant };
  if (variant === "none" || variant === "off") return { ok: true, variant: defaultReasoningVariant(offered) };
  if (!options.clamp || !variant) return { ok: false };
  const index = EFFORT_LEVELS.indexOf(variant);
  if (index === -1) return { ok: false };
  const higher = EFFORT_LEVELS.slice(index + 1).find((level) => offered.includes(level));
  const lower = EFFORT_LEVELS.slice(0, index)
    .reverse()
    .find((level) => offered.includes(level));
  return { ok: true, variant: higher ?? lower ?? defaultReasoningVariant(offered) };
}
