import { CONFIG } from "./config";
import { app } from "./app";
import { startRetentionJob } from "./db/retentionJob";
// Imported for its side effect: ensures CONFIG.dbPath's parent directory
// exists and the schema is applied before we start accepting traffic.
import "./db/client";

function main() {
  const retentionJob = startRetentionJob();

  const server = Bun.serve({
    port: CONFIG.port,
    fetch: app.fetch,
  });

  console.log(`opencode-box listening on http://localhost:${CONFIG.port}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    retentionJob.stop();
    server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
