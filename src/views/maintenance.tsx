import type { FC } from "hono/jsx";
import { Layout } from "./layout";

interface MaintenanceProps {
  totalRequests: number;
  oldestRequestDate: string | null;
  dbSizeBytes: number;
  opencodeHomeSizeBytes: number;
  retentionDays: number | null;
  softPurgeEnabled: boolean;
  requestCountsByThreshold: { days: number; count: number }[];
  revokedKeyCountsByThreshold: { days: number; count: number }[];
  success?: string;
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

const STYLE = `
  .maint-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.1rem; margin-bottom: 2rem; }
  .maint-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1.25rem 1.4rem; }
  .maint-card h3 { margin: 0 0 0.9rem; color: var(--fg); font-size: 0.95rem; }
  .maint-card p.hint { margin: 0.5rem 0 0.9rem; color: var(--fg-muted); font-size: 0.8rem; line-height: 1.5; }
  .maint-row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .maint-row select { flex: 1; min-width: 200px; }
  .maint-card form + form { margin-top: 0.9rem; }
  .maint-check { display: flex; align-items: center; gap: 0.45rem; font-size: 0.8rem; color: var(--fg-muted); cursor: pointer; width: 100%; margin-top: 0.5rem; }
  .maint-check input { accent-color: var(--accent); margin: 0; }
`;

const SCRIPT = `
(function () {
  document.querySelectorAll("form.purge-form").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      var select = form.querySelector("select[name=scope]");
      var label = select.options[select.selectedIndex].textContent;
      var softCheckbox = form.querySelector('input[name="soft"]');
      var soft = !!(softCheckbox && softCheckbox.checked);
      var prefix = soft
        ? form.getAttribute("data-confirm-prefix-soft") || "Clear stored bodies for"
        : form.getAttribute("data-confirm-prefix") || "Purge";
      if (!window.confirm(prefix + ": " + label + "?\\n\\nThis cannot be undone.")) {
        e.preventDefault();
      }
    });
  });
})();
`;

export const Maintenance: FC<MaintenanceProps> = ({
  totalRequests,
  oldestRequestDate,
  dbSizeBytes,
  opencodeHomeSizeBytes,
  retentionDays,
  softPurgeEnabled,
  requestCountsByThreshold,
  revokedKeyCountsByThreshold,
  success,
  error,
}) => {
  return (
    <Layout title="Maintenance" subtitle="Keep the gateway's own storage in check — purge old logs, reclaim disk space, and set an automatic retention policy.">
      <style dangerouslySetInnerHTML={{ __html: STYLE }}></style>

      {error && <div class="banner error">{error}</div>}
      {success && <div class="banner success">{success}</div>}

      <div class="stat-row">
        <div class="stat-card">
          <div class="label">Request log rows</div>
          <div class="value">{totalRequests}</div>
        </div>
        <div class="stat-card">
          <div class="label">Oldest log entry</div>
          <div class="value" style="font-size: 1.05rem;">
            {oldestRequestDate ?? "—"}
          </div>
        </div>
        <div class="stat-card">
          <div class="label">Database size on disk</div>
          <div class="value">{formatBytes(dbSizeBytes)}</div>
        </div>
        <div class="stat-card">
          <div class="label">OpenCode home size</div>
          <div class="value">{formatBytes(opencodeHomeSizeBytes)}</div>
        </div>
      </div>

      <div class="maint-grid">
        <div class="maint-card">
          <h3>Automatic purge</h3>
          <p class="hint">
            {retentionDays
              ? `Currently enabled — hourly job ${softPurgeEnabled ? "clears bodies on" : "deletes"} request logs older than ${retentionDays} day(s).`
              : "Currently disabled — request logs are kept forever until purged manually."}
          </p>
          <form method="post" action="/admin/maintenance/retention" class="maint-row">
            <input type="number" name="retentionDays" min="1" step="1" placeholder="Days (empty = disabled)" value={retentionDays ?? ""} style="flex: 1; min-width: 160px;" />
            <button type="submit">Save</button>
            <label class="maint-check">
              <input type="checkbox" name="soft" checked={softPurgeEnabled} />
              Soft purge — only clear request/response bodies, keep the row for stats
            </label>
          </form>
        </div>

        <div class="maint-card">
          <h3>Purge request logs now</h3>
          <p class="hint">Deletes matching rows immediately. Run "Vacuum" afterwards to actually shrink the database file.</p>
          <form
            method="post"
            action="/admin/maintenance/purge-requests"
            class="purge-form maint-row"
            data-confirm-prefix="Delete request logs"
            data-confirm-prefix-soft="Clear stored bodies on request logs"
          >
            <select name="scope">
              {requestCountsByThreshold.map(({ days, count }) => (
                <option value={String(days)}>
                  Older than {days} days ({count} rows)
                </option>
              ))}
              <option value="all">All requests ({totalRequests} rows)</option>
            </select>
            <button type="submit" class="danger">
              Purge
            </button>
            <label class="maint-check">
              <input type="checkbox" name="soft" />
              Soft purge — only clear request/response bodies, keep the row for stats
            </label>
          </form>
        </div>

        <div class="maint-card">
          <h3>Purge revoked API keys</h3>
          <p class="hint">Revoking a key keeps it around for the audit trail. Old revoked keys can be deleted once you no longer need that history.</p>
          <form method="post" action="/admin/maintenance/purge-revoked-keys" class="purge-form maint-row" data-confirm-prefix="Delete revoked API keys">
            <select name="scope">
              {revokedKeyCountsByThreshold.map(({ days, count }) => (
                <option value={String(days)}>
                  Revoked more than {days} days ago ({count})
                </option>
              ))}
              <option value="all">All revoked keys</option>
            </select>
            <button type="submit" class="danger">
              Purge
            </button>
          </form>
        </div>

        <div class="maint-card">
          <h3>Reclaim disk space</h3>
          <p class="hint">SQLite doesn't shrink its file automatically after deletes. Vacuum rewrites the database file, freeing that space back to disk. Can take a moment on a large database.</p>
          <form method="post" action="/admin/maintenance/vacuum">
            <button type="submit">Vacuum database</button>
          </form>
        </div>

        <div class="maint-card">
          <h3>Export before you purge</h3>
          <p class="hint">
            Downloads the full request log (metadata only — model, tokens, latency, status; not the request/response bodies) as CSV, so you
            keep the numbers even after purging.
          </p>
          <a href="/admin/maintenance/export.csv" download>
            Download CSV →
          </a>
        </div>
      </div>

      <script dangerouslySetInnerHTML={{ __html: SCRIPT }}></script>
    </Layout>
  );
};
