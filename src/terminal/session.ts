import { CONFIG } from "../config";

const BRIDGE_SCRIPT = `${import.meta.dir}/pty-bridge.py`;

const FRAME_DATA = 0;
const FRAME_RESIZE = 1;

function frame(type: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(5 + payload.length);
  buf[0] = type;
  new DataView(buf.buffer).setUint32(1, payload.length, false);
  buf.set(payload, 5);
  return buf;
}

export interface TerminalSession {
  /** Raw keystroke/paste bytes from the browser, forwarded to the shell. */
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

/** Spawns a real, resizable shell (via a PTY-allocating Python helper) and exposes it as byte streams. */
export function spawnTerminalSession(): TerminalSession {
  const proc = Bun.spawn(["python3", BRIDGE_SCRIPT, CONFIG.terminalShell], {
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  const dataCallbacks: Array<(chunk: Uint8Array) => void> = [];
  const exitCallbacks: Array<() => void> = [];

  (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      for (const cb of dataCallbacks) cb(chunk);
    }
  })().catch(() => {
    // Bridge process went away mid-read - onExit (below) reports this.
  });

  proc.exited.then(() => {
    for (const cb of exitCallbacks) cb();
  });

  return {
    write(bytes) {
      proc.stdin.write(frame(FRAME_DATA, bytes));
      proc.stdin.flush();
    },
    resize(cols, rows) {
      const payload = new Uint8Array(4);
      const view = new DataView(payload.buffer);
      view.setUint16(0, cols, false);
      view.setUint16(2, rows, false);
      proc.stdin.write(frame(FRAME_RESIZE, payload));
      proc.stdin.flush();
    },
    onData(cb) {
      dataCallbacks.push(cb);
    },
    onExit(cb) {
      exitCallbacks.push(cb);
    },
    kill() {
      proc.kill();
    },
  };
}
