import { Hono } from "hono";
import { createAlias, deleteAlias, listAliases } from "../../db/modelAliases";
import { listModels, type ModelSummary } from "../../opencode/client";
import { Aliases } from "../../views/aliases";

export const aliasesRouter = new Hono();

/** Only models with at least one configured reasoning variant make sense as an alias target. */
async function pickableModels(): Promise<{ models: ModelSummary[]; modelsUnreachable: boolean }> {
  try {
    const all = await listModels();
    return { models: all.filter((m) => m.variants && m.variants.length > 0), modelsUnreachable: false };
  } catch {
    return { models: [], modelsUnreachable: true };
  }
}

aliasesRouter.get("/aliases", async (c) => {
  const { models, modelsUnreachable } = await pickableModels();
  return c.html(Aliases({ aliases: listAliases(), models, modelsUnreachable }) as string);
});

aliasesRouter.post("/aliases", async (c) => {
  const body = await c.req.parseBody();
  const { models, modelsUnreachable } = await pickableModels();

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const modelId = typeof body.model === "string" ? body.model : "";
  const variant = typeof body.variant === "string" ? body.variant.trim() : "";

  const rerender = (error: string) =>
    c.html(
      Aliases({ aliases: listAliases(), models, modelsUnreachable, error, formValues: { name, model: modelId, variant } }) as string,
      400
    );

  if (!name) return rerender("Name is required");

  const matched = models.find((m) => m.id === modelId);
  if (!matched) return rerender("Choose a model that has reasoning variants available");
  if (!variant || !matched.variants?.includes(variant)) {
    return rerender(`Choose a valid variant for "${modelId}"`);
  }

  try {
    createAlias(name, matched.providerID, matched.modelID, variant);
  } catch (err) {
    const message = err instanceof Error && /unique/i.test(err.message) ? `Alias "${name}" already exists` : "Failed to create alias";
    return rerender(message);
  }

  return c.redirect("/admin/aliases", 302);
});

aliasesRouter.post("/aliases/:id/delete", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isNaN(id)) {
    deleteAlias(id);
  }
  return c.redirect("/admin/aliases", 302);
});
