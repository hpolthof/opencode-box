import { Hono } from "hono";
import { queryRequests } from "../../db/requests";
import { listModels } from "../../opencode/client";
import { estimateCost, resolveModelRate } from "../../pricing";
import { RequestsLog } from "../../views/requestsLog";

export const requestsLogRouter = new Hono();

const PAGE_SIZE = 50;

requestsLogRouter.get("/requests", async (c) => {
  const model = c.req.query("model")?.trim() || undefined;
  const app = c.req.query("app")?.trim() || undefined;
  const statusRaw = c.req.query("status")?.trim();
  const status = statusRaw === "ok" || statusRaw === "error" ? statusRaw : undefined;
  const pageRaw = Number(c.req.query("page"));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const { rows, total } = queryRequests({ model, appName: app, status, page, pageSize: PAGE_SIZE });

  // Best-effort: if OpenCode isn't reachable, requests still render - they
  // just show no cost data, same as everywhere else pricing is optional.
  const catalog = await listModels().catch(() => []);
  const rateByModel = new Map(catalog.map((m) => [m.id, resolveModelRate(m.cost, m.id)]));

  const rowsWithCost = rows.map((row) => {
    const rate = rateByModel.get(row.model) ?? resolveModelRate(undefined, row.model);
    return {
      ...row,
      estimatedCost: estimateCost(rate, row.promptTokens, row.completionTokens),
      costEstimated: rate?.estimated ?? false,
    };
  });
  const totalCost = rowsWithCost.reduce((sum, row) => (row.estimatedCost !== null ? sum + row.estimatedCost : sum), 0);
  const anyCostKnown = rowsWithCost.some((row) => row.estimatedCost !== null);

  return c.html(
    RequestsLog({
      rows: rowsWithCost,
      total,
      pageSize: PAGE_SIZE,
      filters: { model, app, status, page },
      totalCost: anyCostKnown ? totalCost : null,
    }) as string
  );
});
