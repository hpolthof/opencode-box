import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { ModelAliasMode, ModelAliasRecord } from "../types";
import type { ModelSummary } from "../opencode/client";

interface AliasesProps {
  aliases: ModelAliasRecord[];
  models?: ModelSummary[];
  modelsUnreachable?: boolean;
  error?: string;
  formValues?: { name: string; mode: ModelAliasMode; targets: { model: string; variant: string }[] };
}

const ALIASES_SCRIPT = `
(function () {
  var targetsContainer = document.getElementById("alias-targets");
  var addBtn = document.getElementById("alias-add-target");
  if (!targetsContainer || !addBtn) return;

  var modelsByProvider = JSON.parse(document.getElementById("alias-models-by-provider").textContent);
  var variantsByModel = JSON.parse(document.getElementById("alias-model-variants").textContent);
  var initialTargets = JSON.parse(document.getElementById("alias-initial-targets").textContent);
  if (initialTargets.length === 0) initialTargets = [{ model: "", variant: "" }];

  function createTargetRow(selectedModel, selectedVariant) {
    var row = document.createElement("div");
    row.className = "alias-target-row";

    var modelSelect = document.createElement("select");
    modelSelect.name = "targetModel";
    modelSelect.required = true;
    modelSelect.appendChild(new Option("Select a model…", ""));
    Object.keys(modelsByProvider).forEach(function (providerID) {
      var group = document.createElement("optgroup");
      group.label = providerID;
      modelsByProvider[providerID].forEach(function (id) {
        group.appendChild(new Option(id, id, false, id === selectedModel));
      });
      modelSelect.appendChild(group);
    });

    var variantSelect = document.createElement("select");
    variantSelect.name = "targetVariant";
    variantSelect.required = true;

    function populateVariants() {
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
        variantSelect.appendChild(new Option(v, v, false, v === selectedVariant));
      });
    }
    populateVariants();
    modelSelect.addEventListener("change", populateVariants);

    var upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "row-toggle";
    upBtn.textContent = "\\u2191";
    upBtn.title = "Move up (priority mode)";
    upBtn.addEventListener("click", function () {
      var prev = row.previousElementSibling;
      if (prev) row.parentNode.insertBefore(row, prev);
    });

    var downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "row-toggle";
    downBtn.textContent = "\\u2193";
    downBtn.title = "Move down (priority mode)";
    downBtn.addEventListener("click", function () {
      var next = row.nextElementSibling;
      if (next) row.parentNode.insertBefore(next, row);
    });

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", function () {
      if (targetsContainer.children.length > 1) row.remove();
    });

    row.appendChild(modelSelect);
    row.appendChild(variantSelect);
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(removeBtn);
    return row;
  }

  initialTargets.forEach(function (t) {
    targetsContainer.appendChild(createTargetRow(t.model, t.variant));
  });

  addBtn.addEventListener("click", function () {
    targetsContainer.appendChild(createTargetRow("", ""));
  });
})();
`;

export const Aliases: FC<AliasesProps> = ({ aliases, models, modelsUnreachable, error, formValues }) => {
  const modelsByProvider = new Map<string, ModelSummary[]>();
  for (const model of models ?? []) {
    const list = modelsByProvider.get(model.providerID) ?? [];
    list.push(model);
    modelsByProvider.set(model.providerID, list);
  }
  const modelsByProviderJson = JSON.stringify(
    Object.fromEntries(Array.from(modelsByProvider.entries()).map(([providerID, list]) => [providerID, list.map((m) => m.id)]))
  ).replace(/<\//g, "<\\/");
  const variantsByModelJson = JSON.stringify(Object.fromEntries((models ?? []).map((m) => [m.id, m.variants ?? []]))).replace(
    /<\//g,
    "<\\/"
  );
  const initialTargetsJson = JSON.stringify(formValues?.targets ?? []).replace(/<\//g, "<\\/");
  const mode: ModelAliasMode = formValues?.mode ?? "priority";

  return (
    <Layout title="Aliases" subtitle="Custom model names that route to one or more real models, pinned to a reasoning variant.">
      {error && <div class="banner error">{error}</div>}

      <h2>Create a new alias</h2>
      {modelsUnreachable || modelsByProvider.size === 0 ? (
        <p class="muted">
          {modelsUnreachable
            ? "OpenCode is not reachable — can't create an alias right now."
            : "No connected model currently exposes reasoning variants, so there's nothing to alias yet."}
        </p>
      ) : (
        <form method="post" action="/admin/aliases">
          <div class="filters" style="margin-bottom: 1rem;">
            <label>
              Alias name
              <input type="text" name="name" placeholder="e.g. gpt-xhigh" value={formValues?.name ?? ""} required />
            </label>
            <label>
              Mode
              <select name="mode">
                <option value="priority" selected={mode !== "random"}>
                  Priority — try in order, fail over on error
                </option>
                <option value="random" selected={mode === "random"}>
                  Random — fresh random order per request, fail over on error
                </option>
              </select>
            </label>
          </div>

          <div class="detail-panel-label">
            Target models{" "}
            <span class="muted" style="font-weight: 400;">
              — order matters for "priority" mode; a failed or non-responsive target falls over to the next one either way
            </span>
          </div>
          <div id="alias-targets"></div>
          <button type="button" id="alias-add-target" class="row-toggle" style="margin: 0.5rem 0 1rem;">
            + Add another model
          </button>

          <div>
            <button type="submit">Create alias</button>
          </div>
        </form>
      )}
      <script type="application/json" id="alias-models-by-provider" dangerouslySetInnerHTML={{ __html: modelsByProviderJson }}></script>
      <script type="application/json" id="alias-model-variants" dangerouslySetInnerHTML={{ __html: variantsByModelJson }}></script>
      <script type="application/json" id="alias-initial-targets" dangerouslySetInnerHTML={{ __html: initialTargetsJson }}></script>
      <script dangerouslySetInnerHTML={{ __html: ALIASES_SCRIPT }}></script>

      <h2>Existing aliases</h2>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Alias</th>
              <th>Mode</th>
              <th>Targets</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {aliases.length === 0 && (
              <tr>
                <td colspan={5} class="muted">
                  No aliases yet
                </td>
              </tr>
            )}
            {aliases.map((alias) => (
              <tr>
                <td class="mono">{alias.alias}</td>
                <td>{alias.mode}</td>
                <td class="mono">
                  {alias.targets.map((t, i) => (
                    <div>
                      {alias.mode === "priority" ? `${i + 1}. ` : ""}
                      {t.providerID}/{t.modelID}#{t.variant}
                    </div>
                  ))}
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
