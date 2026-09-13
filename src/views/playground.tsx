import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { ModelSummary } from "../opencode/client";

interface PlaygroundProps {
  models?: ModelSummary[];
  unreachable?: boolean;
}

const STYLE = `
  .pg-layout { display: grid; grid-template-columns: minmax(320px, 440px) 1fr; gap: 1.75rem; align-items: start; }
  .pg-config { display: flex; flex-direction: column; gap: 1.1rem; }
  .pg-field { display: flex; flex-direction: column; gap: 0.35rem; }
  .pg-field label, .pg-legend { font-size: 0.78rem; color: var(--fg-muted); font-weight: 600; }
  .pg-field select, .pg-field textarea { width: 100%; }
  .pg-hint { font-size: 0.78rem; margin: 0.3rem 0 0; color: var(--error); }

  .pg-radio-row { display: flex; gap: 1.1rem; flex-wrap: wrap; }
  .pg-radio, .pg-checkbox { display: flex; align-items: center; gap: 0.45rem; font-size: 0.85rem; color: var(--fg); cursor: pointer; }
  .pg-radio input, .pg-checkbox input { accent-color: var(--accent); margin: 0; }

  #pg-schema { font-family: var(--font-mono); font-size: 0.8rem; }
  #pg-send { align-self: flex-start; }

  .pg-response-panel {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.25rem 1.4rem;
    min-height: 340px;
  }
  .pg-response-panel h2 { margin-top: 0; }
  #pg-structured { margin: 0; }
  #pg-usage { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.85rem; }

  @media (max-width: 900px) {
    .pg-layout { grid-template-columns: 1fr; }
  }
`;

const SCRIPT = `
(function () {
  var form = document.getElementById("pg-form");
  if (!form) return;

  var modelSelect = document.getElementById("pg-model");
  var variantField = document.getElementById("pg-variant-field");
  var variantSelect = document.getElementById("pg-variant");
  var systemInput = document.getElementById("pg-system");
  var promptInput = document.getElementById("pg-message");
  var formatRadios = document.querySelectorAll('input[name="pg-format"]');
  var schemaField = document.getElementById("pg-schema-field");
  var schemaInput = document.getElementById("pg-schema");
  var schemaError = document.getElementById("pg-schema-error");
  var streamCheckbox = document.getElementById("pg-stream");
  var sendBtn = document.getElementById("pg-send");
  var empty = document.getElementById("pg-empty");
  var error = document.getElementById("pg-error");
  var content = document.getElementById("pg-content");
  var structuredEl = document.getElementById("pg-structured");
  var usage = document.getElementById("pg-usage");

  function hide(el) { el.hidden = true; }
  function show(el) { el.hidden = false; }

  function pill(text) {
    var span = document.createElement("span");
    span.className = "pill pill-accent";
    span.textContent = text;
    return span;
  }

  function updateVariantOptions() {
    var opt = modelSelect.options[modelSelect.selectedIndex];
    var variants = [];
    try {
      variants = JSON.parse((opt && opt.getAttribute("data-variants")) || "[]");
    } catch (e) {
      variants = [];
    }

    variantSelect.innerHTML = "";
    var def = document.createElement("option");
    def.value = "";
    def.textContent = "Default";
    variantSelect.appendChild(def);

    if (!variants.length) {
      hide(variantField);
      return;
    }
    variants.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      variantSelect.appendChild(o);
    });
    show(variantField);
  }

  modelSelect.addEventListener("change", updateVariantOptions);
  updateVariantOptions();

  function updateFormatUI() {
    var selected = document.querySelector('input[name="pg-format"]:checked');
    if (selected && selected.value === "json_schema") {
      show(schemaField);
    } else {
      hide(schemaField);
      hide(schemaError);
    }
  }
  Array.prototype.forEach.call(formatRadios, function (r) {
    r.addEventListener("change", updateFormatUI);
  });
  updateFormatUI();

  function resetResponsePanel() {
    hide(empty);
    hide(error);
    hide(content);
    hide(structuredEl);
    content.textContent = "";
    structuredEl.textContent = "";
    usage.innerHTML = "";
    hide(usage);
  }

  function renderUsage(u, latencyMs) {
    usage.innerHTML = "";
    if (u) {
      usage.appendChild(pill("prompt: " + u.promptTokens));
      usage.appendChild(pill("completion: " + u.completionTokens));
      usage.appendChild(pill("total: " + u.totalTokens));
    }
    if (typeof latencyMs === "number") {
      usage.appendChild(pill(latencyMs + "ms"));
    }
    show(usage);
  }

  function renderResult(body) {
    if (body.structured !== null && body.structured !== undefined) {
      structuredEl.textContent = JSON.stringify(body.structured, null, 2);
      show(structuredEl);
      hide(content);
    } else {
      content.textContent = body.content || "(empty response)";
      show(content);
      hide(structuredEl);
    }
  }

  function runNonStreaming(payload) {
    return fetch("/admin/playground/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body && result.body.error ? result.body.error : "The gateway returned an error.");
        }
        renderResult(result.body);
        renderUsage(result.body.usage, result.body.latencyMs);
      })
      .catch(function (err) {
        error.textContent = "Something went wrong: " + err.message;
        show(error);
      });
  }

  function runStreaming(payload) {
    return fetch("/admin/playground/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            throw new Error(body && body.error ? body.error : "The gateway returned an error.");
          });
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var liveText = "";
      var sawContent = false;

      function handleFrame(raw) {
        var lines = raw.split("\\n").filter(function (l) {
          return l.indexOf("data:") === 0;
        });
        if (!lines.length) return;
        var jsonStr = lines
          .map(function (l) {
            return l.slice(5).replace(/^ /, "");
          })
          .join("\\n");
        if (!jsonStr) return;

        var evt;
        try {
          evt = JSON.parse(jsonStr);
        } catch (e) {
          return;
        }

        if (evt.type === "delta") {
          liveText += evt.text;
          if (!sawContent) {
            hide(empty);
            show(content);
            sawContent = true;
          }
          content.textContent = liveText;
        } else if (evt.type === "done") {
          renderResult(evt);
          renderUsage(evt.usage, evt.latencyMs);
        } else if (evt.type === "error") {
          error.textContent = "Something went wrong: " + evt.message;
          show(error);
        }
      }

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
            var frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            handleFrame(frame);
          }
          return pump();
        });
      }

      return pump();
    });
  }

  sendBtn.addEventListener("click", function () {
    var prompt = promptInput.value.trim();
    if (!prompt) {
      promptInput.focus();
      return;
    }

    var selectedFormat = document.querySelector('input[name="pg-format"]:checked');
    var responseFormat;
    if (selectedFormat && selectedFormat.value === "json_schema") {
      var schemaText = schemaInput.value.trim();
      if (!schemaText) {
        schemaError.textContent = "Enter a JSON schema, or switch back to Text.";
        show(schemaError);
        schemaInput.focus();
        return;
      }
      var parsedSchema;
      try {
        parsedSchema = JSON.parse(schemaText);
      } catch (e) {
        schemaError.textContent = "That's not valid JSON: " + e.message;
        show(schemaError);
        schemaInput.focus();
        return;
      }
      hide(schemaError);
      responseFormat = { type: "json_schema", schema: parsedSchema };
    }

    var stream = streamCheckbox.checked;
    var payload = {
      model: modelSelect.value,
      system: systemInput.value.trim() || undefined,
      prompt: prompt,
      variant: variantSelect.value || undefined,
      stream: stream,
      responseFormat: responseFormat,
    };

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    resetResponsePanel();

    var run = stream ? runStreaming(payload) : runNonStreaming(payload);
    run.finally(function () {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
    });
  });
})();
`;

