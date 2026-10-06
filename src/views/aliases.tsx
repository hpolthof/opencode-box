import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { ModelAliasMode, ModelAliasRecord } from "../types";
import type { ModelSummary } from "../catalog";

export interface AliasFormState {
  mode: "add" | "edit";
  /** Set when editing. */
  id?: number;
  name: string;
  aliasMode: ModelAliasMode;
  clientEffortOverrides: boolean;
  targets: { model: string; variant: string }[];
}

interface AliasesProps {
  aliases: ModelAliasRecord[];
  models?: ModelSummary[];
  modelsUnreachable?: boolean;
  /** A save error. Shown inside the modal when `form` reopens it, otherwise above the page. */
  error?: string;
  /** Reopens the modal with these values (after a validation error). */
  form?: AliasFormState;
}

/** JSON for a `<script type="application/json">` block (`<` escaped so it can't close the tag). */
function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const ALIASES_SCRIPT = `
(function () {
  var dialog = document.getElementById("alias-dialog");
  var openBtn = document.getElementById("alias-add");
  if (!dialog) return;

  var form = dialog.querySelector("form");
  var targetsContainer = document.getElementById("alias-targets");
  var errorBox = document.getElementById("alias-error");
  var modelsByProvider = JSON.parse(document.getElementById("alias-models-by-provider").textContent);
  var variantsByModel = JSON.parse(document.getElementById("alias-model-variants").textContent);
  var aliasesById = JSON.parse(document.getElementById("alias-existing").textContent);
  var initial = JSON.parse(document.getElementById("alias-form-state").textContent);

  function renumber() {
    Array.prototype.forEach.call(targetsContainer.children, function (row, i) {
      row.querySelector(".target-index").textContent = String(i + 1);
    });
    var only = targetsContainer.children.length <= 1;
    Array.prototype.forEach.call(targetsContainer.querySelectorAll(".target-remove"), function (b) { b.disabled = only; });
  }

  function createTargetRow(selectedModel, selectedVariant) {
    var row = document.createElement("div");
    row.className = "target-row";

    var index = document.createElement("span");
    index.className = "target-index";
    row.appendChild(index);

    var modelSelect = document.createElement("select");
    modelSelect.name = "targetModel";
    modelSelect.required = true;
    modelSelect.setAttribute("aria-label", "Model");
    modelSelect.appendChild(new Option("Select a model\\u2026", ""));
    var present = false;
    Object.keys(modelsByProvider).forEach(function (providerID) {
      var group = document.createElement("optgroup");
      group.label = providerID;
      modelsByProvider[providerID].forEach(function (id) {
        if (id === selectedModel) present = true;
        group.appendChild(new Option(id, id, false, id === selectedModel));
      });
      modelSelect.appendChild(group);
    });
    // The alias's stored target may belong to a provider that is not connected right now: keep showing it.
    var local = variantsByModel;
    if (selectedModel && !present) {
      modelSelect.insertBefore(new Option(selectedModel + " (unavailable)", selectedModel, false, true), modelSelect.children[1]);
      if (!local[selectedModel]) { local = Object.assign({}, variantsByModel); local[selectedModel] = selectedVariant ? [selectedVariant] : []; }
    }

    var variantSelect = document.createElement("select");
    variantSelect.name = "targetVariant";
    variantSelect.required = true;
    variantSelect.setAttribute("aria-label", "Reasoning variant");

    function populateVariants(keep) {
      var variants = local[modelSelect.value] || [];
      variantSelect.innerHTML = "";
      if (variants.length === 0) {
        variantSelect.disabled = true;
        variantSelect.appendChild(new Option("Select a model first\\u2026", ""));
        return;
      }
      variantSelect.disabled = false;
      variantSelect.appendChild(new Option("Select a variant\\u2026", ""));
      variants.forEach(function (v) {
        variantSelect.appendChild(new Option(v, v, false, v === keep));
      });
    }
    populateVariants(selectedVariant);
    modelSelect.addEventListener("change", function () { populateVariants(""); });

    function iconButton(label, title, handler, extra) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icon-btn " + (extra || "");
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.addEventListener("click", handler);
      return btn;
    }
    var up = iconButton("\\u2191", "Move up", function () {
      var prev = row.previousElementSibling;
      if (prev) { row.parentNode.insertBefore(row, prev); renumber(); }
    });
    var down = iconButton("\\u2193", "Move down", function () {
      var next = row.nextElementSibling;
      if (next) { row.parentNode.insertBefore(next, row); renumber(); }
    });
    var remove = iconButton("\\u00d7", "Remove target", function () {
      if (targetsContainer.children.length > 1) { row.remove(); renumber(); }
    }, "target-remove");

    row.appendChild(modelSelect);
    row.appendChild(variantSelect);
    row.appendChild(up);
    row.appendChild(down);
    row.appendChild(remove);
    return row;
  }

  function open(state, error) {
    var editing = state.mode === "edit";
    form.action = editing ? "/admin/aliases/" + state.id + "/edit" : "/admin/aliases";
    document.getElementById("alias-title").textContent = editing ? "Edit alias" : "Create an alias";
    document.getElementById("alias-submit").textContent = editing ? "Save changes" : "Create alias";
    form.elements.name.value = state.name || "";
    form.elements.mode.value = state.aliasMode || "priority";
    form.elements.clientEffortOverrides.checked = Boolean(state.clientEffortOverrides);
    targetsContainer.innerHTML = "";
    var targets = state.targets && state.targets.length ? state.targets : [{ model: "", variant: "" }];
    targets.forEach(function (t) { targetsContainer.appendChild(createTargetRow(t.model, t.variant)); });
    renumber();
    errorBox.hidden = !error;
    errorBox.textContent = error || "";
    if (!dialog.open) dialog.showModal();
    form.elements.name.focus();
  }

  if (openBtn) {
    openBtn.addEventListener("click", function () {
      open({ mode: "add", name: "", aliasMode: "priority", clientEffortOverrides: false, targets: [] });
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-edit-alias]"), function (btn) {
    btn.addEventListener("click", function () {
      var a = aliasesById[btn.getAttribute("data-edit-alias")];
      open({
        mode: "edit", id: a.id, name: a.name, aliasMode: a.mode, clientEffortOverrides: a.clientEffortOverrides,
        targets: a.targets,
      });
    });
  });
  document.getElementById("alias-add-target").addEventListener("click", function () {
    var row = createTargetRow("", "");
    targetsContainer.appendChild(row);
    renumber();
    row.querySelector("select").focus();
  });
  Array.prototype.forEach.call(dialog.querySelectorAll("[data-close]"), function (btn) {
    btn.addEventListener("click", function () { dialog.close(); });
  });
  // A click on the backdrop lands on the <dialog> itself, outside its box.
  dialog.addEventListener("mousedown", function (e) {
    if (e.target !== dialog) return;
    var r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });

  if (initial) open(initial, errorBox.getAttribute("data-initial-error"));
})();
`;

