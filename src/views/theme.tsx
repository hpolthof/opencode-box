import type { FC, PropsWithChildren } from "hono/jsx";

// Same badge as <Logo>'s brand-badge (gradient square, "OB" mark), rendered
// once at module load and reused as the browser tab favicon.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f0a93c"/>
      <stop offset="1" stop-color="#c97f1f"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="8" fill="url(#g)"/>
  <text x="16" y="21.5" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="13" font-weight="700" letter-spacing="-0.5" fill="#17120a" text-anchor="middle">OB</text>
</svg>`;
export const FAVICON_HREF = `data:image/svg+xml;base64,${Buffer.from(FAVICON_SVG).toString("base64")}`;

export const Logo: FC<{ href?: string }> = ({ href = "/admin" }) => (
  <a href={href} class="brand">
    <span class="brand-badge">OB</span>
    <span class="brand-name">opencode-box</span>
  </a>
);

export const StatusPill: FC<PropsWithChildren<{ tone: "ok" | "error" | "muted" | "accent" }>> = ({ tone, children }) => (
  <span class={`pill pill-${tone}`}>{children}</span>
);

export const BASE_STYLES = `
  @font-face {
    font-family: 'Manrope';
    font-style: normal;
    font-weight: 200 800;
    font-display: swap;
    src: url('/fonts/manrope-variable.woff2') format('woff2');
  }
  @font-face {
    font-family: 'JetBrains Mono';
    font-style: normal;
    font-weight: 100 800;
    font-display: swap;
    src: url('/fonts/jetbrains-mono-variable.woff2') format('woff2');
  }

  :root {
    color-scheme: dark;
    --bg: #0c0e12;
    --bg-elevated: #14171d;
    --bg-subtle: #1a1e25;
    --border: #262b34;
    --border-strong: #383f4b;
    --fg: #edeef1;
    --fg-muted: #8b92a3;
    --fg-faint: #5b6272;
    --accent: #f0a93c;
    --accent-hover: #f7b955;
    --accent-fg: #17120a;
    --accent-soft: rgba(240, 169, 60, 0.12);
    --accent-border: rgba(240, 169, 60, 0.35);
    --ok: #3ddc84;
    --ok-bg: rgba(61, 220, 132, 0.1);
    --ok-border: rgba(61, 220, 132, 0.28);
    --error: #f2545b;
    --error-bg: rgba(242, 84, 91, 0.1);
    --error-border: rgba(242, 84, 91, 0.3);
    --json-key: #7dd3fc;
    --json-string: #86efac;
    --json-number: #fbbf6f;
    --json-boolean: #c4b5fd;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
    --font-sans: 'Manrope', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  /*
   * Without this, any element that is both [hidden] and matches a class
   * selector setting its own "display" (e.g. ".pg-field { display: flex }")
   * stays visible: both selectors have equal specificity, and the author
   * rule - loading after the browser's UA stylesheet - wins the cascade.
   */
  [hidden] { display: none !important; }
  body {
    margin: 0;
    background:
      radial-gradient(1100px 520px at 12% -10%, rgba(240, 169, 60, 0.07), transparent 60%),
      var(--bg);
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }

  nav {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.75rem;
    border-bottom: 1px solid var(--border);
    background: rgba(12, 14, 18, 0.82);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .brand { display: flex; align-items: center; gap: 0.6rem; margin-right: 1.5rem; text-decoration: none; color: var(--fg); }
  .brand-badge {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: linear-gradient(155deg, var(--accent), #c97f1f);
    color: var(--accent-fg);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 11px;
    letter-spacing: -0.02em;
    flex-shrink: 0;
  }
  .brand-name { font-weight: 700; font-size: 0.92rem; letter-spacing: -0.01em; }
  .nav-links { display: flex; gap: 0.25rem; }
  .nav-link {
    color: var(--fg-muted);
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 0.4rem 0.7rem;
    border-radius: var(--radius-sm);
    transition: color 0.15s ease, background-color 0.15s ease;
  }
  .nav-link:hover { color: var(--fg); background: var(--bg-subtle); }
  .nav-link.active { color: var(--accent); background: var(--accent-soft); font-weight: 600; }
  .logout-link {
    margin-left: auto;
    color: var(--fg-muted);
    text-decoration: none;
    font-size: 0.82rem;
    padding: 0.4rem 0.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .logout-link:hover { color: var(--fg); border-color: var(--border-strong); }

  main { padding: 2rem 1.75rem 3.5rem; max-width: none; margin: 0 auto; }
  .page-header { margin-bottom: 1.75rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.3rem; font-weight: 700; letter-spacing: -0.01em; }
  .page-subtitle { color: var(--fg-muted); font-size: 0.88rem; margin: 0; }
  h2 { font-size: 1rem; font-weight: 600; margin: 2rem 0 0.75rem; letter-spacing: -0.005em; }
  h2:first-of-type { margin-top: 0; }
  h3 { font-size: 0.85rem; font-weight: 600; color: var(--fg-muted); margin: 1.5rem 0 0.6rem; }

  .stat-row { display: flex; gap: 0.85rem; flex-wrap: wrap; margin-bottom: 2rem; }
  .stat-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.15rem;
    min-width: 160px;
    flex: 1 1 160px;
    position: relative;
    overflow: hidden;
  }
  .stat-card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: linear-gradient(90deg, var(--accent), transparent);
  }
  .stat-card .label { color: var(--fg-muted); font-size: 0.78rem; }
  .stat-card .value {
    font-family: var(--font-mono);
    font-size: 1.6rem;
    font-weight: 600;
    margin-top: 0.3rem;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }

  .model-picker { position: relative; width: 280px; }
  .model-picker summary {
    list-style: none;
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--fg);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .model-picker summary::-webkit-details-marker { display: none; }
  .model-picker summary::after { content: "\\25BE"; color: var(--fg-muted); font-size: 0.7rem; }
  .model-picker[open] summary { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  /*
   * position: fixed (not absolute) so the panel escapes any clipping
   * ancestor - notably .table-card's overflow-x: auto, which would
   * otherwise trap a picker opened inside a table row. Exact top/left/width
   * are set inline by JS from the summary's bounding rect, since fixed
   * positioning is viewport-relative rather than parent-relative.
   */
  .model-picker-panel {
    position: fixed;
    z-index: 30;
    max-height: 280px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: 0.5rem;
    box-shadow: 0 20px 45px -15px rgba(0, 0, 0, 0.6);
  }
  .model-picker-group + .model-picker-group { margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px solid var(--border); }
  .model-picker-group-label { font-size: 0.72rem; color: var(--fg-muted); font-weight: 600; padding: 0.15rem 0.4rem; }
  .model-picker-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.4rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.82rem;
  }
  .model-picker-option:hover { background: var(--bg-subtle); }
  .model-picker-option input { margin: 0; accent-color: var(--accent); }
  .model-picker-empty { color: var(--fg-faint); font-size: 0.82rem; padding: 0.4rem; }

  .table-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: 1.5rem;
    overflow-x: auto;
  }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  thead th {
    text-align: left;
    font-weight: 600;
    color: var(--fg-muted);
    font-size: 0.78rem;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--border-strong);
    white-space: nowrap;
  }
  tbody td { padding: 0.6rem 0.9rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:nth-last-child(2):not(.detail-row) td { border-bottom: none; }
  tbody tr:hover td { background: var(--bg-subtle); }
  .mono { font-family: var(--font-mono); font-size: 0.82em; }

  tr.detail-row td { background: var(--bg-subtle); padding: 0; }
  .key-edit-panel { padding: 1.1rem 1.25rem; }
  /* Match the regular button size here so Edit/Cancel doesn't look
     undersized next to Revoke - .row-toggle is deliberately small where it
     first appeared, as a compact row-detail toggle. */
  #keys-table button.row-toggle { padding: 0.5rem 0.9rem; font-size: 0.85rem; }
  /*
   * A <tr> can't have its height transitioned directly (table rows don't
   * animate cleanly across browsers). Instead the collapse/expand animation
   * lives on this inner grid wrapper: a 0fr -> 1fr grid-template-rows
   * transition smoothly grows/shrinks to fit content, with the overflow
   * hidden on the child absorbing the rest.
   */
  .detail-collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.18s ease; }
  .detail-collapse.open { grid-template-rows: 1fr; }
  .detail-collapse-inner { overflow: hidden; min-height: 0; }
  .detail-collapse-inner > * { padding: 1.1rem 1.25rem; }
  button.row-toggle {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-muted);
    font-weight: 600;
    padding: 0.3rem 0.65rem;
    font-size: 0.78rem;
  }
  button.row-toggle:hover { color: var(--fg); border-color: var(--border-strong); background: transparent; }

  .detail-stats { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-bottom: 1rem; }
  .detail-stat { display: flex; flex-direction: column; gap: 0.15rem; }
  .detail-stat-label { font-size: 0.72rem; color: var(--fg-muted); }
  .detail-stat-value { font-size: 0.85rem; }

  .detail-panel { margin-bottom: 1.1rem; }
  .detail-panel:last-child { margin-bottom: 0; }
  .detail-panel-label { font-size: 0.78rem; color: var(--fg-muted); font-weight: 600; margin-bottom: 0.4rem; }
  .detail-tabbar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
  .detail-tabs { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .detail-tab {
    font-size: 0.75rem;
    padding: 0.3rem 0.65rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong);
    background: var(--bg-elevated);
    color: var(--fg-muted);
    font-weight: 600;
  }
  .detail-tab:hover { color: var(--fg); }
  .detail-tab.active { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }
  .detail-tab:disabled { opacity: 0.4; cursor: not-allowed; }
  .detail-tab:disabled:hover { color: var(--fg-muted); }
  .detail-copy {
    font-size: 0.75rem;
    padding: 0.3rem 0.65rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong);
    background: var(--bg-elevated);
    color: var(--fg-muted);
    font-weight: 600;
    flex-shrink: 0;
  }
  .detail-copy:hover { color: var(--fg); }
  .detail-copy.copied { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }
  .detail-code { margin: 0; max-height: 420px; overflow: auto; }
  .detail-markdown {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.75rem 0.9rem;
    font-size: 0.85rem;
    line-height: 1.6;
    max-height: 420px;
    overflow: auto;
  }
  .detail-markdown h3, .detail-markdown h4 { margin: 0.7rem 0 0.3rem; }
  .detail-markdown h3:first-child, .detail-markdown h4:first-child { margin-top: 0; }
  .detail-markdown p { margin: 0 0 0.6rem; }
  .detail-markdown p:last-child { margin-bottom: 0; }
  .detail-markdown pre { margin: 0.5rem 0; }
  .detail-markdown code { background: var(--bg-subtle); padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85em; font-family: var(--font-mono); }
  .detail-markdown pre code { background: none; padding: 0; }
  .detail-markdown ul { margin: 0.3rem 0 0.6rem; padding-left: 1.3rem; }
  .detail-markdown a { color: var(--accent); }

  .detail-json, .detail-content-json {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.75rem 0.9rem;
    max-height: 420px;
    overflow: auto;
    line-height: 1.6;
  }
  .detail-json .json-node summary, .detail-content-json .json-node summary { cursor: pointer; list-style: none; }
  .detail-json .json-node summary::-webkit-details-marker, .detail-content-json .json-node summary::-webkit-details-marker { display: none; }
  .detail-json .json-node summary::before, .detail-content-json .json-node summary::before {
    content: "\\25B8";
    display: inline-block;
    width: 1em;
    color: var(--fg-muted);
    transition: transform 0.12s ease;
  }
  .detail-json .json-node[open] > summary::before, .detail-content-json .json-node[open] > summary::before { transform: rotate(90deg); }
  .detail-json .json-children, .detail-content-json .json-children { padding-left: 1.1rem; border-left: 1px solid var(--border); margin-left: 0.35rem; }
  .detail-json .json-row, .detail-content-json .json-row { padding: 0.05rem 0; }
  .detail-json .json-count, .detail-content-json .json-count { color: var(--fg-faint); font-size: 0.85em; }
  .detail-json .json-key, .detail-content-json .json-key { color: var(--json-key); }
  .detail-json .json-string, .detail-content-json .json-string { color: var(--json-string); overflow-wrap: anywhere; }
  .detail-json .json-number, .detail-content-json .json-number { color: var(--json-number); }
  .detail-json .json-boolean, .detail-content-json .json-boolean { color: var(--json-boolean); }
  .detail-json .json-null, .detail-content-json .json-null { color: var(--fg-faint); }
  .detail-json .json-punctuation, .detail-content-json .json-punctuation { color: var(--fg-muted); }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
  .pill-ok { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-border); }
  .pill-error { color: var(--error); background: var(--error-bg); border-color: var(--error-border); }
  .pill-muted { color: var(--fg-muted); background: var(--bg-subtle); border-color: var(--border); }
  .pill-accent { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-border); }

  .banner { border-radius: var(--radius-md); padding: 0.85rem 1.1rem; margin-bottom: 1.25rem; border: 1px solid var(--border); font-size: 0.88rem; }
  .banner.error { background: var(--error-bg); color: #ffb3b6; border-color: var(--error-border); }
  .banner.success { background: var(--ok-bg); color: #a8f0c6; border-color: var(--ok-border); }

  form.inline { display: inline; }
  form.filters { display: flex; gap: 0.9rem; flex-wrap: wrap; align-items: end; margin-bottom: 1.25rem; }
  form.filters > label { display: flex; flex-direction: column; font-size: 0.78rem; color: var(--fg-muted); gap: 0.3rem; }

  input, select {
    font-family: var(--font-sans);
    font-size: 0.85rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--fg);
  }
  input::placeholder { color: var(--fg-faint); }
  input:focus, select:focus, button:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  button {
    font-family: var(--font-sans);
    font-size: 0.85rem;
    font-weight: 700;
    padding: 0.5rem 0.9rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-fg);
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.danger { background: transparent; color: var(--error); border-color: var(--error-border); font-weight: 600; }
  button.danger:hover { background: var(--error-bg); border-color: var(--error); }

  .muted { color: var(--fg-muted); }
  code, pre { font-family: var(--font-mono); }
  pre {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    padding: 0.75rem 0.9rem;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    max-width: 100%;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.82rem;
  }
  td code { color: var(--fg-muted); background: none; padding: 0; }

  details { font-size: 0.82rem; }
  details summary { cursor: pointer; color: var(--accent); font-weight: 600; }
  details summary:hover { text-decoration: underline; }
  details > div { margin-top: 0.6rem; }
  details strong { color: var(--fg-muted); font-weight: 600; font-size: 0.78rem; display: block; margin-bottom: 0.2rem; }

  .pagination { display: flex; gap: 1.25rem; align-items: center; margin-top: 0.5rem; font-size: 0.85rem; }
  .pagination a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .pagination a:hover { text-decoration: underline; }

  .instructions {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.1rem 1.25rem;
    white-space: pre-wrap;
    color: var(--fg-muted);
    font-size: 0.85rem;
    line-height: 1.65;
  }

  textarea {
    font-family: var(--font-sans);
    font-size: 0.85rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--fg);
    resize: vertical;
  }
  textarea::placeholder { color: var(--fg-faint); }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .login-shell { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
  .login-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 2.25rem 2rem;
    width: 340px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: 0 20px 60px -20px rgba(0, 0, 0, 0.6);
  }
  .login-card .brand { margin: 0 0 0.25rem; }
  .login-card .brand-badge { width: 34px; height: 34px; font-size: 13px; border-radius: 9px; }
  .login-card .brand-name { font-size: 1rem; }
  .login-card p.tagline { margin: 0; color: var(--fg-muted); font-size: 0.85rem; }
  .login-card input { width: 100%; }
  .login-card button { width: 100%; padding: 0.65rem; font-size: 0.9rem; }
  .login-card .banner { margin-bottom: 0; }
`;
