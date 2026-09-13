import { Hono } from "hono";
import { totals, usageByModel, usageByApp } from "../../db/requests";
import { Dashboard } from "../../views/dashboard";

export const dashboardRouter = new Hono();

dashboardRouter.get("/", (c) => {
  const totalsData = totals();
  const modelUsageToday = usageByModel(true);
  const modelUsageAll = usageByModel(false);
  const appUsageToday = usageByApp(true);
  const appUsageAll = usageByApp(false);

  return c.html(
    Dashboard({
      totals: totalsData,
      modelUsageToday,
      modelUsageAll,
      appUsageToday,
      appUsageAll,
    }) as string
  );
});
