import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { StatusPill } from "./theme";
import { formatCost } from "../pricing";
import type { RequestLogRow } from "../types";

interface RequestRowWithCost extends RequestLogRow {
  estimatedCost: number | null;
  costEstimated: boolean;
}

interface Filters {
  model?: string;
  app?: string;
  status?: string;
  page: number;
}

interface RequestsLogProps {
  rows: RequestRowWithCost[];
  total: number;
  pageSize: number;
  filters: Filters;
  /** Sum of `estimatedCost` across `rows` (this page only), or null if no row has a known rate. */
  totalCost: number | null;
}

const DETAIL_COLSPAN = 11;

function buildQuery(filters: Filters, overrides: Partial<Filters>): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (merged.model) params.set("model", merged.model);
  if (merged.app) params.set("app", merged.app);
  if (merged.status) params.set("status", merged.status);
  if (merged.page && merged.page !== 1) params.set("page", String(merged.page));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function tokensPerSecond(completionTokens: number | null, latencyMs: number): string {
  if (!completionTokens || latencyMs <= 0) return "-";
  return (completionTokens / (latencyMs / 1000)).toFixed(1);
}

const SCRIPT = `
(function () {
  var table = document.getElementById("requests-table");
  if (!table) return;

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Only allow http(s), site-relative, and in-page anchor links - anything
  // else (javascript:, data:, ...) becomes inert. Model output is untrusted.
  function safeHref(url) {
    var u = (url || "").trim();
    if (/^https?:\\/\\//i.test(u) || u.charAt(0) === "/" || u.charAt(0) === "#") return u;
    return "#";
  }

  // Deliberately minimal: headers, bold/italic, inline code, fenced code
  // blocks, links, bullet lists, paragraphs. Escapes the ENTIRE input first
  // so no raw HTML in model output can ever reach innerHTML unescaped - the
  // markdown syntax below only ever wraps already-escaped text in safe tags.
  function renderMarkdown(src) {
    var codeBlocks = [];
    var escaped = escapeHtml(src).replace(/\`\`\`[^\\n]*\\n?([\\s\\S]*?)\`\`\`/g, function (m, code) {
      codeBlocks.push(code.replace(/\\n$/, ""));
      return "\\u0000CODEBLOCK" + (codeBlocks.length - 1) + "\\u0000";
    });

    escaped = escaped.replace(/^### (.*)$/gm, "<h4>$1</h4>");
    escaped = escaped.replace(/^## (.*)$/gm, "<h4>$1</h4>");
    escaped = escaped.replace(/^# (.*)$/gm, "<h3>$1</h3>");
    escaped = escaped.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/\\*([^*]+)\\*/g, "<em>$1</em>");
    escaped = escaped.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
    escaped = escaped.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function (m, text, url) {
      return '<a href="' + safeHref(url) + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
    });

    var lines = escaped.split("\\n");
    var html = [];
    var inList = false;
    var paragraph = [];
    function flushParagraph() {
      if (paragraph.length) {
        html.push("<p>" + paragraph.join("<br>") + "</p>");
        paragraph = [];
      }
    }
    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (/^[-*]\\s+/.test(trimmed)) {
        flushParagraph();
        if (!inList) {
          html.push("<ul>");
          inList = true;
        }
        html.push("<li>" + trimmed.replace(/^[-*]\\s+/, "") + "</li>");
        return;
      }
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      if (trimmed === "") {
        flushParagraph();
        return;
      }
      if (/^<h[34]>/.test(trimmed)) {
        flushParagraph();
        html.push(trimmed);
        return;
      }
      paragraph.push(line);
    });
    if (inList) html.push("</ul>");
    flushParagraph();

    return html
      .join("\\n")
      .replace(/\\u0000CODEBLOCK(\\d+)\\u0000/g, function (m, i) {
        return "<pre><code>" + codeBlocks[parseInt(i, 10)] + "</code></pre>";
      });
  }

  // Collapsible, syntax-highlighted JSON tree. Every value that reaches
  // innerHTML goes through escapeHtml first (same discipline as
  // renderMarkdown above) - object keys and string values are both
  // untrusted, since they can come straight from model output.
  function jsonValueHtml(value) {
    if (value === null) return '<span class="json-null">null</span>';
    if (typeof value === "string") return '<span class="json-string">"' + escapeHtml(value) + '"</span>';
    if (typeof value === "number") return '<span class="json-number">' + value + "</span>";
    if (typeof value === "boolean") return '<span class="json-boolean">' + value + "</span>";
    return "";
  }

  function renderJsonNode(value) {
    if (value !== null && typeof value === "object") {
      var isArray = Array.isArray(value);
      var entries = isArray ? value.map(function (v, i) { return [i, v]; }) : Object.keys(value).map(function (k) { return [k, value[k]]; });
      var openBrace = isArray ? "[" : "{";
      var closeBrace = isArray ? "]" : "}";
      if (entries.length === 0) {
        return '<span class="json-punctuation">' + openBrace + closeBrace + "</span>";
      }
      var countLabel = entries.length + " " + (isArray ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys");
      var html =
        '<details class="json-node" open><summary><span class="json-punctuation">' +
        openBrace +
        '</span> <span class="json-count">' +
        countLabel +
        '</span></summary><div class="json-children">';
      entries.forEach(function (entry, idx) {
        var k = entry[0];
        var v = entry[1];
        html += '<div class="json-row">';
        if (!isArray) {
          html += '<span class="json-key">"' + escapeHtml(String(k)) + '"</span><span class="json-punctuation">: </span>';
        }
        html += renderJsonNode(v);
        if (idx < entries.length - 1) html += '<span class="json-punctuation">,</span>';
        html += "</div>";
      });
      html += '</div><span class="json-punctuation">' + closeBrace + "</span></details>";
      return html;
    }
    return jsonValueHtml(value);
  }

  // Best-effort: pull the human-readable reply text out of whichever
  // response shape this row happens to be (playground, chat/completions,
  // or the Responses API all differ). Falls back to the raw body as-is.
  function extractResponseText(raw) {
    try {
      var parsed = JSON.parse(raw);
      if (typeof parsed.content === "string") return parsed.content;
      if (parsed.choices && parsed.choices[0] && parsed.choices[0].message && typeof parsed.choices[0].message.content === "string") {
        return parsed.choices[0].message.content;
      }
      if (typeof parsed.output_text === "string") return parsed.output_text;
    } catch (e) {}
    return raw;
  }

  // If the reply's extracted text is itself a JSON document (models
  // sometimes return structured output as a JSON string), parse it so it
  // can be shown as a collapsible tree instead of an unformatted blob under
  // Markdown. Returns undefined when there's nothing JSON-shaped to show.
  function parseContentJson(raw) {
    try {
      var parsed = JSON.parse(extractResponseText(raw));
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch (e) {}
    return undefined;
  }

  function formatPanel(panel, format) {
    var raw = panel.getAttribute("data-raw") || "";
    var codeEl = panel.querySelector(".detail-code");
    var jsonEl = panel.querySelector(".detail-json");
    var mdEl = panel.querySelector(".detail-markdown");
    var contentJsonEl = panel.querySelector(".detail-content-json");

    codeEl.hidden = true;
    if (jsonEl) jsonEl.hidden = true;
    if (mdEl) mdEl.hidden = true;
    if (contentJsonEl) contentJsonEl.hidden = true;

    if (format === "markdown" && mdEl) {
      mdEl.hidden = false;
      mdEl.innerHTML = renderMarkdown(extractResponseText(raw));
      return;
    }

    if (format === "json" && jsonEl) {
      try {
        jsonEl.innerHTML = renderJsonNode(JSON.parse(raw));
        jsonEl.hidden = false;
      } catch (e) {
        codeEl.hidden = false;
        codeEl.textContent = raw + "\\n\\n(not valid JSON)";
      }
      return;
    }

    if (format === "content-json" && contentJsonEl) {
      var parsedContent = parseContentJson(raw);
      if (parsedContent !== undefined) {
        contentJsonEl.innerHTML = renderJsonNode(parsedContent);
        contentJsonEl.hidden = false;
      } else {
        codeEl.hidden = false;
        codeEl.textContent = raw + "\\n\\n(response content is not valid JSON)";
      }
      return;
    }

    codeEl.hidden = false;
    codeEl.textContent = raw;
  }

  // Text to put on the clipboard for whichever format is currently active -
  // the pretty-printed JSON for the JSON tabs, the plain extracted reply
  // text for Markdown, the untouched body for Raw.
  function copyTextFor(panel, format, raw) {
    if (format === "json") {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch (e) {
        return raw;
      }
    }
    if (format === "markdown") return extractResponseText(raw);
    if (format === "content-json") {
      var parsedContent = parseContentJson(raw);
      if (parsedContent !== undefined) return JSON.stringify(parsedContent, null, 2);
      return raw;
    }
    return raw;
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function copyToClipboard(text, btn) {
    function done(ok) {
      var label = btn.getAttribute("data-label") || btn.textContent;
      btn.setAttribute("data-label", label);
      btn.textContent = ok ? "Copied!" : "Copy failed";
      btn.classList.toggle("copied", ok);
      setTimeout(function () {
        btn.textContent = btn.getAttribute("data-label");
        btn.classList.remove("copied");
      }, 1400);
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(fallbackCopy(text)); }
      );
      return;
    }
    done(fallbackCopy(text));
  }

  table.addEventListener("click", function (e) {
    var toggle = e.target.closest(".row-toggle");
    if (toggle) {
      var detailRow = toggle.closest("tr").nextElementSibling;
      var collapse = detailRow && detailRow.querySelector(".detail-collapse");
      if (collapse) {
        var open = collapse.classList.toggle("open");
        toggle.textContent = open ? "hide" : "view";
      }
      return;
    }

    var copyBtn = e.target.closest(".detail-copy");
    if (copyBtn) {
      var copyPanel = copyBtn.closest(".detail-panel");
      var activeTab = copyPanel.querySelector(".detail-tab.active");
      var format = activeTab ? activeTab.getAttribute("data-format") : "raw";
      var raw = copyPanel.getAttribute("data-raw") || "";
      copyToClipboard(copyTextFor(copyPanel, format, raw), copyBtn);
      return;
    }

    var tab = e.target.closest(".detail-tab");
    if (tab) {
      var panel = tab.closest(".detail-panel");
      Array.prototype.forEach.call(panel.querySelectorAll(".detail-tab"), function (t) {
        t.classList.remove("active");
      });
      tab.classList.add("active");
      formatPanel(panel, tab.getAttribute("data-format"));
    }
  });

  Array.prototype.forEach.call(table.querySelectorAll(".detail-panel"), function (panel) {
    var raw = panel.getAttribute("data-raw") || "";
    panel.querySelector(".detail-code").textContent = raw;
    var contentJsonTab = panel.querySelector('.detail-tab[data-format="content-json"]');
    if (contentJsonTab) {
      contentJsonTab.disabled = parseContentJson(raw) === undefined;
    }
  });
})();
`;

