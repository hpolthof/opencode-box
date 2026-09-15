import { Hono } from "hono";
import { createKey, listKeys, revokeKey, updateAllowedModels } from "../../db/apiKeys";
import { listAliases } from "../../db/modelAliases";
import { listModels, type ModelSummary } from "../../opencode/client";
import { Keys } from "../../views/keys";

export const keysRouter = new Hono();

async function availableModels(): Promise<{ models: ModelSummary[]; modelsUnreachable: boolean }> {
  try {
    return { models: await listModels(), modelsUnreachable: false };
  } catch {
    return { models: [], modelsUnreachable: true };
  }
}

function parseAllowedModels(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string" && s.length > 0)
    : typeof raw === "string" && raw.length > 0
      ? [raw]
      : [];
}

keysRouter.get("/keys", async (c) => {
  const { models, modelsUnreachable } = await availableModels();
  return c.html(Keys({ keys: listKeys(), models, modelsUnreachable, aliases: listAliases() }) as string);
});

keysRouter.post("/keys", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const { models, modelsUnreachable } = await availableModels();
  const aliases = listAliases();

  if (!name) {
    return c.html(Keys({ keys: listKeys(), models, modelsUnreachable, aliases, error: "Name is required" }) as string, 400);
  }

  const allowedModels = parseAllowedModels(body.allowedModels);
  const { record, rawKey } = createKey(name, allowedModels.length > 0 ? allowedModels : null);

  return c.html(Keys({ keys: listKeys(), models, modelsUnreachable, aliases, newKey: { name: record.name, rawKey } }) as string);
});

keysRouter.post("/keys/:id/revoke", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isNaN(id)) {
    revokeKey(id);
  }
  return c.redirect("/admin/keys", 302);
});

keysRouter.post("/keys/:id/allowed-models", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody({ all: true });
  if (!Number.isNaN(id)) {
    const allowedModels = parseAllowedModels(body.allowedModels);
    updateAllowedModels(id, allowedModels.length > 0 ? allowedModels : null);
  }
  return c.redirect("/admin/keys", 302);
});
