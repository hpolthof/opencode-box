import { getRetentionDays, getSoftPurgeEnabled } from "./settings";
import { purgeRequestsOlderThan, softPurgeRequestsOlderThan } from "./requests";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for a day-granularity retention setting

function runOnce(): void {
  const days = getRetentionDays();
  if (days == null) return;

  const soft = getSoftPurgeEnabled();
  const affected = soft ? softPurgeRequestsOlderThan(days) : purgeRequestsOlderThan(days);
  if (affected > 0) {
    console.log(`[retention] ${soft ? "soft-purged" : "purged"} ${affected} request log row(s) older than ${days} day(s)`);
  }
}

/** Runs the configured request-log retention purge immediately, then hourly. */
export function startRetentionJob(): { stop: () => void } {
  runOnce();
  const interval = setInterval(runOnce, CHECK_INTERVAL_MS);
  return { stop: () => clearInterval(interval) };
}
