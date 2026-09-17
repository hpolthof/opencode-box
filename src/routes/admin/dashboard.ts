import { Hono } from "hono";
import { totals, usageByModel, usageByApp, type ModelUsage } from "../../db/requests";
import { listModels } from "../../opencode/client";
import { estimateCost, resolveModelRate } from "../../pricing";
import { Dashboard } from "../../views/dashboard";

export const dashboardRouter = new Hono();

dashboardRouter.get("/", async (c) => {
  const totalsData = totals();
  const modelUsageToday = usageByModel(true);
  const modelUsageAll = usageByModel(false);
  const appUsageToday = usageByApp(true);
  const appUsageAll = usageByApp(false);

  // Best-effort: if OpenCode isn't reachable, usage still renders - it just
  // shows no cost data, same as everywhere else pricing is optional.
  const catalog = await listModels().catch(() => []);
  const rateByModel = new Map(catalog.map((m) => [m.id, resolveModelRate(m.cost, m.id)]));
  const withCost = (rows: ModelUsage[]) =>
    rows.map((row) => {
      const rate = rateByModel.get(row.model) ?? resolveModelRate(undefined, row.model);
      return {
        ...row,
        estimatedCost: estimateCost(rate, row.promptTokens, row.completionTokens),
        costEstimated: rate?.estimated ?? false,
      };
    });

  return c.html(
    Dashboard({
      totals: totalsData,
      modelUsageToday: withCost(modelUsageToday),
      modelUsageAll: withCost(modelUsageAll),
      appUsageToday,
      appUsageAll,
    }) as string
  );
});
