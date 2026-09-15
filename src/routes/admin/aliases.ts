import { Hono } from "hono";
import { createAlias, deleteAlias, listAliases } from "../../db/modelAliases";
import { listModels, type ModelSummary } from "../../opencode/client";
import { Aliases } from "../../views/aliases";
import type { ModelAliasMode, ModelAliasTarget } from "../../types";

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

function parseMode(raw: unknown): ModelAliasMode {
  return raw === "random" ? "random" : "priority";
}

function toArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : typeof raw === "string" ? [raw] : [];
}

/** Reconstructs the submitted target rows from the parallel targetModel[]/targetVariant[] arrays (paired by DOM order). */
function parseTargetRows(body: Record<string, unknown>): { model: string; variant: string }[] {
  const models = toArray(body.targetModel);
  const variants = toArray(body.targetVariant);
  const rows: { model: string; variant: string }[] = [];
  for (let i = 0; i < Math.max(models.length, variants.length); i++) {
    const model = models[i] ?? "";
    const variant = variants[i] ?? "";
    if (model || variant) rows.push({ model, variant });
  }
  return rows;
}

aliasesRouter.get("/aliases", async (c) => {
  const { models, modelsUnreachable } = await pickableModels();
  return c.html(Aliases({ aliases: listAliases(), models, modelsUnreachable }) as string);
});

aliasesRouter.post("/aliases", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const { models, modelsUnreachable } = await pickableModels();

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const mode = parseMode(body.mode);
  const targetRows = parseTargetRows(body);

  const rerender = (error: string) =>
    c.html(
      Aliases({ aliases: listAliases(), models, modelsUnreachable, error, formValues: { name, mode, targets: targetRows } }) as string,
      400
    );

  if (!name) return rerender("Name is required");
  if (targetRows.length === 0) return rerender("Add at least one target model");

  const targets: ModelAliasTarget[] = [];
  for (const row of targetRows) {
    const matched = models.find((m) => m.id === row.model);
    if (!matched) return rerender(`Choose a model that has reasoning variants available (target ${targets.length + 1})`);
    if (!row.variant || !matched.variants?.includes(row.variant)) {
      return rerender(`Choose a valid variant for "${row.model}"`);
    }
    targets.push({ providerID: matched.providerID, modelID: matched.modelID, variant: row.variant });
  }

  try {
    createAlias(name, mode, targets);
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