export const Aliases: FC<AliasesProps> = ({ aliases, models, modelsUnreachable, error, form }) => {
  const modelsByProvider = new Map<string, ModelSummary[]>();
  for (const model of models ?? []) {
    const list = modelsByProvider.get(model.providerID) ?? [];
    list.push(model);
    modelsByProvider.set(model.providerID, list);
  }
  const modelsByProviderObj = Object.fromEntries(
    Array.from(modelsByProvider.entries()).map(([providerID, list]) => [providerID, list.map((m) => m.id)])
  );
  const variantsByModelObj = Object.fromEntries((models ?? []).map((m) => [m.id, m.variants ?? []]));
  const existingObj = Object.fromEntries(
    aliases.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.alias,
        mode: a.mode,
        clientEffortOverrides: a.clientEffortOverrides,
        targets: a.targets.map((t) => ({ model: `${t.providerID}/${t.modelID}`, variant: t.variant })),
      },
    ])
  );
  const canCreate = !modelsUnreachable && modelsByProvider.size > 0;
  const modalError = form ? error : undefined;

  return (
    <Layout title="Aliases" subtitle="Custom model names that route to one or more real models, pinned to a reasoning variant.">
      {error && !modalError && <div class="banner error">{error}</div>}

      <div class="toolbar">
        <button type="button" id="alias-add" disabled={!canCreate}>
          + Create alias
        </button>
      </div>
      {!canCreate && (
        <p class="muted">
          {modelsUnreachable
            ? "Could not load the model list — can't create an alias right now."
            : "No connected model currently exposes reasoning variants, so there's nothing to alias yet."}
        </p>
      )}

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
                <td>
                  {alias.mode}
                  {alias.clientEffortOverrides && (
                    <div class="muted" title="A client's reasoning effort overrides the pinned levels">
                      client effort overrides
                    </div>
                  )}
                </td>
                <td class="mono">
                  {alias.targets.map((t, i) => (
                    <div>
                      {alias.mode === "priority" ? `${i + 1}. ` : ""}
                      {t.providerID}/{t.modelID}#{t.variant}
                    </div>
                  ))}
                </td>
                <td>{alias.createdAt}</td>
                <td class="actions">
                  <button type="button" class="row-toggle" data-edit-alias={alias.id}>
                    Edit
                  </button>{" "}
                  <form
                    class="inline"
                    method="post"
                    action={`/admin/aliases/${alias.id}/delete`}
                    onsubmit={`return confirm('Delete alias ${alias.alias.replace(/['\\]/g, "")}?')`}
                  >
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

      <dialog id="alias-dialog" class="modal" aria-labelledby="alias-title">
        <form method="post" action="/admin/aliases">
          <header class="modal-head">
            <div>
              <h2 id="alias-title">Create an alias</h2>
              <p class="muted">A custom model name that routes to one or more real models, each pinned to a reasoning variant.</p>
            </div>
            <button type="button" class="icon-btn" data-close aria-label="Close">
              &times;
            </button>
          </header>

          <div class="modal-body">
            <div id="alias-error" class="banner error" data-initial-error={modalError ?? ""} hidden></div>

            <label class="field">
              <span class="field-label">Alias name</span>
              <input type="text" name="name" required placeholder="e.g. gpt-xhigh" autocomplete="off" />
              <span class="field-hint">What clients send as the model name.</span>
            </label>

            <fieldset class="choice-group">
              <legend class="field-label">Mode</legend>
              <div class="choice-grid">
              <label class="choice">
                <input type="radio" name="mode" value="priority" checked />
                <span>
                  <strong>Priority</strong>
                  <small>Try the targets in order and fail over on error or timeout.</small>
                </span>
              </label>
              <label class="choice">
                <input type="radio" name="mode" value="random" />
                <span>
                  <strong>Random</strong>
                  <small>A fresh random order per request, still failing over through the rest.</small>
                </span>
              </label>
              </div>
            </fieldset>

            <section class="models-section">
              <div class="models-head">
                <span class="field-label">Target models</span>
              </div>
              <div id="alias-targets" class="target-rows"></div>
              <button type="button" id="alias-add-target" class="row-toggle">
                + Add another model
              </button>
              <p class="field-hint">Order matters in priority mode; a failed or non-responsive target falls over to the next one either way.</p>
            </section>

            <label class="choice switch">
              <input type="checkbox" name="clientEffortOverrides" value="1" />
              <span>
                <strong>Client effort overrides the pinned level</strong>
                <small>
                  A request's <code>reasoning_effort</code> / <code>reasoning.effort</code> is used instead, mapped to the nearest level each
                  target offers. Otherwise the pinned levels always apply.
                </small>
              </span>
            </label>
          </div>

          <footer class="modal-foot">
            <button type="button" class="row-toggle" data-close>
              Cancel
            </button>
            <button type="submit" id="alias-submit">
              Create alias
            </button>
          </footer>
        </form>
      </dialog>

      <script type="application/json" id="alias-models-by-provider" dangerouslySetInnerHTML={{ __html: json(modelsByProviderObj) }}></script>
      <script type="application/json" id="alias-model-variants" dangerouslySetInnerHTML={{ __html: json(variantsByModelObj) }}></script>
      <script type="application/json" id="alias-existing" dangerouslySetInnerHTML={{ __html: json(existingObj) }}></script>
      <script type="application/json" id="alias-form-state" dangerouslySetInnerHTML={{ __html: json(form ?? null) }}></script>
      <script dangerouslySetInnerHTML={{ __html: ALIASES_SCRIPT }}></script>
    </Layout>
  );
};
