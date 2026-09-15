import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { ModelAliasRecord } from "../types";
import type { ModelSummary } from "../opencode/client";

interface AliasesProps {
  aliases: ModelAliasRecord[];
  models?: ModelSummary[];
  modelsUnreachable?: boolean;
  error?: string;
  formValues?: { name: string; model: string; variant: string };
}

const ALIASES_SCRIPT = `
(function () {
  var modelSelect = document.getElementById("alias-model-select");
  var variantSelect = document.getElementById("alias-variant-select");
  if (!modelSelect || !variantSelect) return;

  var variantsByModel = JSON.parse(document.getElementById("alias-model-variants").textContent);
  var preselectedVariant = variantSelect.getAttribute("data-preselect") || "";

  function populate() {
    var variants = variantsByModel[modelSelect.value] || [];
    variantSelect.innerHTML = "";
    if (variants.length === 0) {
      variantSelect.disabled = true;
      variantSelect.appendChild(new Option("Select a model first…", ""));
      return;
    }
    variantSelect.disabled = false;
    variantSelect.appendChild(new Option("Select a variant…", ""));
    variants.forEach(function (v) {
      variantSelect.appendChild(new Option(v, v));
    });
    if (variants.indexOf(preselectedVariant) !== -1) variantSelect.value = preselectedVariant;
  }

  modelSelect.addEventListener("change", function () {
    preselectedVariant = "";
    populate();
  });
  populate();
})();
`;

export const Aliases: FC<AliasesProps> = ({ aliases, models, modelsUnreachable, error, formValues }) => {
  const modelsByProvider = new Map<string, ModelSummary[]>();
  for (const model of models ?? []) {
    const list = modelsByProvider.get(model.providerID) ?? [];
    list.push(model);
    modelsByProvider.set(model.providerID, list);
  }
  const variantsByModel = Object.fromEntries((models ?? []).map((m) => [m.id, m.variants ?? []]));

  return (
    <Layout title="Aliases" subtitle="Custom model names that route to a real model pinned to one reasoning variant.">
      {error && <div class="banner error">{error}</div>}

      <h2>Create a new alias</h2>
      {modelsUnreachable || modelsByProvider.size === 0 ? (
        <p class="muted">
          {modelsUnreachable
            ? "OpenCode is not reachable — can't create an alias right now."
            : "No connected model currently exposes reasoning variants, so there's nothing to alias yet."}
        </p>
      ) : (
        <form class="filters" method="post" action="/admin/aliases">
          <label>
            Alias name
            <input type="text" name="name" placeholder="e.g. gpt-xhigh" value={formValues?.name ?? ""} required />
          </label>
          <label>
            Model
            <select id="alias-model-select" name="model" required>
              <option value="">Select a model…</option>
              {Array.from(modelsByProvider.entries()).map(([providerID, providerModels]) => (
                <optgroup label={providerID}>
                  {providerModels.map((model) => (
                    <option value={model.id} selected={formValues?.model === model.id}>
                      {model.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            Variant
            <select id="alias-variant-select" name="variant" data-preselect={formValues?.variant ?? ""} required disabled>
              <option value="">Select a model first…</option>
            </select>
          </label>
          <button type="submit">Create alias</button>
        </form>
      )}
      <script
        type="application/json"
        id="alias-model-variants"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(variantsByModel).replace(/<\//g, "<\\/") }}
      ></script>
      <script dangerouslySetInnerHTML={{ __html: ALIASES_SCRIPT }}></script>

      <h2>Existing aliases</h2>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Alias</th>
              <th>Routes to</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {aliases.length === 0 && (
              <tr>
                <td colspan={4} class="muted">
                  No aliases yet
                </td>
              </tr>
            )}
            {aliases.map((alias) => (
              <tr>
                <td class="mono">{alias.alias}</td>
                <td class="mono">
                  {alias.providerID}/{alias.modelID}#{alias.variant}
                </td>
                <td>{alias.createdAt}</td>
                <td>
                  <form class="inline" method="post" action={`/admin/aliases/${alias.id}/delete`}>
                    <button type="submit" class="danger">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
};
