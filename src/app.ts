import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { v1Router } from "./routes/v1";
import { adminRouter } from "./routes/admin";

export const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

// Self-hosted admin UI fonts, so the dashboard renders correctly even when
// the deploying environment has no outbound access to Google Fonts.
app.use("/fonts/*", serveStatic({ root: "./public" }));

// Self-hosted terminal UI library, served straight out of node_modules
// (no build step / no committed vendor copy needed).
app.use(
  "/vendor/xterm/*",
  serveStatic({
    root: "./node_modules/@xterm/xterm",
    rewriteRequestPath: (path) => path.replace(/^\/vendor\/xterm/, ""),
  })
);
app.use(
  "/vendor/xterm-addon-fit/*",
  serveStatic({
    root: "./node_modules/@xterm/addon-fit",
    rewriteRequestPath: (path) => path.replace(/^\/vendor\/xterm-addon-fit/, ""),
  })
);

app.route("/v1", v1Router);
app.route("/admin", adminRouter);
