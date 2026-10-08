import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { v1Router } from "./routes/v1";
import { adminRouter } from "./routes/admin";
import { mcpRouter } from "./routes/mcp";

export const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

// Self-hosted admin UI fonts, so the dashboard renders correctly even when
// the deploying environment has no outbound access to Google Fonts.
app.use("/fonts/*", serveStatic({ root: "./public" }));

app.route("/v1", v1Router);
app.route("/mcp", mcpRouter);
app.route("/admin", adminRouter);
