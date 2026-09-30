import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { StatusPill } from "./theme";
import type { ProviderSummary } from "../opencode/client";
import type { PiProviderStatus } from "../piai/models";

interface ProvidersProps {
  providers?: ProviderSummary[];
  unreachable?: boolean;
  piProviders?: PiProviderStatus[];
  flash?: { tone: "success" | "error"; message: string };
}

const INSTRUCTIONS = `To connect an API-key-based provider: set its API key as an environment variable on the container and reference it from opencode.json using {env:VAR_NAME} syntax, then restart.

To connect a subscription/OAuth-based provider (e.g. a ChatGPT Plus, Claude Pro, or GitHub Copilot subscription): run "docker exec -it <container> opencode auth login" once — this is an interactive login that cannot be automated from this dashboard, but it only needs to be done once since the credentials persist on the mounted /data volume.

The experimental pi-ai providers above can be signed in to directly from this page. The sign-in page opens the provider's login in a new tab; when it ends on a page that cannot be reached (a localhost address inside the container), copy that final URL from the address bar and paste it back.`;

const PiProvidersTable: FC<{ providers: PiProviderStatus[] }> = ({ providers }) => (
  <div class="table-card">
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Name</th>
          <th>Auth</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {providers.map((provider) => (
          <tr>
            <td class="mono">{provider.id}</td>
            <td>{provider.name}</td>
            <td>
              {provider.authType === "oauth" ? (
                <StatusPill tone="ok">signed in</StatusPill>
              ) : provider.authType === "api_key" ? (
                <StatusPill tone="ok">API key{provider.authSource ? ` (${provider.authSource})` : ""}</StatusPill>
              ) : (
                <StatusPill tone="muted">not configured</StatusPill>
              )}
            </td>
            <td class="actions">
              {provider.oauthLabel && (
                <form class="inline" method="post" action={`/admin/providers/pi/${provider.id}/login`}>
                  <button type="submit">{provider.authType === "oauth" ? "Sign in again" : provider.oauthLabel}</button>
                </form>
              )}{" "}
              {provider.hasStoredCredential && (
                <form class="inline" method="post" action={`/admin/providers/pi/${provider.id}/logout`}>
                  <button type="submit" class="danger">
                    Sign out
                  </button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const Providers: FC<ProvidersProps> = ({ providers, unreachable, piProviders, flash }) => {
  return (
    <Layout title="Providers" subtitle="Providers currently connected to OpenCode. See the Models page for what each one offers.">
      {flash && <div class={`banner ${flash.tone}`}>{flash.message}</div>}
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

      {piProviders && (
        <>
          <h2>pi-ai providers (experimental)</h2>
          <p class="muted">
            Used by <code>pi/&lt;provider&gt;/&lt;model&gt;</code> model ids. A dashboard sign-in takes precedence over an
            API key from the environment.
          </p>
          <PiProvidersTable providers={piProviders} />
        </>
      )}

      <h2>Connecting providers</h2>
      <div class="instructions">{INSTRUCTIONS}</div>
    </Layout>
  );
};