export const RequestsLog: FC<RequestsLogProps> = ({ rows, total, pageSize, filters, totalCost }) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = filters.page > 1;
  const hasNext = filters.page < totalPages;

  return (
    <Layout title="Requests" subtitle="Inspect recent requests proxied through the gateway.">
      <form class="filters" method="get" action="/admin/requests">
        <label>
          Model
          <input type="text" name="model" value={filters.model ?? ""} />
        </label>
        <label>
          App
          <input type="text" name="app" value={filters.app ?? ""} />
        </label>
        <label>
          Status
          <select name="status">
            <option value="" selected={!filters.status}>
              any
            </option>
            <option value="ok" selected={filters.status === "ok"}>
              ok
            </option>
            <option value="error" selected={filters.status === "error"}>
              error
            </option>
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>

      <p class="muted">
        {total} total request{total === 1 ? "" : "s"} · page {filters.page} of {totalPages}
        {totalCost !== null && (
          <>
            {" "}
            · {formatCost(totalCost)} on this page{rows.some((r) => r.costEstimated) ? " (some estimated)" : ""}
          </>
        )}
      </p>

      <div class="table-card">
        <table id="requests-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>App</th>
              <th>Model</th>
              <th>Variant</th>
              <th>Stream</th>
              <th>Status</th>
              <th>HTTP</th>
              <th>Tokens (p/c/t)</th>
              <th>Latency (ms)</th>
              <th>Cost</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colspan={DETAIL_COLSPAN} class="muted">
                  No requests found
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <>
                <tr>
                  <td class="mono">{row.createdAt}</td>
                  <td>{row.appName}</td>
                  <td class="mono">{row.model}</td>
                  <td class="mono">{row.variant ?? "-"}</td>
                  <td>{row.stream ? "yes" : "no"}</td>
                  <td>{row.status === "ok" ? <StatusPill tone="ok">ok</StatusPill> : <StatusPill tone="error">error</StatusPill>}</td>
                  <td class="mono">{row.httpStatus}</td>
                  <td class="mono">
                    {row.promptTokens ?? "-"}/{row.completionTokens ?? "-"}/{row.totalTokens ?? "-"}
                  </td>
                  <td class="mono">{row.latencyMs}</td>
                  <td class="mono">
                    {row.costEstimated && row.estimatedCost !== null ? "~" : ""}
                    {formatCost(row.estimatedCost)}
                  </td>
                  <td>
                    <button type="button" class="row-toggle">
                      view
                    </button>
                  </td>
                </tr>
                <tr class="detail-row">
                  <td colspan={DETAIL_COLSPAN}>
                    <div class="detail-collapse">
                      <div class="detail-collapse-inner">
                        <div>
                          <div class="detail-stats">
                            <div class="detail-stat">
                              <span class="detail-stat-label">Latency</span>
                              <span class="detail-stat-value mono">{row.latencyMs} ms</span>
                            </div>
                            <div class="detail-stat">
                              <span class="detail-stat-label">Prompt tokens</span>
                              <span class="detail-stat-value mono">{row.promptTokens ?? "-"}</span>
                            </div>
                            <div class="detail-stat">
                              <span class="detail-stat-label">Completion tokens</span>
                              <span class="detail-stat-value mono">{row.completionTokens ?? "-"}</span>
                            </div>
                            <div class="detail-stat">
                              <span class="detail-stat-label">Total tokens</span>
                              <span class="detail-stat-value mono">{row.totalTokens ?? "-"}</span>
                            </div>
                            <div class="detail-stat">
                              <span class="detail-stat-label">Tokens/sec</span>
                              <span class="detail-stat-value mono">{tokensPerSecond(row.completionTokens, row.latencyMs)}</span>
                            </div>
                            <div class="detail-stat">
                              <span class="detail-stat-label">Cost</span>
                              <span class="detail-stat-value mono">
                                {row.costEstimated && row.estimatedCost !== null ? "~" : ""}
                                {formatCost(row.estimatedCost)}
                              </span>
                            </div>
                            <div class="detail-stat">
                              <span class="detail-stat-label">Variant</span>
                              <span class="detail-stat-value mono">{row.variant ?? "-"}</span>
                            </div>
                          </div>

                          {row.errorMessage && <div class="banner error">{row.errorMessage}</div>}

                          <div class="detail-panel" data-raw={row.requestBody ?? ""}>
                            <div class="detail-panel-label">Request body</div>
                            <div class="detail-tabbar">
                              <div class="detail-tabs">
                                <button type="button" class="detail-tab active" data-format="raw">
                                  Raw
                                </button>
                                <button type="button" class="detail-tab" data-format="json">
                                  Formatted JSON
                                </button>
                              </div>
                              <button type="button" class="detail-copy">
                                Copy
                              </button>
                            </div>
                            <pre class="detail-code"></pre>
                            <div class="detail-json" hidden></div>
                          </div>

                          <div class="detail-panel" data-raw={row.responseBody ?? ""}>
                            <div class="detail-panel-label">Response body</div>
                            <div class="detail-tabbar">
                              <div class="detail-tabs">
                                <button type="button" class="detail-tab active" data-format="raw">
                                  Raw
                                </button>
                                <button type="button" class="detail-tab" data-format="json">
                                  Formatted JSON
                                </button>
                                <button type="button" class="detail-tab" data-format="markdown">
                                  Markdown
                                </button>
                                <button
                                  type="button"
                                  class="detail-tab"
                                  data-format="content-json"
                                  disabled
                                  title="Enabled when the reply's content is itself JSON"
                                >
                                  Content JSON
                                </button>
                              </div>
                              <button type="button" class="detail-copy">
                                Copy
                              </button>
                            </div>
                            <pre class="detail-code"></pre>
                            <div class="detail-json" hidden></div>
                            <div class="detail-markdown" hidden></div>
                            <div class="detail-content-json" hidden></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              </>
            ))}
          </tbody>
        </table>
      </div>

      <div class="pagination">
        {hasPrev ? (
          <a href={`/admin/requests${buildQuery(filters, { page: filters.page - 1 })}`}>&laquo; Prev</a>
        ) : (
          <span class="muted">&laquo; Prev</span>
        )}
        {hasNext ? (
          <a href={`/admin/requests${buildQuery(filters, { page: filters.page + 1 })}`}>Next &raquo;</a>
        ) : (
          <span class="muted">Next &raquo;</span>
        )}
      </div>

      <script dangerouslySetInnerHTML={{ __html: SCRIPT }}></script>
    </Layout>
  );
};
