export class InvalidModelError extends Error {
  constructor(model: string) {
    super(`Invalid model id "${model}": expected "provider/model" format`);
    this.name = "InvalidModelError";
  }
}

/**
 * Splits an OpenAI-style "provider/model" string, with an optional
 * "#variant" suffix (a reasoning level, e.g. "openai/gpt-5.5#high"), into
 * { providerID, modelID, variant }. The split happens on the first "/", so
 * model ids may themselves contain "/" (e.g.
 * "openrouter/anthropic/claude-sonnet-4.5"); "#" is resolved first, so a
 * variant may never contain "/" or "#".
 */
export function parseModelId(model: string): { providerID: string; modelID: string; variant?: string } {
  const hashIdx = model.indexOf("#");
  const variant = hashIdx >= 0 ? model.slice(hashIdx + 1) : undefined;
  const base = hashIdx >= 0 ? model.slice(0, hashIdx) : model;

  const idx = base.indexOf("/");
  if (idx <= 0 || idx === base.length - 1 || variant === "") {
    throw new InvalidModelError(model);
  }
  return {
    providerID: base.slice(0, idx),
    modelID: base.slice(idx + 1),
    ...(variant !== undefined ? { variant } : {}),
  };
}
