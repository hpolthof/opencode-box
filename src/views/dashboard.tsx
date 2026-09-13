import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { ModelUsage, AppUsage } from "../db/requests";

interface DashboardProps {
  totals: { requestsToday: number; requestsTotal: number; tokensToday: number; tokensTotal: number };
  modelUsageToday: ModelUsage[];
  modelUsageAll: ModelUsage[];
  appUsageToday: AppUsage[];
  appUsageAll: AppUsage[];
}

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
          <div class="value">{totals.tokensToday}</div>
        </div>
        <div class="stat-card">
          <div class="label">Tokens total</div>
          <div class="value">{totals.tokensTotal}</div>
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
    </Layout>
  );
};

const UsageByModelTable: FC<{ rows: ModelUsage[] }> = ({ rows }) => (
  <div class="table-card">
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Requests</th>
          <th>Total tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colspan={3} class="muted">
              No data
            </td>
          </tr>
        )}
        {rows.map((row) => (
          <tr>
            <td class="mono">{row.model}</td>
            <td>{row.count}</td>
            <td>{row.totalTokens ?? 0}</td>
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
