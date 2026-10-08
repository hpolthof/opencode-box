/**
 * In-memory registry of requests that have been accepted but not yet logged
 * (still waiting for a provider, or streaming). Entries are removed as soon
 * as the request is written to the request log, so this only ever holds
 * what is in flight right now. Lost on restart, by design.
 */
export interface ActiveRequest {
  id: number;
  endpoint: string;
  appName: string;
  /** What the client asked for (alias or provider/model). */
  requestedModel: string;
  /**
   * The concrete provider/model: for a stream once a target has been
   * committed to, for a non-streaming request the target being tried. Null
   * before that.
   */
  servedModel: string | null;
  variant: string | null;
  alias: string | null;
  stream: boolean;
  requestBytes: number;
  /** ISO timestamp the request arrived. */
  startedAt: string;
}

const active = new Map<number, ActiveRequest>();
let nextId = 1;

export function startActiveRequest(info: Omit<ActiveRequest, "id" | "servedModel" | "startedAt">): number {
  const id = nextId++;
  active.set(id, { ...info, id, servedModel: null, startedAt: new Date().toISOString() });
  return id;
}

export function updateActiveRequest(
  id: number | undefined,
  patch: Partial<Pick<ActiveRequest, "servedModel" | "variant" | "alias">>
): void {
  const entry = id === undefined ? undefined : active.get(id);
  if (entry) Object.assign(entry, patch);
}

export function finishActiveRequest(id: number | undefined): void {
  if (id !== undefined) active.delete(id);
}

/** Safety net: an entry that somehow never got logged must not linger forever. */
const MAX_AGE_MS = 60 * 60 * 1000;

/** Oldest first. */
export function listActiveRequests(): ActiveRequest[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, entry] of active) {
    if (Date.parse(entry.startedAt) < cutoff) active.delete(id);
  }
  return [...active.values()];
}
