import { Hono } from "hono";
import { createKey, listKeys, revokeKey } from "../../db/apiKeys";
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

keysRouter.get("/keys", async (c) => {
  const { models, modelsUnreachable } = await availableModels();
  return c.html(Keys({ keys: listKeys(), models, modelsUnreachable }) as string);
});

keysRouter.post("/keys", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const allowedModelsRaw = body.allowedModels;
  const { models, modelsUnreachable } = await availableModels();

  if (!name) {
    return c.html(Keys({ keys: listKeys(), models, modelsUnreachable, error: "Name is required" }) as string, 400);
  }

  const allowedModels = Array.isArray(allowedModelsRaw)
    ? allowedModelsRaw.filter((s): s is string => typeof s === "string" && s.length > 0)
    : typeof allowedModelsRaw === "string" && allowedModelsRaw.length > 0
      ? [allowedModelsRaw]
      : [];

  const { record, rawKey } = createKey(name, allowedModels.length > 0 ? allowedModels : null);

  return c.html(Keys({ keys: listKeys(), models, modelsUnreachable, newKey: { name: record.name, rawKey } }) as string);
});

keysRouter.post("/keys/:id/revoke", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isNaN(id)) {
    revokeKey(id);
  }
  return c.redirect("/admin/keys", 302);
});
