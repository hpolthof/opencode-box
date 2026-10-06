import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { StatusPill } from "./theme";
import type { PiProviderStatus } from "../piai/models";
import { formatModelLines, REASONING_LEVELS } from "../piai/customProviders";

export interface CustomFormState {
  mode: "add" | "edit";
  id: string;
  name: string;
  baseUrl: string;
  /** Model lines, "id" or "id | low,high". */
  models: string;
}

interface ProvidersProps {
  providers: PiProviderStatus[];
  loadError?: boolean;
  flash?: { tone: "success" | "error"; message: string };
  /** Reopens the custom-endpoint modal with these values (after a validation error). The flash is then shown inside it. */
  form?: CustomFormState;
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

/** Everything the modal script needs, inlined as JSON (`<` escaped so it can't close the script tag). */
function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const MODAL_SCRIPT = `
(function () {
  var NL = String.fromCharCode(10);
  var LEVELS = JSON.parse(document.getElementById("custom-levels").textContent);
  var known = JSON.parse(document.getElementById("custom-providers-data").textContent);
  var initial = JSON.parse(document.getElementById("custom-form-state").textContent);
  var dialog = document.getElementById("custom-dialog");
  var form = dialog.querySelector("form");
  var list = document.getElementById("model-rows");
  var status = document.getElementById("fetch-status");
  var errorBox = document.getElementById("custom-error");
  var fetchBtn = document.getElementById("fetch-models");
  var providerId = "";

  function setStatus(text, tone) {
    status.textContent = text || "";
    status.className = "fetch-status" + (tone ? " " + tone : "");
  }

  function emptyState() {
    var rows = list.querySelectorAll(".model-row").length;
    document.getElementById("model-empty").hidden = rows > 0;
    document.getElementById("model-count").textContent = rows ? rows + (rows === 1 ? " model" : " models") : "";
  }

  function addRow(id, levels) {
    var row = document.createElement("div");
    row.className = "model-row";
    var input = document.createElement("input");
    input.type = "text";
    input.className = "model-id mono";
    input.placeholder = "model-id";
    input.value = id || "";
    input.setAttribute("aria-label", "Model ID");
    row.appendChild(input);

    var chips = document.createElement("div");
    chips.className = "level-chips";
    chips.title = "Reasoning levels this model accepts (none selected = no reasoning)";
    LEVELS.forEach(function (level) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = level === "minimal" ? "min" : level;
      chip.dataset.level = level;
      var on = (levels || []).indexOf(level) !== -1;
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.addEventListener("click", function () {
        chip.setAttribute("aria-pressed", chip.getAttribute("aria-pressed") === "true" ? "false" : "true");
      });
      chips.appendChild(chip);
    });
    row.appendChild(chips);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.setAttribute("aria-label", "Remove model");
    remove.textContent = "\u00d7";
    remove.addEventListener("click", function () { row.remove(); emptyState(); });
    row.appendChild(remove);

    list.appendChild(row);
    emptyState();
    return input;
  }

  function setModels(text) {
    list.innerHTML = "";
    (text || "").split(NL).forEach(function (line) {
      var parts = line.split("|");
      var id = parts[0].trim();
      if (!id) return;
      var levels = (parts[1] || "").split(",").map(function (l) { return l.trim().toLowerCase(); });
      addRow(id, levels);
    });
    emptyState();
  }

  function serialize() {
    return Array.prototype.map.call(list.querySelectorAll(".model-row"), function (row) {
      var id = row.querySelector(".model-id").value.trim();
      if (!id) return "";
      var levels = Array.prototype.filter.call(row.querySelectorAll(".chip"), function (c) {
        return c.getAttribute("aria-pressed") === "true";
      }).map(function (c) { return c.dataset.level; });
      return levels.length ? id + " | " + levels.join(",") : id;
    }).filter(Boolean).join(NL);
  }

  function open(state, error) {
    var editing = state.mode === "edit";
    providerId = editing ? state.id : "";
    form.action = editing ? "/admin/providers/custom/" + encodeURIComponent(state.id) + "/edit" : "/admin/providers/custom";
    document.getElementById("custom-title").textContent = editing ? "Edit " + state.id : "Add a custom endpoint";
    document.getElementById("custom-submit").textContent = editing ? "Save changes" : "Add provider";
    var id = form.elements.id;
    id.value = state.id || "";
    id.readOnly = editing;
    document.getElementById("custom-id-hint").textContent = editing
      ? "The ID can't be changed."
      : "Lowercase letters, digits and dashes. Its models are addressed as id/model.";
    form.elements.name.value = state.name || "";
    form.elements.baseUrl.value = state.baseUrl || "";
    form.elements.apiKey.value = "";
    form.elements.apiKey.placeholder = editing ? "Leave blank to keep the current key" : "Optional";
    setModels(state.models);
    if (!editing && !list.children.length) addRow("", []);
    setStatus("");
    errorBox.hidden = !error;
    errorBox.textContent = error || "";
    if (!dialog.open) dialog.showModal();
    (editing ? form.elements.baseUrl : id).focus();
  }

  document.getElementById("custom-add").addEventListener("click", function () {
    open({ mode: "add", id: "", name: "", baseUrl: "", models: "" });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-edit-provider]"), function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.getAttribute("data-edit-provider");
      var data = known[id];
      open({ mode: "edit", id: id, name: data.name, baseUrl: data.baseUrl, models: data.models });
    });
  });
  document.getElementById("custom-cancel").addEventListener("click", function () { dialog.close(); });
  // A click on the backdrop lands on the <dialog> itself, outside its box.
  dialog.addEventListener("mousedown", function (e) {
    if (e.target !== dialog) return;
    var r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  document.getElementById("model-add").addEventListener("click", function () { addRow("", []).focus(); });

  fetchBtn.addEventListener("click", function () {
    var baseUrl = form.elements.baseUrl.value.trim();
    if (!baseUrl) { setStatus("Enter the base URL first.", "bad"); form.elements.baseUrl.focus(); return; }
    fetchBtn.disabled = true;
    setStatus("Fetching\u2026");
    fetch("/admin/providers/custom/fetch-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: baseUrl, apiKey: form.elements.apiKey.value, providerId: providerId || undefined }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { setStatus(data.error, "bad"); return; }
        setModels(data.models);
        var withLevels = list.querySelectorAll('.chip[aria-pressed="true"]').length > 0;
        setStatus("Fetched " + list.querySelectorAll(".model-row").length + " models" + (withLevels ? " with reasoning levels" : "") + ".", "good");
      })
      .catch(function () { setStatus("Request failed.", "bad"); })
      .then(function () { fetchBtn.disabled = false; });
  });

  form.addEventListener("submit", function (e) {
    var text = serialize();
    if (!text) {
      e.preventDefault();
      errorBox.hidden = false;
      errorBox.textContent = "Add at least one model.";
      return;
    }
    form.elements.models.value = text;
  });

  if (initial) open(initial, document.getElementById("custom-error").getAttribute("data-initial-error"));
})();
`;

export const Providers: FC<ProvidersProps> = ({ providers, loadError, flash, form }) => {
  const customData = Object.fromEntries(
    providers
      .filter((p) => p.custom)
      .map((p) => [p.id, { name: p.name, baseUrl: p.custom!.baseUrl, models: formatModelLines(p.custom!.models) }])
  );
  const modalError = form && flash?.tone === "error" ? flash.message : undefined;
  return (
    <Layout title="Providers" subtitle="Connect the model providers this gateway serves. See the Models page for what each one offers.">
      {flash && !modalError && <div class={`banner ${flash.tone}`}>{flash.message}</div>}
      {loadError && <div class="banner error">Could not load the providers. Check the server log.</div>}

      <div class="toolbar">
        <button type="button" id="custom-add">
          + Add custom endpoint
        </button>
      </div>

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
                <td>
                  {provider.name}
                  {provider.custom && (
                    <div class="muted mono" style="font-size: 0.75rem; margin-top: 0.15rem;">
                      {provider.custom.baseUrl} · {provider.custom.models.length} {provider.custom.models.length === 1 ? "model" : "models"}
                    </div>
                  )}
                </td>
                <td>{authPill(provider)}</td>
                <td class="actions">
                  {provider.custom && (
                    <>
                      <button type="button" class="row-toggle" data-edit-provider={provider.id}>
                        Edit
                      </button>{" "}
                      <form
                        class="inline"
                        method="post"
                        action={`/admin/providers/custom/${provider.id}/delete`}
                        onsubmit={`return confirm('Remove custom provider ${provider.id}?')`}
                      >
                        <button type="submit" class="danger">
                          Remove
                        </button>
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

      <dialog id="custom-dialog" class="modal" aria-labelledby="custom-title">
        <form method="post" action="/admin/providers/custom">
          <header class="modal-head">
            <div>
              <h2 id="custom-title">Add a custom endpoint</h2>
              <p class="muted">Any server that speaks the OpenAI Chat Completions API: Ollama, vLLM, LiteLLM, LM Studio, a proxy.</p>
            </div>
            <button type="button" class="icon-btn" id="custom-cancel" aria-label="Close">
              &times;
            </button>
          </header>

          <div class="modal-body">
            <div id="custom-error" class="banner error" data-initial-error={modalError ?? ""} hidden></div>

            <div class="field-grid">
              <label class="field">
                <span class="field-label">ID</span>
                <input name="id" required placeholder="my-server" pattern="[a-z0-9][a-z0-9\-]*" maxlength={40} autocomplete="off" />
                <span class="field-hint" id="custom-id-hint"></span>
              </label>
              <label class="field">
                <span class="field-label">Name</span>
                <input name="name" placeholder="My server" autocomplete="off" />
                <span class="field-hint">Shown in this list. Defaults to the ID.</span>
              </label>
              <label class="field span-2">
                <span class="field-label">Base URL</span>
                <input name="baseUrl" type="url" required placeholder="https://example.com/v1" autocomplete="off" />
              </label>
              <label class="field span-2">
                <span class="field-label">API key</span>
                <input name="apiKey" type="password" autocomplete="off" placeholder="Optional" />
              </label>
            </div>

            <section class="models-section">
              <div class="models-head">
                <div>
                  <span class="field-label">Models</span> <span class="muted" id="model-count"></span>
                </div>
                <div class="models-actions">
                  <span id="fetch-status" class="fetch-status" role="status"></span>
                  <button type="button" class="row-toggle" id="fetch-models">
                    Fetch from endpoint
                  </button>
                </div>
              </div>
              <div id="model-rows" class="model-rows"></div>
              <p id="model-empty" class="muted model-empty" hidden>
                No models yet. Fetch them from the endpoint or add one by hand.
              </p>
              <button type="button" class="row-toggle" id="model-add">
                + Add model
              </button>
              <p class="field-hint">
                The chips are the reasoning levels a model accepts as <code>reasoning_effort</code>; leave them off for models without
                reasoning. A fetch fills them in when the endpoint reports them.
              </p>
            </section>
            <input type="hidden" name="models" />
          </div>

          <footer class="modal-foot">
            <button type="button" class="row-toggle" id="custom-cancel-2" onclick="document.getElementById('custom-dialog').close()">
              Cancel
            </button>
            <button type="submit" id="custom-submit">
              Add provider
            </button>
          </footer>
        </form>
      </dialog>

      <script type="application/json" id="custom-levels" dangerouslySetInnerHTML={{ __html: json(REASONING_LEVELS) }} />
      <script type="application/json" id="custom-providers-data" dangerouslySetInnerHTML={{ __html: json(customData) }} />
      <script type="application/json" id="custom-form-state" dangerouslySetInnerHTML={{ __html: json(form ?? null) }} />
      <script dangerouslySetInnerHTML={{ __html: MODAL_SCRIPT }} />

      <h2>Connecting providers</h2>
      <div class="instructions">{INSTRUCTIONS}</div>
    </Layout>
  );
};
