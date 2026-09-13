import { Hono } from "hono";
import { listProviders } from "../../opencode/client";
import { Providers } from "../../views/providers";

export const providersRouter = new Hono();

providersRouter.get("/providers", async (c) => {
  try {
    const providers = await listProviders();
    return c.html(Providers({ providers }) as string);
  } catch {
    return c.html(Providers({ unreachable: true }) as string);
  }
});
