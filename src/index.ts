import { CONFIG } from "./config";
import { startOpenCode } from "./opencode/process";
import { app } from "./app";
import { websocket } from "./routes/admin/terminal";
// Imported for its side effect: ensures CONFIG.dbPath's parent directory
// exists and the schema is applied before we start accepting traffic.
import "./db/client";

async function main() {
  const opencode = await startOpenCode();

  const server = Bun.serve({
    port: CONFIG.port,
    fetch: app.fetch,
    websocket,
  });

  console.log(`opencode-box listening on http://localhost:${CONFIG.port}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    opencode.stop();
    server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
