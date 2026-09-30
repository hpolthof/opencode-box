import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { StatusPill } from "./theme";
import type { PiProviderStatus } from "../piai/models";

interface ProvidersProps {
  providers: PiProviderStatus[];
  loadError?: boolean;
  flash?: { tone: "success" | "error"; message: string };
}

const INSTRUCTIONS = `Set an API key, or sign in with a subscription account (ChatGPT, Claude Pro/Max, OpenRouter), per provider above. Credentials are stored in the gateway's database on the /data volume, and a provider has one at a time: setting an API key replaces a sign-in and vice versa.

A sign-in opens the provider's login page in a new tab. When it ends on a page that cannot be reached (a localhost address inside the container), copy that final URL from the address bar and paste it back on the sign-in page.

Alternatively, API keys can be set as environment variables on the container (OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY); credentials set here take precedence over them.`;

function authPill(provider: PiProviderStatus) {
  if (provider.authType === "oauth") return <StatusPill tone="ok">signed in</StatusPill>;
  if (provider.authType === "api_key") {
    const source = provider.authSource === "stored credential" ? "set here" : provider.authSource;
    return <StatusPill tone="ok">API key{source ? ` (${source})` : ""}</StatusPill>;
  }
  return <StatusPill tone="muted">not configured</StatusPill>;
}

export const Providers: FC<ProvidersProps> = ({ providers, loadError, flash }) => {
  return (
    <Layout title="Providers" subtitle="Connect the model providers this gateway serves. See the Models page for what each one offers.">
      {flash && <div class={`banner ${flash.tone}`}>{flash.message}</div>}
      {loadError && <div class="banner error">Could not load the providers. Check the server log.</div>}

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
                <td>{authPill(provider)}</td>
                <td class="actions">
                  {provider.supportsApiKey && (
                    <form class="inline" method="post" action={`/admin/providers/${provider.id}/api-key`}>
                      <button type="submit">{provider.authType === "api_key" ? "Change API key" : "Set API key"}</button>
                    </form>
                  )}{" "}
                  {provider.oauthLabel && (
                    <form class="inline" method="post" action={`/admin/providers/${provider.id}/login`}>
                      <button type="submit">{provider.authType === "oauth" ? "Sign in again" : provider.oauthLabel}</button>
                    </form>
                  )}{" "}
                  {provider.hasStoredCredential && (
                    <form class="inline" method="post" action={`/admin/providers/${provider.id}/logout`}>
                      <button type="submit" class="danger">
                        {provider.authType === "oauth" ? "Sign out" : "Remove key"}
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Connecting providers</h2>
      <div class="instructions">{INSTRUCTIONS}</div>
    </Layout>
  );
};
