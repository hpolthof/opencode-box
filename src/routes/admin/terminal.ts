import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { spawnTerminalSession, type TerminalSession } from "../../terminal/session";
import { Terminal } from "../../views/terminal";

export const terminalRouter = new Hono();

// Re-exported so src/index.ts can hand it to Bun.serve() alongside app.fetch.
export { websocket };

terminalRouter.get("/terminal", (c) => {
  return c.html(Terminal({}) as string);
});

terminalRouter.get(
  "/terminal/ws",
  upgradeWebSocket(() => {
    let session: TerminalSession | undefined;

    return {
      onOpen(_evt, ws) {
        session = spawnTerminalSession();

        session.onData((chunk) => {
          try {
            // Bun's WSContext.send() is typed for a buffer-backed Uint8Array;
            // proc.stdout chunks are only known as ArrayBufferLike.
            ws.send(new Uint8Array(chunk));
          } catch {
            // Socket already closed - the exit handler below will clean up.
          }
        });

        session.onExit(() => {
          try {
            ws.close();
          } catch {
            // Already closed.
          }
        });
      },
      onMessage(evt) {
        if (!session) return;
        const data = evt.data;

        if (typeof data === "string") {
          let msg: unknown;
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }
          if (
            msg &&
            typeof msg === "object" &&
            (msg as { type?: unknown }).type === "resize" &&
            typeof (msg as { cols?: unknown }).cols === "number" &&
            typeof (msg as { rows?: unknown }).rows === "number"
          ) {
            const { cols, rows } = msg as { cols: number; rows: number };
            session.resize(cols, rows);
          }
          return;
        }

        // Binary frame: raw keystrokes/paste content to forward to the shell.
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBufferLike);
        session.write(bytes);
      },
      onClose() {
        session?.kill();
      },
    };
  })
);
