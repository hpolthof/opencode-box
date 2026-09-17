import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { ModelUsage, AppUsage } from "../db/requests";
import { formatCost } from "../pricing";

interface ModelUsageWithCost extends ModelUsage {
  estimatedCost: number | null;
  costEstimated: boolean;
}

interface DashboardProps {
  totals: { requestsToday: number; requestsTotal: number; tokensToday: number; tokensTotal: number };
  modelUsageToday: ModelUsageWithCost[];
  modelUsageAll: ModelUsageWithCost[];
  appUsageToday: AppUsage[];
  appUsageAll: AppUsage[];
}

// Token counts can run into the millions, so they're rendered as raw digits
// server-side and reformatted with thousands separators here - client-side,
// like the Requests page's timestamps, so they follow the viewer's own
// locale (comma vs period as the separator) rather than a hardcoded one.
const SCRIPT = `
(function () {
  Array.prototype.forEach.call(document.querySelectorAll(".fmt-number"), function (el) {
    var n = Number(el.textContent);
    if (Number.isFinite(n)) el.textContent = n.toLocaleString();
  });
})();
`;

export const Dashboard: FC<DashboardProps> = ({ totals, modelUsageToday, modelUsageAll, appUsageToday, appUsageAll }) => {
  return (
    <Layout title="Dashboard" subtitle="Usage and token consumption across models and apps.">
      <div class="stat-row">
        <div class="stat-card">
          <div class="label">Requests today</div>
          <div class="value">{totals.requestsToday}</div>
        </div>
        <div class="stat-card">
          <div class="label">Requests total</div>
          <div class="value">{totals.requestsTotal}</div>
        </div>
        <div class="stat-card">
          <div class="label">Tokens today</div>
          <div class="value fmt-number">{totals.tokensToday}</div>
        </div>
        <div class="stat-card">
          <div class="label">Tokens total</div>
          <div class="value fmt-number">{totals.tokensTotal}</div>
        </div>
      </div>

      <h2>Usage by model (today)</h2>
      <UsageByModelTable rows={modelUsageToday} />

      <h2>Usage by model (all time)</h2>
      <UsageByModelTable rows={modelUsageAll} />

      <h2>Usage by app (today)</h2>
      <UsageByAppTable rows={appUsageToday} />

      <h2>Usage by app (all time)</h2>
      <UsageByAppTable rows={appUsageAll} />

      <script dangerouslySetInnerHTML={{ __html: SCRIPT }}></script>
    </Layout>
  );
};

const UsageByModelTable: FC<{ rows: ModelUsageWithCost[] }> = ({ rows }) => (
  <div class="table-card">
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Requests</th>
          <th>Total tokens</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colspan={4} class="muted">
              No data
            </td>
          </tr>
        )}
        {rows.map((row) => (
          <tr>
            <td class="mono">{row.model}</td>
            <td>{row.count}</td>
            <td class="fmt-number">{row.totalTokens ?? 0}</td>
            <td class="mono">
              {row.costEstimated && row.estimatedCost !== null ? "~" : ""}
              {formatCost(row.estimatedCost)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const UsageByAppTable: FC<{ rows: AppUsage[] }> = ({ rows }) => (
  <div class="table-card">
    <table>
      <thead>
        <tr>
          <th>App</th>
          <th>Requests</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colspan={2} class="muted">
              No data
            </td>
          </tr>
        )}
        {rows.map((row) => (
          <tr>
            <td>{row.appName}</td>
            <td>{row.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
