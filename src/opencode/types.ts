/**
 * Wire types for OpenCode's server API (opencode serve).
 *
 * Verified directly against a live `opencode serve` instance's OpenAPI 3.1
 * spec (GET /doc) plus real request/response traffic on 2026-09-12. These
 * are intentionally partial - only the fields the gateway actually reads or
 * writes are modeled, everything else on the wire is ignored.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface OpenCodeSession {
  id: string;
  title?: string;
  parentID?: string;
  [key: string]: unknown;
}

export interface CreateSessionBody {
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  metadata?: Record<string, unknown>;
  permission?: unknown;
  workspaceID?: string;
}

// ---------------------------------------------------------------------------
// Parts (request side: what we send)
// ---------------------------------------------------------------------------

export interface TextPartInput {
  type: "text";
  text: string;
}

// ---------------------------------------------------------------------------
// Output format (structured output)
// ---------------------------------------------------------------------------

export interface OutputFormatText {
  type: "text";
}

export interface OutputFormatJsonSchema {
  type: "json_schema";
  schema: unknown;
  retryCount?: number;
}

export type OutputFormat = OutputFormatText | OutputFormatJsonSchema;

// ---------------------------------------------------------------------------
// session.prompt / session.prompt_async request body
// ---------------------------------------------------------------------------

export interface SessionPromptBody {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
  format?: OutputFormat;
  system?: string;
  variant?: string;
  parts: TextPartInput[];
}

// ---------------------------------------------------------------------------
// Parts (response side: what OpenCode sends back)
// ---------------------------------------------------------------------------

export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
}

/**
 * Other part variants (reasoning, tool, file, step-start, step-finish,
 * snapshot, patch, agent, subtask, retry, ...) all carry at minimum a
 * `type` discriminant that is not "text". We don't need their fields, so
 * they're modeled as an open bag with a non-"text" type tag.
 */
export interface OtherPart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  [key: string]: unknown;
}

export type Part = TextPart | OtherPart;

export function isTextPart(part: Part): part is TextPart {
  return part.type === "text" && typeof (part as TextPart).text === "string";
}

// ---------------------------------------------------------------------------
// Assistant message
// ---------------------------------------------------------------------------

export interface AssistantMessageError {
  name?: string;
  message?: string;
  [key: string]: unknown;
}

export interface AssistantMessageTokens {
  total: number;
  input: number;
  output: number;
  reasoning?: number;
  cache?: { read: number; write: number };
}

export interface AssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: { cwd: string; root: string };
  cost: number;
  tokens: AssistantMessageTokens;
  time: { created: number; completed?: number };
  error?: AssistantMessageError;
  finish?: string;
  summary?: boolean;
  variant?: string;
  structured?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// session.prompt / session.prompt_async response bodies
// ---------------------------------------------------------------------------

export interface SessionPromptResponse {
  info: AssistantMessage;
  parts: Part[];
}

// ---------------------------------------------------------------------------
// Events (GET /event, server-sent)
// ---------------------------------------------------------------------------

export interface MessagePartUpdatedEvent {
  id: string;
  type: "message.part.updated";
  properties: {
    sessionID: string;
    part: Part;
    time: unknown;
  };
}

export interface MessageUpdatedEvent {
  id: string;
  type: "message.updated";
  properties: {
    sessionID: string;
    info: AssistantMessage;
  };
}

export interface OtherEvent {
  id?: string;
  type: string;
  properties?: { sessionID?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type OpenCodeEvent = MessagePartUpdatedEvent | MessageUpdatedEvent | OtherEvent;

export function isMessagePartUpdated(event: OpenCodeEvent): event is MessagePartUpdatedEvent {
  return event.type === "message.part.updated";
}

export function isMessageUpdated(event: OpenCodeEvent): event is MessageUpdatedEvent {
  return event.type === "message.updated";
}

// ---------------------------------------------------------------------------
// Models (GET /api/model)
// ---------------------------------------------------------------------------

export interface ModelV2Cost {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
}

/**
 * A named, pre-configured alternate of a model - most commonly used for
 * reasoning effort / thinking budget (e.g. ids like "low", "high", "max"),
 * selected on a session prompt via the top-level `variant` field. Ids are
 * model-defined; there is no fixed enum.
 */
export interface ModelV2Variant {
  id: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface ModelV2Capabilities {
  reasoning?: boolean;
  tools?: boolean;
  [key: string]: unknown;
}

export interface ModelV2Info {
  id: string; // bare model id, NOT combined with providerID
  providerID: string;
  family?: string;
  name?: string;
  capabilities?: ModelV2Capabilities;
  status?: "alpha" | "beta" | "deprecated" | "active";
  enabled?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  cost?: ModelV2Cost[];
  variants?: ModelV2Variant[];
  [key: string]: unknown;
}

export interface ModelListApiResponse {
  location: unknown;
  data: ModelV2Info[];
}

// ---------------------------------------------------------------------------
// Providers (GET /provider)
// ---------------------------------------------------------------------------

/**
 * A model as reported directly by `GET /provider` - this is the raw,
 * provider-supplied shape, distinct from (and richer in some ways than)
 * `ModelV2Info` from the curated `GET /api/model` catalog. Notably its
 * `variants` is an *object keyed by variant id* (e.g. `{ high: { ... } }`),
 * not an array of `{ id, headers, body }` like the catalog's. A
 * newly-connected provider's models only show up here until OpenCode syncs
 * them into `/api/model` (see the comment on `listModels`) - so this is
 * often the *only* place reasoning/variant info is available for a model
 * that was just connected.
 */
export interface ProviderModel {
  id?: string;
  name?: string;
  family?: string;
  capabilities?: ModelV2Capabilities;
  variants?: Record<string, unknown>;
  /** Unlike the catalog's `ModelV2Info.cost` (an array of tiers), this is a single flat rate. */
  cost?: ModelV2Cost;
  [key: string]: unknown;
}

export interface Provider {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  env: string[];
  key?: string;
  options: Record<string, unknown>;
  models: Record<string, ProviderModel>;
}

export interface ProviderListResponse {
  all: Provider[];
  default: Record<string, string>;
  connected: string[];
}
