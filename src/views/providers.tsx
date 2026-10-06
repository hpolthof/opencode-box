import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { StatusPill } from "./theme";
import type { PiProviderStatus } from "../piai/models";
import { formatModelLines } from "../piai/customProviders";

interface ProvidersProps {
  providers: PiProviderStatus[];
  loadError?: boolean;
  flash?: { tone: "success" | "error"; message: string };
  /** Values to refill the "add custom provider" form with after a validation error. */
  form?: Record<string, string>;
}

const INSTRUCTIONS = `Set an API key, or sign in with a subscription account (ChatGPT, Claude Pro/Max, OpenRouter), per provider above. Credentials are stored in the gateway's database on the /data volume, and a provider has one at a time: setting an API key replaces a sign-in and vice versa.

A sign-in opens the provider's login page in a new tab. When it ends on a page that cannot be reached (a localhost address inside the container), copy that final URL from the address bar and paste it back on the sign-in page.

Alternatively, API keys can be set as environment variables on the container (OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY); credentials set here take precedence over them.`;

function authPill(provider: PiProviderStatus) {
  if (provider.custom) return <StatusPill tone="ok">{provider.custom.hasKey ? "custom (API key)" : "custom (no key)"}</StatusPill>;
  if (provider.authType === "oauth") return <StatusPill tone="ok">signed in</StatusPill>;
  if (provider.authType === "api_key") {
    const source = provider.authSource === "stored credential" ? "set here" : provider.authSource;
    return <StatusPill tone="ok">API key{source ? ` (${source})` : ""}</StatusPill>;
  }
  return <StatusPill tone="muted">not configured</StatusPill>;
}

const FETCH_SCRIPT = `
Array.prototype.forEach.call(document.querySelectorAll("form.custom-form"), function (form) {
  var button = form.querySelector(".fetch-models");
  var status = form.querySelector(".fetch-status");
  button.addEventListener("click", function () {
    status.textContent = "Fetching...";
    fetch("/admin/providers/custom/fetch-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: form.elements.baseUrl.value,
        apiKey: form.elements.apiKey.value,
        providerId: form.dataset.providerId || undefined,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { status.textContent = data.error; return; }
        form.elements.models.value = data.models;
        status.textContent = "Fetched " + data.models.split("\\n").length + " models. Review and save.";
      })
      .catch(function () { status.textContent = "Request failed."; });
  });
});
`;

const CustomFields: FC<{ values: Record<string, string>; keepKey?: boolean }> = ({ values, keepKey }) => (
  <>
    <label>
      Name <input name="name" value={values.name ?? ""} placeholder="My server" />
    </label>
    <label>
      Base URL <input name="baseUrl" type="url" required value={values.baseUrl ?? ""} placeholder="https://example.com/v1" />
    </label>
    <label>
      API key{" "}
      <input name="apiKey" type="password" autocomplete="off" placeholder={keepKey ? "leave blank to keep the current key" : "optional"} />
    </label>
    <label>
      Models (one per line, optionally <code>id | low,medium,high</code> for reasoning levels)
      <textarea name="models" required rows={6}>{values.models ?? ""}</textarea>
    </label>
    <p>
      <button type="button" class="fetch-models">Fetch models from endpoint</button> <span class="fetch-status muted"></span>
    </p>
  </>
);

export const Providers: FC<ProvidersProps> = ({ providers, loadError, flash, form }) => {
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
                  {provider.custom && (
                    <>
                      <form class="inline" method="post" action={`/admin/providers/custom/${provider.id}/delete`}>
                        <button type="submit" class="danger">Remove</button>
                      </form>
                    </>
                  )}
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

      {providers.filter((p) => p.custom).map((provider) => (
        <details class="instructions">
          <summary>Edit {provider.id}</summary>
          <form method="post" class="custom-form" data-provider-id={provider.id} action={`/admin/providers/custom/${provider.id}/edit`}>
            <CustomFields values={{ name: provider.name, baseUrl: provider.custom!.baseUrl, models: formatModelLines(provider.custom!.models) }} keepKey />
            <button type="submit">Save</button>
          </form>
        </details>
      ))}

      <h2>Add a custom OpenAI-compatible endpoint</h2>
      <form method="post" class="custom-form" action="/admin/providers/custom">
        <label>
          ID <input name="id" required value={form?.id ?? ""} placeholder="my-server" pattern="[a-z0-9][a-z0-9-]*" />
        </label>
        <CustomFields values={form ?? {}} />
        <button type="submit">Add provider</button>
      </form>
      <p class="muted">
        Any server that speaks the OpenAI Chat Completions API (Ollama, vLLM, LiteLLM, LM Studio, a proxy, ...). Its models are addressed as
        <code> id/model</code>. You can add as many as you like.
      </p>

      <script dangerouslySetInnerHTML={{ __html: FETCH_SCRIPT }} />

      <h2>Connecting providers</h2>
      <div class="instructions">{INSTRUCTIONS}</div>
    </Layout>
  );
};
