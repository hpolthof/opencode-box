import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { ModelSummary } from "../opencode/client";
import { resolveModelRate } from "../pricing";

interface ModelsProps {
  models?: ModelSummary[];
  unreachable?: boolean;
}

const SCRIPT = `
(function () {
  var search = document.getElementById("model-search");
  var providerFilter = document.getElementById("model-provider-filter");
  var rows = Array.prototype.slice.call(document.querySelectorAll("#models-table tbody tr[data-name]"));
  var empty = document.getElementById("models-empty");
  var count = document.getElementById("model-count");
  if (!search || !providerFilter) return;

  function apply() {
    var q = search.value.trim().toLowerCase();
    var provider = providerFilter.value;
    var visible = 0;

    rows.forEach(function (row) {
      var matchesQuery = !q || row.getAttribute("data-name").indexOf(q) !== -1;
      var matchesProvider = !provider || row.getAttribute("data-provider") === provider;
      var show = matchesQuery && matchesProvider;
      row.hidden = !show;
      if (show) visible++;
    });

    count.textContent = String(visible);
    empty.hidden = visible !== 0;
  }

  search.addEventListener("input", apply);
  providerFilter.addEventListener("change", apply);
  apply();
})();
`;

export const Models: FC<ModelsProps> = ({ models, unreachable }) => {
  const rows = models ?? [];
  const providerIDs = Array.from(new Set(rows.map((m) => m.providerID))).sort();

  return (
    <Layout title="Models" subtitle="Every model currently available from a connected provider.">
      {unreachable && <div class="banner error">OpenCode is not reachable. Check that the opencode server is running.</div>}

      {!unreachable && (
        <>
          <form class="filters" onsubmit="return false;">
            <label>
              Search
              <input type="text" id="model-search" placeholder="Search by model name or ID…" />
            </label>
            <label>
              Provider
              <select id="model-provider-filter">
                <option value="">All providers</option>
                {providerIDs.map((id) => (
                  <option value={id}>{id}</option>
                ))}
              </select>
            </label>
          </form>

          <p class="muted">
            <span id="model-count">{rows.length}</span> of {rows.length} models
          </p>
          <p class="muted">
            Prices are $/1M tokens, input / output. <span class="pill pill-muted">~</span> marks an estimate, used
            where OpenCode doesn't report the model's real price.
          </p>

          <div class="table-card">
            <table id="models-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model ID</th>
                  <th>Provider</th>
                  <th>$/1M input / output</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colspan={4} class="muted">
                      No models found
                    </td>
                  </tr>
                )}
                {rows.map((model) => {
                  const rate = resolveModelRate(model.cost, model.id);
                  return (
                    <tr data-name={`${model.name ?? ""} ${model.id}`.toLowerCase()} data-provider={model.providerID}>
                      <td>{model.name ?? model.modelID}</td>
                      <td class="mono">{model.id}</td>
                      <td class="mono">{model.providerID}</td>
                      <td class="mono">
                        {rate ? `${rate.estimated ? "~" : ""}$${rate.input.toFixed(2)} / $${rate.output.toFixed(2)}` : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p class="muted" id="models-empty" hidden style="padding: 0.75rem 0.9rem; margin: 0;">
              No models match your search.
            </p>
          </div>

          <script dangerouslySetInnerHTML={{ __html: SCRIPT }}></script>
        </>
      )}
    </Layout>
  );
};
