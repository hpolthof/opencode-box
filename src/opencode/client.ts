import { CONFIG } from "../config";
import type {
  AssistantMessage,
  ModelListApiResponse,
  OpenCodeEvent,
  OutputFormat,
  Part,
  ProviderListResponse,
  SessionPromptBody,
  SessionPromptResponse,
} from "./types";

const BASE_URL = `http://${CONFIG.opencodeHost}:${CONFIG.opencodePort}`;

class OpenCodeRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "OpenCodeRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OpenCodeRequestError(
      res.status,
      `OpenCode request failed: ${init?.method ?? "GET"} ${path} -> ${res.status} ${body}`.slice(0, 2000)
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(title?: string): Promise<{ id: string }> {
  const body = title ? { title } : {};
  return request<{ id: string }>("/session", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Tool ids exposed by this OpenCode build (`GET /experimental/tool/ids` on
 * opencode 1.18.30), minus the internal "invalid" placeholder. Disabling all
 * of them makes a session prompt behave like a plain chat completion - the
 * model answers directly instead of reaching for bash/file/search tools (or
 * the "question" tool, which would otherwise leave the request hanging on a
 * reply this gateway never sends) - which is both faster and avoids side
 * effects in the server's working directory. Re-verify this list against
 * `GET /experimental/tool/ids` after upgrading the `opencode` binary, since
 * any newly added tool defaults to enabled.
 */
export const NO_TOOLS: Record<string, boolean> = Object.fromEntries(
  ["question", "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch"].map(
    (id) => [id, false]
  )
);

export interface SendMessageBody {
  system?: string;
  model: { providerID: string; modelID: string };
  parts: { type: "text"; text: string }[];
  format?: OutputFormat;
  /** Reasoning effort / thinking budget preset - one of the model's `variants[].id`. */
  variant?: string;
  /** Per-tool enable/disable overrides - pass `NO_TOOLS` for a plain, tool-free chat completion. */
  tools?: Record<string, boolean>;
}

function toSessionPromptBody(body: SendMessageBody): SessionPromptBody {
  return {
    model: body.model,
    parts: body.parts,
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.format !== undefined ? { format: body.format } : {}),
    ...(body.variant !== undefined ? { variant: body.variant } : {}),
    ...(body.tools !== undefined ? { tools: body.tools } : {}),
  };
}

export async function sendMessage(
  sessionId: string,
  body: SendMessageBody,
  signal?: AbortSignal
): Promise<SessionPromptResponse> {
  return request<SessionPromptResponse>(`/session/${sessionId}/message`, {
    method: "POST",
    body: JSON.stringify(toSessionPromptBody(body)),
    signal,
  });
}

export async function sendPromptAsync(sessionId: string, body: SendMessageBody, signal?: AbortSignal): Promise<void> {
  await request<unknown>(`/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify(toSessionPromptBody(body)),
    signal,
  });
}

/** Best-effort cleanup - never throws. */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await request<unknown>(`/session/${sessionId}`, { method: "DELETE" });
  } catch (err) {
    console.error(`[opencode/client] failed to delete session ${sessionId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Events (GET /event, server-sent, global across all sessions)
// ---------------------------------------------------------------------------

/**
 * Subscribes to OpenCode's global SSE event stream and yields parsed JSON
 * events as they arrive. Callers must filter by `properties.sessionID`
 * themselves - this stream carries events for every session on the server.
 */
export async function* subscribeEvents(signal?: AbortSignal): AsyncIterable<OpenCodeEvent> {
  const res = await fetch(`${BASE_URL}/event`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new OpenCodeRequestError(res.status, `Failed to subscribe to /event: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      // SSE frames are separated by a blank line.
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;

        const dataStr = dataLines.join("\n");
        if (dataStr === "" || dataStr === "[DONE]") continue;

        try {
          yield JSON.parse(dataStr) as OpenCodeEvent;
        } catch (err) {
          console.error("[opencode/client] failed to parse SSE event payload:", err, dataStr.slice(0, 200));
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Models, cached for 30s
//
// `GET /api/model` is a curated catalog (rich metadata: cost, context
// limits, capabilities) but only tracks a subset of providers - notably it
// does NOT include models for providers that were just connected via
// `opencode auth login` (e.g. a ChatGPT/OpenAI OAuth login shows up in
// `GET /provider`'s `connected` list and that provider's own `models` map
// immediately, but takes a separate, opencode-controlled sync to appear in
// `/api/model`). To avoid silently hiding just-connected providers, the
// catalog is the base and is *supplemented* with any model listed directly
// under a connected provider's `models` map that isn't already present.
// ---------------------------------------------------------------------------

export interface ModelSummary {
  id: string; // "providerID/modelID"
  providerID: string;
  modelID: string;
  name?: string;
  /** True when the model supports reasoning at all (regardless of whether variants are configured). */
  reasoning?: boolean;
  /** Ids of the model's configured variants (e.g. reasoning effort presets), if any. */
  variants?: string[];
  /** $/1M-token rate as reported by OpenCode itself, if any (may be `{input:0,output:0}` - see src/pricing.ts). */
  cost?: { input?: number; output?: number };
}

const MODEL_CACHE_TTL_MS = 30_000;
let modelCache: { data: ModelSummary[]; fetchedAt: number } | null = null;

export async function listModels(): Promise<ModelSummary[]> {
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.data;
  }

  const [catalog, providers] = await Promise.all([
    request<ModelListApiResponse>("/api/model"),
    request<ProviderListResponse>("/provider"),
  ]);

  const byId = new Map<string, ModelSummary>();
  for (const m of catalog.data ?? []) {
    const id = `${m.providerID}/${m.id}`;
    const variants = m.variants?.map((v) => v.id).filter((v) => v.length > 0);
    // The catalog's `cost` is an array of pricing tiers (e.g. short- vs
    // long-context); the first entry is the base/short-context rate.
    const cost = m.cost?.[0];
    byId.set(id, {
      id,
      providerID: m.providerID,
      modelID: m.id,
      name: m.name,
      reasoning: m.capabilities?.reasoning === true,
      ...(variants && variants.length > 0 ? { variants } : {}),
      ...(cost ? { cost: { input: cost.input, output: cost.output } } : {}),
    });
  }

  const connected = new Set(providers.connected ?? []);
  for (const provider of providers.all ?? []) {
    if (!connected.has(provider.id)) continue;
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      const id = `${provider.id}/${modelID}`;
      if (byId.has(id)) continue;
      // `GET /provider`'s per-model `variants` is an object keyed by variant
      // id (e.g. `{ high: { reasoningEffort: "high", ... } }`), unlike the
      // catalog's array-of-{id,...} shape - hence Object.keys() here instead
      // of the .map((v) => v.id) used for `catalog.data` above.
      const variants = Object.keys(model.variants ?? {}).filter((v) => v.length > 0);
      byId.set(id, {
        id,
        providerID: provider.id,
        modelID,
        name: model.name,
        reasoning: model.capabilities?.reasoning === true,
        ...(variants.length > 0 ? { variants } : {}),
        ...(model.cost ? { cost: { input: model.cost.input, output: model.cost.output } } : {}),
      });
    }
  }

  const data = [...byId.values()];
  modelCache = { data, fetchedAt: Date.now() };
  return data;
}

// ---------------------------------------------------------------------------
// Providers (GET /provider)
// ---------------------------------------------------------------------------

export interface ProviderSummary {
  id: string;
  name: string;
  connected: boolean;
}

export async function listProviders(): Promise<ProviderSummary[]> {
  const res = await request<ProviderListResponse>("/provider");
  const connected = new Set(res.connected ?? []);
  return (res.all ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    connected: connected.has(p.id),
  }));
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { AssistantMessage, OpenCodeEvent, OutputFormat, Part, SessionPromptResponse };
export { OpenCodeRequestError };
