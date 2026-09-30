import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { getOrCreatePiDeviceId } from "../db/settings";
import { getPiModels } from "./models";

/**
 * Drives pi-ai's provider-owned OAuth login flows from the admin dashboard.
 *
 * pi-ai runs a login as a series of `notify` events (an auth URL to open, a
 * device code to enter, progress) and `prompt` questions it awaits an answer
 * to (e.g. "paste the redirect URL"). Here each login is a server-side
 * session that records those events and parks the current prompt until the
 * browser - polling `getLogin` - posts an answer via `answerLogin`.
 *
 * Providers that open a local callback server (Anthropic, ChatGPT) listen
 * inside the container, which the admin's browser usually can't reach, so
 * in practice the "paste the code / redirect URL" prompt is what completes
 * those logins.
 */

export type LoginStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface LoginPromptView {
  id: string;
  type: AuthPrompt["type"];
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface LoginSnapshot {
  id: string;
  providerId: string;
  status: LoginStatus;
  events: AuthEvent[];
  prompt: LoginPromptView | null;
  error: string | null;
}

interface PendingPrompt {
  view: LoginPromptView;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

interface LoginSession {
  id: string;
  providerId: string;
  status: LoginStatus;
  events: AuthEvent[];
  pending: PendingPrompt | null;
  error: string | null;
  abort: AbortController;
  startedAt: number;
  finishedAt: number | null;
}

/** A login nobody finishes is abandoned after this long. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** Finished sessions stay pollable this long so the page can show the outcome. */
const FINISHED_RETENTION_MS = 10 * 60_000;

const sessions = new Map<string, LoginSession>();

export class LoginNotSupportedError extends Error {
  constructor(providerId: string) {
    super(`Provider "${providerId}" has no OAuth login`);
    this.name = "LoginNotSupportedError";
  }
}

function snapshot(session: LoginSession): LoginSnapshot {
  return {
    id: session.id,
    providerId: session.providerId,
    status: session.status,
    events: session.events,
    prompt: session.pending?.view ?? null,
    error: session.error,
  };
}

function prune(now = Date.now()): void {
  for (const session of sessions.values()) {
    if (session.status === "running" && now - session.startedAt > LOGIN_TIMEOUT_MS) {
      session.abort.abort();
    }
    if (session.finishedAt !== null && now - session.finishedAt > FINISHED_RETENTION_MS) {
      sessions.delete(session.id);
    }
  }
}

/**
 * Starts an OAuth login for `providerId` and returns its session right
 * away; the flow continues in the background. A login already running for
 * the same provider is cancelled first. On success pi-ai stores the
 * credential through the configured CredentialStore.
 */
export function startLogin(providerId: string): LoginSnapshot {
  prune();
  const provider = getPiModels().getProvider(providerId);
  if (!provider?.auth.oauth) throw new LoginNotSupportedError(providerId);

  for (const other of sessions.values()) {
    if (other.providerId === providerId && other.status === "running") other.abort.abort();
  }

  const session: LoginSession = {
    id: crypto.randomUUID(),
    providerId,
    status: "running",
    events: [],
    pending: null,
    error: null,
    abort: new AbortController(),
    startedAt: Date.now(),
    finishedAt: null,
  };
  sessions.set(session.id, session);

  const interaction = {
    signal: session.abort.signal,
    notify(event: AuthEvent) {
      session.events.push(event);
    },
    prompt(prompt: AuthPrompt): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const view: LoginPromptView = {
          id: crypto.randomUUID(),
          type: prompt.type,
          message: prompt.message,
          ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
          ...(prompt.type === "select" ? { options: prompt.options.map((o) => ({ ...o })) } : {}),
        };
        const pending: PendingPrompt = { view, resolve, reject };
        session.pending = pending;
        // pi-ai aborts a "paste the code" prompt once its callback server
        // received the redirect itself - drop the prompt from the page then.
        const onAbort = () => {
          if (session.pending === pending) session.pending = null;
          reject(new Error("Prompt cancelled"));
        };
        if (prompt.signal?.aborted || session.abort.signal.aborted) return onAbort();
        prompt.signal?.addEventListener("abort", onAbort, { once: true });
        session.abort.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };

  getPiModels()
    .login(providerId, "oauth", interaction, { getDeviceId: getOrCreatePiDeviceId })
    .then(() => {
      session.status = "succeeded";
    })
    .catch((err: unknown) => {
      if (session.abort.signal.aborted) {
        session.status = "cancelled";
      } else {
        session.status = "failed";
        session.error = err instanceof Error ? err.message : String(err);
      }
    })
    .finally(() => {
      session.pending = null;
      session.finishedAt = Date.now();
    });

  return snapshot(session);
}

export function getLogin(id: string): LoginSnapshot | null {
  prune();
  const session = sessions.get(id);
  return session ? snapshot(session) : null;
}

/** Answers the session's current prompt. False when that prompt is no longer the open one. */
export function answerLogin(id: string, promptId: string, value: string): boolean {
  const session = sessions.get(id);
  const pending = session?.pending;
  if (!session || !pending || pending.view.id !== promptId) return false;
  session.pending = null;
  pending.resolve(value);
  return true;
}

export function cancelLogin(id: string): void {
  const session = sessions.get(id);
  if (session?.status === "running") session.abort.abort();
}

export async function logoutProvider(providerId: string): Promise<void> {
  await getPiModels().logout(providerId);
}
