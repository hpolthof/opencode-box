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

const KEYS_SCRIPT = `
(function () {
  function updateModelPickerLabel(details) {
    var label = details.querySelector(".model-picker-label");
    var checkboxes = details.querySelectorAll('input[type="checkbox"]');
    var checked = Array.prototype.filter.call(checkboxes, function (cb) { return cb.checked; });
    label.textContent = checked.length === 0
      ? "All models (unrestricted)"
      : checked.length + " model" + (checked.length === 1 ? "" : "s") + " selected";
  }

  Array.prototype.forEach.call(document.querySelectorAll("details.model-picker"), function (details) {
    var checkboxes = details.querySelectorAll('input[type="checkbox"]');
    Array.prototype.forEach.call(checkboxes, function (cb) {
      cb.addEventListener("change", function () { updateModelPickerLabel(details); });
    });
  });

  document.addEventListener("click", function (e) {
    Array.prototype.forEach.call(document.querySelectorAll("details.model-picker[open]"), function (d) {
      if (!d.contains(e.target)) d.removeAttribute("open");
    });
  });

  var table = document.getElementById("keys-table");
  if (!table) return;
  table.addEventListener("click", function (e) {
    var toggle = e.target.closest(".row-toggle");
    if (!toggle) return;
    var editRow = toggle.closest("tr").nextElementSibling;
    if (!editRow) return;

    var nowHidden = !editRow.hidden;
    editRow.hidden = nowHidden;
    toggle.textContent = nowHidden ? "Edit" : "Cancel";

    // Closing without saving: reset the form so a re-opened picker shows
    // the still-current allowed models, not whatever was left half-checked.
    if (nowHidden) {
      var form = editRow.querySelector("form");
      if (form) form.reset();
      var picker = editRow.querySelector("details.model-picker");
      if (picker) {
        picker.removeAttribute("open");
        updateModelPickerLabel(picker);
      }
    }
  });
})();
`;

const ModelPicker: FC<{
  modelsByProvider: Map<string, ModelSummary[]>;
  modelsUnreachable?: boolean;
  name: string;
  selected: Set<string>;
}> = ({ modelsByProvider, modelsUnreachable, name, selected }) => {
  if (modelsUnreachable || modelsByProvider.size === 0) {
    return (
      <div class="model-picker">
        <div class="model-picker-empty" style="padding: 0.5rem 0;">
          {modelsUnreachable ? "OpenCode is not reachable — key will be unrestricted." : "No models available."}
        </div>
      </div>
    );
  }

  const label = selected.size === 0 ? "All models (unrestricted)" : `${selected.size} model${selected.size === 1 ? "" : "s"} selected`;

  return (
    <details class="model-picker">
      <summary>
        <span class="model-picker-label">{label}</span>
      </summary>
      <div class="model-picker-panel">
        {Array.from(modelsByProvider.entries()).map(([providerID, providerModels]) => (
          <div class="model-picker-group">
            <div class="model-picker-group-label">{providerID}</div>
            {providerModels.map((model) => (
              <label class="model-picker-option">
                <input type="checkbox" name={name} value={model.id} checked={selected.has(model.id)} />
                <span class="mono">{model.id}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
};

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
          <ModelPicker modelsByProvider={modelsByProvider} modelsUnreachable={modelsUnreachable} name="allowedModels" selected={new Set()} />
        </label>
        <button type="submit">Create key</button>
      </form>

      <h2>Existing keys</h2>
      <div class="table-card">
        <table id="keys-table">
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
              <>
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
                      <>
                        <button type="button" class="row-toggle">
                          Edit
                        </button>{" "}
                        <form class="inline" method="post" action={`/admin/keys/${key.id}/revoke`}>
                          <button type="submit" class="danger">
                            Revoke
                          </button>
                        </form>
                      </>
                    )}
                  </td>
                </tr>
                {!key.revokedAt && (
                  <tr class="detail-row key-edit-row" hidden>
                    <td colspan={7}>
                      <form class="key-edit-panel filters" method="post" action={`/admin/keys/${key.id}/allowed-models`}>
                        <label>
                          Allowed models
                          <ModelPicker
                            modelsByProvider={modelsByProvider}
                            modelsUnreachable={modelsUnreachable}
                            name="allowedModels"
                            selected={new Set(key.allowedModels ?? [])}
                          />
                        </label>
                        <button type="submit">Save allowed models</button>
                      </form>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      <script dangerouslySetInnerHTML={{ __html: KEYS_SCRIPT }}></script>
    </Layout>
  );
};
