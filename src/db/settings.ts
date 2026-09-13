import { db } from "./client";

function getSetting(key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function deleteSetting(key: string): void {
  db.query("DELETE FROM settings WHERE key = ?").run(key);
}

const RETENTION_DAYS_KEY = "request_log_retention_days";

/** Automatic-purge threshold in days, or `null` if automatic purging is disabled. */
export function getRetentionDays(): number | null {
  const raw = getSetting(RETENTION_DAYS_KEY);
  if (raw == null) return null;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : null;
}

export function setRetentionDays(days: number | null): void {
  if (days == null || days <= 0) {
    deleteSetting(RETENTION_DAYS_KEY);
  } else {
    setSetting(RETENTION_DAYS_KEY, String(Math.floor(days)));
  }
}

const SOFT_PURGE_KEY = "request_log_soft_purge";

/** Whether the automatic retention job should clear bodies only (soft purge) instead of deleting rows. */
export function getSoftPurgeEnabled(): boolean {
  return getSetting(SOFT_PURGE_KEY) === "1";
}

export function setSoftPurgeEnabled(enabled: boolean): void {
  if (enabled) {
    setSetting(SOFT_PURGE_KEY, "1");
  } else {
    deleteSetting(SOFT_PURGE_KEY);
  }
}
