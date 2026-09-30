import { getPiModels, listPiModels } from "./piai/models";

export interface ModelSummary {
  id: string; // "providerID/modelID"
  providerID: string;
  modelID: string;
  name?: string;
  /** True when the model supports reasoning at all. */
  reasoning?: boolean;
  /** Reasoning levels accepted as `reasoning_effort` / "#variant" (e.g. "none", "low", "high"), if any. */
  variants?: string[];
  /** $/1M-token rates from the model catalog (may be all zero - see src/pricing.ts). */
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
}

/**
 * Every model the gateway can serve right now: the models of pi-ai
 * providers that have credentials (see src/piai/models.ts). Admin pages,
 * key allow-lists, aliases and /v1 model resolution all read from this.
 */
export async function listCatalogModels(): Promise<ModelSummary[]> {
  return (await listPiModels()).map(({ id, model, variants }) => ({
    id,
    providerID: model.provider,
    modelID: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(variants.length > 0 ? { variants } : {}),
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache: { read: model.cost.cacheRead, write: model.cost.cacheWrite },
    },
  }));
}

/**
 * $/1M-token rates for every model in the catalog, whether or not its
 * provider is configured right now - so request-log rows and dashboard
 * totals keep their cost after a provider is signed out.
 */
export function listModelRates(): { id: string; cost: NonNullable<ModelSummary["cost"]> }[] {
  return getPiModels()
    .getModels()
    .map((model) => ({
      id: `${model.provider}/${model.id}`,
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cache: { read: model.cost.cacheRead, write: model.cost.cacheWrite },
      },
    }));
}