export const Playground: FC<PlaygroundProps> = ({ models, unreachable }) => {
  const modelsByProvider = new Map<string, ModelSummary[]>();
  for (const model of models ?? []) {
    const list = modelsByProvider.get(model.providerID) ?? [];
    list.push(model);
    modelsByProvider.set(model.providerID, list);
  }

  const canRun = !unreachable && modelsByProvider.size > 0;

  return (
    <Layout
      title="Playground"
      subtitle="Send a prompt to a connected model, with reasoning effort, streaming, and structured output. Each run starts a fresh session — nothing is kept between sends."
    >
      <style dangerouslySetInnerHTML={{ __html: STYLE }}></style>

      {unreachable && <div class="banner error">OpenCode is not reachable. Check that the opencode server is running.</div>}

      {!unreachable && modelsByProvider.size === 0 && (
        <div class="banner error">No models are available yet — connect a provider first.</div>
      )}

      {canRun && (
        <div class="pg-layout" id="pg-form">
          <div class="pg-config">
            <div class="pg-field">
              <label for="pg-model">Model</label>
              <select id="pg-model">
                {Array.from(modelsByProvider.entries()).map(([providerID, providerModels]) => (
                  <optgroup label={providerID}>
                    {providerModels.map((model) => (
                      <option
                        value={model.id}
                        data-variants={JSON.stringify(model.variants ?? [])}
                        data-reasoning={model.reasoning ? "true" : "false"}
                      >
                        {model.name ? `${model.name} (${model.id})` : model.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div class="pg-field" id="pg-variant-field" hidden>
              <label for="pg-variant">Reasoning effort</label>
              <select id="pg-variant">
                <option value="">Default</option>
              </select>
            </div>

            <div class="pg-field">
              <label for="pg-system">System prompt (optional)</label>
              <textarea id="pg-system" rows={2} placeholder="e.g. Answer in one short paragraph."></textarea>
            </div>

            <div class="pg-field">
              <label for="pg-message">Message</label>
              <textarea id="pg-message" rows={6} placeholder="Ask the model something…"></textarea>
            </div>

            <div class="pg-field">
              <span class="pg-legend">Response format</span>
              <div class="pg-radio-row">
                <label class="pg-radio">
                  <input type="radio" name="pg-format" value="text" checked />
                  Text
                </label>
                <label class="pg-radio">
                  <input type="radio" name="pg-format" value="json_schema" />
                  Structured output (JSON schema)
                </label>
              </div>
            </div>

            <div class="pg-field" id="pg-schema-field" hidden>
              <label for="pg-schema">JSON schema</label>
              <textarea
                id="pg-schema"
                rows={6}
                placeholder={'{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}'}
              ></textarea>
              <p class="pg-hint" id="pg-schema-error" hidden></p>
            </div>

            <label class="pg-checkbox">
              <input type="checkbox" id="pg-stream" />
              Stream response
            </label>

            <button type="button" id="pg-send">
              Send
            </button>
          </div>

          <div class="pg-response-panel">
            <h2>Response</h2>
            <p class="muted" id="pg-empty">
              Responses will appear here.
            </p>
            <div class="banner error" id="pg-error" hidden></div>
            <div class="instructions" id="pg-content" hidden></div>
            <pre id="pg-structured" hidden></pre>
            <div id="pg-usage" hidden></div>
          </div>

          <script dangerouslySetInnerHTML={{ __html: SCRIPT }}></script>
        </div>
      )}
    </Layout>
  );
};
