import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { StatusPill } from "./theme";
import type { ProviderSummary } from "../opencode/client";

interface ProvidersProps {
  providers?: ProviderSummary[];
  unreachable?: boolean;
}

const INSTRUCTIONS = `To connect an API-key-based provider: set its API key as an environment variable on the container and reference it from opencode.json using {env:VAR_NAME} syntax, then restart.

To connect a subscription/OAuth-based provider (e.g. a ChatGPT Plus, Claude Pro, or GitHub Copilot subscription): run "docker exec -it <container> opencode auth login" once — this is an interactive login that cannot be automated from this dashboard, but it only needs to be done once since the credentials persist on the mounted /data volume.`;

export const Providers: FC<ProvidersProps> = ({ providers, unreachable }) => {
  return (
    <Layout title="Providers" subtitle="Providers currently connected to OpenCode. See the Models page for what each one offers.">
      {unreachable && <div class="banner error">OpenCode is not reachable. Check that the opencode server is running.</div>}

      {!unreachable && (
        <div class="table-card">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Connected</th>
              </tr>
            </thead>
            <tbody>
              {(providers ?? []).length === 0 && (
                <tr>
                  <td colspan={3} class="muted">
                    No providers found
                  </td>
                </tr>
              )}
              {(providers ?? []).map((provider) => (
                <tr>
                  <td class="mono">{provider.id}</td>
                  <td>{provider.name}</td>
                  <td>
                    {provider.connected ? <StatusPill tone="ok">connected</StatusPill> : <StatusPill tone="muted">not connected</StatusPill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Connecting providers</h2>
      <div class="instructions">{INSTRUCTIONS}</div>
    </Layout>
  );
};
