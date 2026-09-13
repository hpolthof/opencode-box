import { Hono } from "hono";
import { listModels } from "../../opencode/client";
import { Models } from "../../views/models";

export const modelsRouter = new Hono();

modelsRouter.get("/models", async (c) => {
  try {
    const models = await listModels();
    return c.html(Models({ models }) as string);
  } catch {
    return c.html(Models({ unreachable: true }) as string);
  }
});
