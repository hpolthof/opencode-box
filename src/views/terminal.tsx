import type { FC } from "hono/jsx";
import { Layout } from "./layout";

const STYLE = `
  .term-shell {
    background: #0a0c10;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.75rem;
    height: calc(100vh - 220px);
    min-height: 360px;
    position: relative;
  }
  #term-container { width: 100%; height: 100%; }
  .term-banner {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 0.85rem;
    background: rgba(10, 12, 16, 0.92);
    border-radius: var(--radius-md);
    text-align: center;
    padding: 1.5rem;
  }
  .term-banner p { margin: 0; color: var(--fg-muted); font-size: 0.88rem; }
  .term-banner button { width: auto; }
`;

const SCRIPT = `
(function () {
  var container = document.getElementById("term-container");
  var banner = document.getElementById("term-banner");
  var bannerText = document.getElementById("term-banner-text");
  var reconnectBtn = document.getElementById("term-reconnect");
  if (!container) return;

  var term = new Terminal({
    cursorBlink: true,
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    theme: {
      background: "#0a0c10",
      foreground: "#edeef1",
      cursor: "#f0a93c",
      selectionBackground: "rgba(240, 169, 60, 0.28)"
    }
  });
  var fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  var ws = null;
  var encoder = new TextEncoder();

  function showBanner(text, showReconnect) {
    bannerText.textContent = text;
    reconnectBtn.hidden = !showReconnect;
    banner.hidden = false;
  }

  function hideBanner() {
    banner.hidden = true;
  }

  function sendResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }

  function connect() {
    hideBanner();
    term.reset();

    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(protocol + "//" + location.host + "/admin/terminal/ws");
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", function () {
      fitAddon.fit();
      sendResize();
      term.focus();
    });

    ws.addEventListener("message", function (event) {
      term.write(new Uint8Array(event.data));
    });

    ws.addEventListener("close", function () {
      showBanner("Session ended.", true);
    });

    ws.addEventListener("error", function () {
      showBanner("Connection error.", true);
    });
  }

  term.onData(function (data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encoder.encode(data));
  });

  term.onResize(function () {
    sendResize();
  });

  reconnectBtn.addEventListener("click", connect);

  var resizeObserver = new ResizeObserver(function () {
    fitAddon.fit();
  });
  resizeObserver.observe(container);

  connect();
})();
`;

export const Terminal: FC = () => {
  return (
    <Layout title="Terminal" subtitle="An interactive shell inside this container. Full access — treat it like SSH.">
      <link rel="stylesheet" href="/vendor/xterm/css/xterm.css" />
      <style dangerouslySetInnerHTML={{ __html: STYLE }}></style>

      <div class="term-shell">
        <div id="term-container"></div>
        <div id="term-banner" class="term-banner" hidden>
          <p id="term-banner-text"></p>
          <button id="term-reconnect" type="button">
            Reconnect
          </button>
        </div>
      </div>

      <script src="/vendor/xterm/lib/xterm.js"></script>
      <script src="/vendor/xterm-addon-fit/lib/addon-fit.js"></script>
      <script dangerouslySetInnerHTML={{ __html: SCRIPT }}></script>
    </Layout>
  );
};
