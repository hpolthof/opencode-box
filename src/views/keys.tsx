import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { StatusPill } from "./theme";
import type { ApiKeyRecord } from "../types";
import type { ModelSummary } from "../opencode/client";

interface KeysProps {
  keys: ApiKeyRecord[];
  models?: ModelSummary[];
  modelsUnreachable?: boolean;
  newKey?: { name: string; rawKey: string };
  error?: string;
}

const MODEL_PICKER_SCRIPT = `
(function () {
  var details = document.querySelector("details.model-picker");
  if (!details) return;
  var label = details.querySelector(".model-picker-label");
  var checkboxes = details.querySelectorAll('input[type="checkbox"]');
  function update() {
    var checked = Array.prototype.filter.call(checkboxes, function (cb) { return cb.checked; });
    label.textContent = checked.length === 0
      ? "All models (unrestricted)"
      : checked.length + " model" + (checked.length === 1 ? "" : "s") + " selected";
  }
  Array.prototype.forEach.call(checkboxes, function (cb) {
    cb.addEventListener("change", update);
  });
  document.addEventListener("click", function (e) {
    if (!details.contains(e.target)) details.removeAttribute("open");
  });
  update();
})();
`;

export const Keys: FC<KeysProps> = ({ keys, models, modelsUnreachable, newKey, error }) => {
  const modelsByProvider = new Map<string, ModelSummary[]>();
  for (const model of models ?? []) {
    const list = modelsByProvider.get(model.providerID) ?? [];
    list.push(model);
    modelsByProvider.set(model.providerID, list);
  }

  return (
    <Layout title="Keys" subtitle="Issue and revoke API keys for client applications.">
      {error && <div class="banner error">{error}</div>}

      {newKey && (
        <div class="banner success">
          <strong>
            Key "{newKey.name}" created — copy it now, it will never be shown again:
          </strong>
          <div>
            <pre>{newKey.rawKey}</pre>
          </div>
        </div>
      )}

      <h2>Create a new key</h2>
      <form class="filters" method="post" action="/admin/keys">
        <label>
          Name
          <input type="text" name="name" required />
        </label>
        <label>
          Allowed models
          {modelsUnreachable || modelsByProvider.size === 0 ? (
            <div class="model-picker">
              <div class="model-picker-empty" style="padding: 0.5rem 0;">
                {modelsUnreachable ? "OpenCode is not reachable — key will be unrestricted." : "No models available."}
              </div>
            </div>
          ) : (
            <details class="model-picker">
              <summary>
                <span class="model-picker-label">All models (unrestricted)</span>
              </summary>
              <div class="model-picker-panel">
                {Array.from(modelsByProvider.entries()).map(([providerID, providerModels]) => (
                  <div class="model-picker-group">
                    <div class="model-picker-group-label">{providerID}</div>
                    {providerModels.map((model) => (
                      <label class="model-picker-option">
                        <input type="checkbox" name="allowedModels" value={model.id} />
                        <span class="mono">{model.id}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          )}
        </label>
        <button type="submit">Create key</button>
      </form>

      <script dangerouslySetInnerHTML={{ __html: MODEL_PICKER_SCRIPT }}></script>

      <h2>Existing keys</h2>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key prefix</th>
              <th>Allowed models</th>
              <th>Created</th>
              <th>Status</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colspan={7} class="muted">
                  No keys yet
                </td>
              </tr>
            )}
            {keys.map((key) => (
              <tr>
                <td>{key.name}</td>
                <td>
                  <code>{key.keyPrefix}…</code>
                </td>
                <td>{key.allowedModels && key.allowedModels.length > 0 ? key.allowedModels.join(", ") : "all"}</td>
                <td>{key.createdAt}</td>
                <td>
                  {key.revokedAt ? (
                    <StatusPill tone="muted">revoked {key.revokedAt}</StatusPill>
                  ) : (
                    <StatusPill tone="ok">active</StatusPill>
                  )}
                </td>
                <td>{key.lastUsedAt ?? "never"}</td>
                <td>
                  {key.revokedAt ? (
                    <span class="muted">—</span>
                  ) : (
                    <form class="inline" method="post" action={`/admin/keys/${key.id}/revoke`}>
                      <button type="submit" class="danger">
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
};
