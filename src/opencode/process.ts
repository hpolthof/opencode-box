import { mkdirSync } from "node:fs";
import { CONFIG } from "../config";

const DOC_URL = `http://${CONFIG.opencodeHost}:${CONFIG.opencodePort}/doc`;
const POLL_INTERVAL_MS = 250;
const POLL_ATTEMPT_TIMEOUT_MS = 2_000;
const STARTUP_TIMEOUT_MS = 30_000;

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // Bound each attempt: before the server is listening, connecting to
      // the port can hang far longer than a normal ECONNREFUSED would take
      // (observed in some sandboxed/container network stacks), which would
      // otherwise stall this whole loop past the overall deadline.
      const res = await fetch(DOC_URL, { signal: AbortSignal.timeout(POLL_ATTEMPT_TIMEOUT_MS) });
      if (res.ok) return;
    } catch {
      // opencode serve not accepting connections yet - keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `opencode serve did not become ready within ${STARTUP_TIMEOUT_MS}ms (polled ${DOC_URL})`
  );
}

/**
 * Spawns `opencode serve` as a child process, waits for it to accept
 * connections, and returns a handle to stop it.
 *
 * If the child process exits unexpectedly after startup, this logs to
 * stderr and exits the gateway process (no restart loop - that's handled
 * by the container's restart policy).
 */
export async function startOpenCode(): Promise<{ stop: () => void }> {
  mkdirSync(CONFIG.opencodeHome, { recursive: true });

  const proc = Bun.spawn(
    ["opencode", "serve", "--hostname", CONFIG.opencodeHost, "--port", String(CONFIG.opencodePort)],
    {
      env: { ...process.env, HOME: CONFIG.opencodeHome },
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  let stopped = false;

  proc.exited.then((exitCode) => {
    if (stopped) return;
    console.error(
      `[opencode/process] opencode serve exited unexpectedly (code ${exitCode}). Exiting gateway process.`
    );
    process.exit(1);
  });

  try {
    await waitUntilReady();
  } catch (err) {
    stopped = true;
    proc.kill();
    throw err;
  }

  return {
    stop: () => {
      stopped = true;
      proc.kill();
    },
  };
}
