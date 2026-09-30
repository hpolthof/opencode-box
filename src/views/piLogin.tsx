import type { FC } from "hono/jsx";
import { Layout } from "./layout";

const STYLE = `
  .pi-login { max-width: 720px; }
  .pi-login .step { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 1rem 1.1rem; margin-bottom: 1rem; }
  .pi-login .step h3 { margin: 0 0 0.5rem; font-size: 0.95rem; }
  .pi-login .device-code { font-family: var(--font-mono); font-size: 1.6rem; letter-spacing: 0.15em; margin: 0.4rem 0; }
  .pi-login form.answer { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .pi-login form.answer input, .pi-login form.answer select { flex: 1; min-width: 240px; }
  .pi-login .progress { margin: 0; padding-left: 1.2rem; }
  .pi-login .actions { display: flex; gap: 0.5rem; align-items: center; }
`;

// Polls the session's state and re-renders it. Everything from the provider
// goes in through textContent, and links only when they are http(s).
const SCRIPT = `
(function () {
  var root = document.getElementById("pi-login");
  var base = root.dataset.base;
  var body = document.getElementById("pi-login-body");
  var shownPromptId = null;
  var timer = null;

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function safeUrl(url) {
    try { var u = new URL(url); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch (e) { return null; }
  }
  function link(url, label) {
    var href = safeUrl(url);
    if (!href) return el("span", { class: "mono" }, url);
    return el("a", { href: href, target: "_blank", rel: "noopener noreferrer" }, label || href);
  }
  function step(title) {
    var box = el("div", { class: "step" });
    box.appendChild(el("h3", {}, title));
    return box;
  }

  function renderPrompt(prompt) {
    var box = step(prompt.type === "manual_code" ? "Paste the code" : "Input needed");
    box.appendChild(el("p", {}, prompt.message));
    var form = el("form", { class: "answer" });
    var input;
    if (prompt.type === "select") {
      input = el("select", { name: "value" });
      (prompt.options || []).forEach(function (o) { input.appendChild(el("option", { value: o.id }, o.label + (o.description ? " - " + o.description : ""))); });
    } else {
      input = el("input", { name: "value", type: prompt.type === "secret" ? "password" : "text", autocomplete: "off", placeholder: prompt.placeholder || "" });
    }
    form.appendChild(input);
    form.appendChild(el("button", { type: "submit" }, "Continue"));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      form.querySelector("button").disabled = true;
      fetch(base + "/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptId: prompt.id, value: input.value }),
      }).then(poll);
    });
    box.appendChild(form);
    return box;
  }

  function render(state) {
    // Keep an open prompt (and whatever is typed in it) while polling.
    var promptId = state.prompt ? state.prompt.id : null;
    if (promptId && promptId === shownPromptId && state.status === "running") return;
    shownPromptId = promptId;
    body.textContent = "";

    var progress = [];
    state.events.forEach(function (ev) {
      if (ev.type === "auth_url") {
        var box = step("1. Sign in");
        var p = el("p");
        p.appendChild(link(ev.url, "Open the sign-in page"));
        box.appendChild(p);
        if (ev.instructions) box.appendChild(el("p", { class: "muted" }, ev.instructions));
        body.appendChild(box);
      } else if (ev.type === "device_code") {
        var dbox = step("1. Enter this code");
        dbox.appendChild(el("div", { class: "device-code" }, ev.userCode));
        var dp = el("p", {}, "at ");
        dp.appendChild(link(ev.verificationUri));
        dbox.appendChild(dp);
        body.appendChild(dbox);
      } else if (ev.type === "info") {
        var ip = el("p", {}, ev.message);
        (ev.links || []).forEach(function (l) { ip.appendChild(document.createTextNode(" ")); ip.appendChild(link(l.url, l.label)); });
        body.appendChild(ip);
      } else if (ev.type === "progress") {
        progress.push(ev.message);
      }
    });

    if (state.prompt) body.appendChild(renderPrompt(state.prompt));

    if (progress.length) {
      var list = el("ul", { class: "progress muted" });
      progress.forEach(function (m) { list.appendChild(el("li", {}, m)); });
      body.appendChild(list);
    }

    if (state.status === "succeeded") body.appendChild(el("div", { class: "banner success" }, "Signed in. The provider's models are now available as pi/" + state.providerId + "/..."));
    if (state.status === "failed") body.appendChild(el("div", { class: "banner error" }, "Sign-in failed: " + (state.error || "unknown error")));
    if (state.status === "cancelled") body.appendChild(el("div", { class: "banner" }, "Sign-in cancelled."));
    document.getElementById("pi-login-cancel").style.display = state.status === "running" ? "" : "none";
  }

  function poll() {
    clearTimeout(timer);
    fetch(base + "/state").then(function (res) {
      if (res.status === 404) { render({ status: "failed", error: "This sign-in session has expired", events: [], prompt: null }); return null; }
      return res.json();
    }).then(function (state) {
      if (!state) return;
      render(state);
      if (state.status === "running") timer = setTimeout(poll, 1500);
    }).catch(function () { timer = setTimeout(poll, 3000); });
  }
  poll();
})();
`;

export const PiLogin: FC<{ sessionId: string; providerId: string }> = ({ sessionId, providerId }) => {
  const base = `/admin/providers/pi/login/${sessionId}`;
  return (
    <Layout title="Providers" subtitle={`Sign in to ${providerId} for the pi-ai backend.`}>
      <style dangerouslySetInnerHTML={{ __html: STYLE }}></style>
      <div class="pi-login" id="pi-login" data-base={base}>
        <div id="pi-login-body">
          <p class="muted">Starting sign-in...</p>
        </div>
        <div class="actions">
          <form class="inline" method="post" action={`${base}/cancel`} id="pi-login-cancel">
            <button type="submit" class="danger">
              Cancel
            </button>
          </form>
          <a href="/admin/providers">Back to providers</a>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: SCRIPT }}></script>
    </Layout>
  );
};
