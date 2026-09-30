import type { AssistantMessage, AssistantMessageEvent, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ChatMessage, ResponseFormat } from "../openai/types";
import { messagesToPiContext, structuredOutputHook, UnsupportedResponseFormatError, type FirstOutcome } from "./chat";
import { findPiModel, getPiModels, PI_REASONING_OFF, type PiModelSummary } from "./models";

/**
 * Runs one target (a model + reasoning level) of a /v1 or playground
 * request. Any failure - unknown model, unsupported format, provider error,
 * timeout before the first token - comes back as `{ ok: false, message }`
 * so the caller can fail over to the next target of an alias.
 */

export interface PiTarget {
  providerID: string;
  modelID: string;
  variant: string | undefined;
}

export interface PiRunRequest {
  messages: ChatMessage[];
  responseFormat?: ResponseFormat;
}

type Prepared =
  | { ok: true; summary: PiModelSummary; options: Record<string, unknown>; abort: AbortController }
  | { ok: false; message: string };

async function prepare(target: PiTarget, request: PiRunRequest): Promise<Prepared> {
  const id = `${target.providerID}/${target.modelID}`;
  const summary = await findPiModel(id);
  if (!summary) return { ok: false, message: `Model "${id}" is not available (is its provider still configured?)` };
  if (target.variant && !summary.variants.includes(target.variant)) {
    return { ok: false, message: `Variant "${target.variant}" is not available for model "${id}"` };
  }
  let onPayload;
  try {
    onPayload = structuredOutputHook(summary.model.api, request.responseFormat);
  } catch (err) {
    if (err instanceof UnsupportedResponseFormatError) return { ok: false, message: err.message };
    throw err;
  }
  const abort = new AbortController();
  return {
    ok: true,
    summary,
    abort,
    options: {
      signal: abort.signal,
      // Leaving `reasoning` out is pi-ai's way of switching it off.
      ...(target.variant && target.variant !== PI_REASONING_OFF ? { reasoning: target.variant as ThinkingLevel } : {}),
      ...(onPayload ? { onPayload } : {}),
    },
  };
}

function timeoutMessage(target: PiTarget): string {
  return `Model "${target.providerID}/${target.modelID}" did not respond in time`;
}

export async function piComplete(
  target: PiTarget,
  request: PiRunRequest,
  timeoutMs: number
): Promise<{ ok: true; message: AssistantMessage } | { ok: false; message: string }> {
  const prepared = await prepare(target, request);
  if (!prepared.ok) return prepared;
  const { summary, options, abort } = prepared;
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const context = messagesToPiContext(request.messages, summary.model);
    const message = await getPiModels().completeSimple(summary.model, context, options);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return { ok: false, message: abort.signal.aborted ? timeoutMessage(target) : message.errorMessage ?? "Request failed" };
    }
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: abort.signal.aborted ? timeoutMessage(target) : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Opens a pi-ai event stream for the target, without any timeout handling. */
export async function piOpenStream(
  target: PiTarget,
  request: PiRunRequest
): Promise<{ ok: true; events: AsyncIterable<AssistantMessageEvent>; abort: AbortController } | { ok: false; message: string }> {
  const prepared = await prepare(target, request);
  if (!prepared.ok) return prepared;
  const { summary, abort } = prepared;
  const context = messagesToPiContext(request.messages, summary.model);
  return { ok: true, events: getPiModels().streamSimple(summary.model, context, prepared.options), abort };
}

/**
 * Starts a streaming request, wraps pi-ai's events with `build` (a chat or
 * Responses SSE stream) and waits only until it gets off the ground - first
 * text delta, or a failure before any. The per-target timeout covers just
 * that phase: once text flows, a long answer must not be cut off.
 */
export async function piStartStream<TStream extends { firstOutcome: Promise<FirstOutcome> }>(
  target: PiTarget,
  request: PiRunRequest,
  build: (events: AsyncIterable<AssistantMessageEvent>) => TStream,
  timeoutMs: number
): Promise<{ ok: true; built: TStream } | { ok: false; message: string }> {
  const opened = await piOpenStream(target, request);
  if (!opened.ok) return opened;
  const { events, abort } = opened;
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const built = build(events);
  const outcome = await built.firstOutcome;
  clearTimeout(timer);
  if (!outcome.ok) return { ok: false, message: abort.signal.aborted ? timeoutMessage(target) : outcome.message };
  return { ok: true, built };
}
