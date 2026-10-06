import { Hono, type Context } from "hono";
import { createAlias, deleteAlias, listAliases, updateAlias } from "../../db/modelAliases";
import { listCatalogModels } from "../../catalog";
import type { ModelSummary } from "../../catalog";
import { Aliases, type AliasFormState } from "../../views/aliases";
import type { ModelAliasMode, ModelAliasRecord, ModelAliasTarget } from "../../types";

export const aliasesRouter = new Hono();

/** Only models with at least one configured reasoning variant make sense as an alias target. */
async function pickableModels(): Promise<{ models: ModelSummary[]; modelsUnreachable: boolean }> {
  try {
    const all = await listCatalogModels();
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

/**
 * Validates a submitted alias form against the pickable models. When editing,
 * a target the alias already has stays valid even if its model is unavailable
 * right now, so e.g. renaming an alias doesn't depend on every provider being up.
 */
function validateAliasForm(
  form: AliasFormState,
  models: ModelSummary[],
  existing?: ModelAliasRecord
): { error: string } | { targets: ModelAliasTarget[] } {
  if (!form.name) return { error: "Name is required" };
  if (form.targets.length === 0) return { error: "Add at least one target model" };
  const targets: ModelAliasTarget[] = [];
  for (const row of form.targets) {
    const matched = models.find((m) => m.id === row.model);
    if (matched) {
      if (!row.variant || !matched.variants?.includes(row.variant)) return { error: `Choose a valid variant for "${row.model}"` };
      targets.push({ providerID: matched.providerID, modelID: matched.modelID, variant: row.variant });
      continue;
    }
    const kept = existing?.targets.find((t) => `${t.providerID}/${t.modelID}` === row.model && t.variant === row.variant);
    if (!kept) return { error: `Choose a model that has reasoning variants available (target ${targets.length + 1})` };
    targets.push(kept);
  }
  return { targets };
}

async function readAliasForm(c: Context, mode: "add" | "edit", id?: number): Promise<AliasFormState> {
  const body = await c.req.parseBody({ all: true });
  return {
    mode: mode,
    id,
    name: typeof body.name === "string" ? body.name.trim() : "",
    aliasMode: parseMode(body.mode),
    // An unchecked checkbox isn't submitted at all.
    clientEffortOverrides: body.clientEffortOverrides !== undefined,
    targets: parseTargetRows(body),
  };
}

async function saveAlias(c: Context, mode: "add" | "edit", id?: number) {
  const form = await readAliasForm(c, mode, id);
  const { models, modelsUnreachable } = await pickableModels();
  const existing = id === undefined ? undefined : listAliases().find((a) => a.id === id);
  if (mode === "edit" && !existing) return c.text("Unknown alias", 404);

  const rerender = (error: string) => c.html(Aliases({ aliases: listAliases(), models, modelsUnreachable, error, form }) as string, 400);
  const checked = validateAliasForm(form, models, existing);
  if ("error" in checked) return rerender(checked.error);

  const options = { clientEffortOverrides: form.clientEffortOverrides };
  try {
    if (existing) updateAlias(existing.id, form.name, form.aliasMode, checked.targets, options);
    else createAlias(form.name, form.aliasMode, checked.targets, options);
  } catch (err) {
    return rerender(err instanceof Error && /unique/i.test(err.message) ? `Alias "${form.name}" already exists` : "Failed to save alias");
  }
  return c.redirect("/admin/aliases", 302);
}

aliasesRouter.post("/aliases", (c) => saveAlias(c, "add"));

aliasesRouter.post("/aliases/:id/edit", async (c) => {
  const id = Number(c.req.param("id"));
  return Number.isNaN(id) ? c.text("Unknown alias", 404) : saveAlias(c, "edit", id);
});

aliasesRouter.post("/aliases/:id/delete", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isNaN(id)) {
    deleteAlias(id);
  }
  return c.redirect("/admin/aliases", 302);
});
