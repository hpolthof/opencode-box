import { Hono } from "hono";
import {
  countAllRequests,
  countRequestsOlderThan,
  exportRequestsCsv,
  oldestRequestDate,
  purgeAllRequests,
  purgeRequestsOlderThan,
  softPurgeAllRequests,
  softPurgeRequestsOlderThan,
} from "../../db/requests";
import { countRevokedKeysOlderThan, purgeRevokedKeysOlderThan } from "../../db/apiKeys";
import { getRetentionDays, getSoftPurgeEnabled, setRetentionDays, setSoftPurgeEnabled } from "../../db/settings";
import { opencodeHomeSizeBytes, requestsDbSizeBytes, vacuum } from "../../db/maintenance";
import { Maintenance } from "../../views/maintenance";

export const maintenanceRouter = new Hono();

const PURGE_THRESHOLDS_DAYS = [7, 30, 90, 365] as const;

function loadStats() {
  return {
    totalRequests: countAllRequests(),
    oldestRequestDate: oldestRequestDate(),
    dbSizeBytes: requestsDbSizeBytes(),
    opencodeHomeSizeBytes: opencodeHomeSizeBytes(),
    retentionDays: getRetentionDays(),
    softPurgeEnabled: getSoftPurgeEnabled(),
    requestCountsByThreshold: PURGE_THRESHOLDS_DAYS.map((days) => ({ days, count: countRequestsOlderThan(days) })),
    revokedKeyCountsByThreshold: PURGE_THRESHOLDS_DAYS.map((days) => ({ days, count: countRevokedKeysOlderThan(days) })),
  };
}

/** Parses a purge "scope" form value: either the literal "all" or a positive day count. */
function parseScope(raw: unknown): { kind: "all" } | { kind: "days"; days: number } | null {
  if (raw === "all") return { kind: "all" };
  const days = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(days) && days > 0 ? { kind: "days", days } : null;
}

maintenanceRouter.get("/maintenance", (c) => {
  return c.html(Maintenance(loadStats()) as string);
});

maintenanceRouter.post("/maintenance/retention", async (c) => {
  const body = await c.req.parseBody();
  const raw = typeof body.retentionDays === "string" ? body.retentionDays.trim() : "";

  if (raw !== "" && (!Number.isFinite(Number(raw)) || Number(raw) <= 0)) {
    return c.html(Maintenance({ ...loadStats(), error: "Retention must be a positive number of days, or left empty to disable." }) as string, 400);
  }

  const days = raw === "" ? null : Number(raw);
  const soft = body.soft === "on";
  setRetentionDays(days);
  setSoftPurgeEnabled(soft);

  const mode = soft ? "clears request/response bodies on" : "deletes";
  return c.html(
    Maintenance({
      ...loadStats(),
      success: days ? `Automatic purge enabled: hourly job ${mode} request logs older than ${days} day(s).` : "Automatic purge disabled.",
    }) as string
  );
});

maintenanceRouter.post("/maintenance/purge-requests", async (c) => {
  const body = await c.req.parseBody();
  const scope = parseScope(body.scope);
  const soft = body.soft === "on";
  if (!scope) {
    return c.html(Maintenance({ ...loadStats(), error: "Invalid purge scope." }) as string, 400);
  }

  if (soft) {
    const affected = scope.kind === "all" ? softPurgeAllRequests() : softPurgeRequestsOlderThan(scope.days);
    return c.html(Maintenance({ ...loadStats(), success: `Cleared stored bodies on ${affected} request log row(s). Rows were kept for stats.` }) as string);
  }

  const deleted = scope.kind === "all" ? purgeAllRequests() : purgeRequestsOlderThan(scope.days);
  return c.html(Maintenance({ ...loadStats(), success: `Purged ${deleted} request log row(s). Run "Vacuum" below to reclaim the freed disk space.` }) as string);
});

maintenanceRouter.post("/maintenance/purge-revoked-keys", async (c) => {
  const body = await c.req.parseBody();
  const scope = parseScope(body.scope);
  if (!scope) {
    return c.html(Maintenance({ ...loadStats(), error: "Invalid purge scope." }) as string, 400);
  }

  const deleted = scope.kind === "all" ? purgeRevokedKeysOlderThan(0) : purgeRevokedKeysOlderThan(scope.days);
  return c.html(Maintenance({ ...loadStats(), success: `Deleted ${deleted} revoked API key(s).` }) as string);
});

maintenanceRouter.post("/maintenance/vacuum", (c) => {
  const before = requestsDbSizeBytes();
  vacuum();
  const after = requestsDbSizeBytes();
  const freedMb = Math.max(0, (before - after) / (1024 * 1024)).toFixed(1);
  return c.html(
    Maintenance({
      ...loadStats(),
      success: freedMb === "0.0" ? "Vacuum complete — there was no reclaimable space." : `Vacuum complete — freed ${freedMb} MB on disk.`,
    }) as string
  );
});

maintenanceRouter.get("/maintenance/export.csv", (c) => {
  const csv = exportRequestsCsv();
  const date = new Date().toISOString().slice(0, 10);
  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", `attachment; filename="opencode-box-requests-${date}.csv"`);
  return c.body(csv);
});
