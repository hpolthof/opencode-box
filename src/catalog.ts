import { listModels, type ModelSummary } from "./opencode/client";
import { listPiModels, PIAI_MODEL_PREFIX } from "./piai/models";

/**
 * Every model the gateway can serve: OpenCode's catalog plus the models of
 * signed-in / keyed pi-ai providers (ids "pi/<provider>/<model>", with
 * providerID "pi/<provider>"). Admin pages, key allow-lists, aliases and
 * /v1 model resolution all read from this.
 *
 * An unreachable OpenCode no longer hides the pi models; only when neither
 * backend yields anything is OpenCode's error rethrown, so pages keep
 * showing their "OpenCode is not reachable" banner in that case.
 */
export async function listCatalogModels(): Promise<ModelSummary[]> {
  let opencodeError: unknown = null;
  const opencodeModels = await listModels().catch((err) => {
    opencodeError = err;
    return [] as ModelSummary[];
  });
  const piModels = await listPiModels().catch((err) => {
    console.error("[catalog] failed to list pi-ai models:", err);
    return [];
  });
  if (opencodeError && piModels.length === 0) throw opencodeError;

  return [
    ...opencodeModels,
    ...piModels.map(({ id, model, variants }) => ({
      id,
      providerID: `${PIAI_MODEL_PREFIX}${model.provider}`,
      modelID: model.id,
      name: model.name,
      reasoning: model.reasoning,
      ...(variants.length > 0 ? { variants } : {}),
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cache: { read: model.cost.cacheRead, write: model.cost.cacheWrite },
      },
    })),
  ];
}

export function isPiProviderId(providerID: string): boolean {
  return providerID.startsWith(PIAI_MODEL_PREFIX);
}
