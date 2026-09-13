import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config";
import { db } from "./client";

export function fileSizeBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Recursively sums file sizes under `path`. Best-effort - never throws. */
export function directorySizeBytes(path: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      total += directorySizeBytes(full);
    } else if (entry.isFile()) {
      total += fileSizeBytes(full);
    }
  }
  return total;
}

export function requestsDbSizeBytes(): number {
  // WAL mode keeps recently-written pages in `-wal` until checkpointed, so
  // the main file alone can understate actual disk usage.
  return fileSizeBytes(CONFIG.dbPath) + fileSizeBytes(`${CONFIG.dbPath}-wal`) + fileSizeBytes(`${CONFIG.dbPath}-shm`);
}

export function opencodeHomeSizeBytes(): number {
  return directorySizeBytes(CONFIG.opencodeHome);
}

/** Reclaims disk space freed by deleted rows. Can take a moment on a large database. */
export function vacuum(): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.exec("VACUUM;");
}
