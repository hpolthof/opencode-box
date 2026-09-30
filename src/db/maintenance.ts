import { statSync } from "node:fs";
import { CONFIG } from "../config";
import { db } from "./client";

export function fileSizeBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function requestsDbSizeBytes(): number {
  // WAL mode keeps recently-written pages in `-wal` until checkpointed, so
  // the main file alone can understate actual disk usage.
  return fileSizeBytes(CONFIG.dbPath) + fileSizeBytes(`${CONFIG.dbPath}-wal`) + fileSizeBytes(`${CONFIG.dbPath}-shm`);
}

/** Reclaims disk space freed by deleted rows. Can take a moment on a large database. */
export function vacuum(): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.exec("VACUUM;");
}
