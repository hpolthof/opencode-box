import type { AssistantMessage, AssistantMessageEvent, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ChatMessage, ResponseFormat } from "../openai/types";
import { messagesToPiContext, structuredOutputHook, UnsupportedResponseFormatError, type FirstOutcome } from "./chat";
import { findPiModel, getPiModels, isChatGPTSignIn, PI_REASONING_OFF, type PiModelSummary } from "./models";
import { noteRejectedParams, planParams, rejectedParams, type RequestParams } from "./params";

/**
 * Runs one target (a model + reasoning level) of a /v1 or playground
 * request. Any failure - unknown model, unsupported format, provider error,
 * timeout before the first token - comes back as `{ ok: false, message }`
 * so the caller can fail over to the next target of an alias. A success
 * lists the client parameters that were not forwarded (`droppedParams`,
 * wire names - see ./params.ts).
 */

export interface PiTarget {
  providerID: string;
  modelID: string;
  variant: string | undefined;
}

export interface PiRunRequest extends RequestParams {
  messages: ChatMessage[];
  responseFormat?: ResponseFormat;
}

type Prepared =
  | {
      ok: true;
      summary: PiModelSummary;
      options: Record<string, unknown>;
      abort: AbortController;
      droppedParams: string[];
      /** Forwarded params the provider may still reject - see `withRejectedParamRetry`. */
      retryable: string[];
    }
  | { ok: false; message: string };

async function prepare(target: PiTarget, request: PiRunRequest): Promise<Prepared> {
  const id = `${target.providerID}/${target.modelID}`;
  const summary = await findPiModel(id);
  if (!summary) return { ok: false, message: `Model "${id}" is not available (is its provider still configured?)` };
  if (target.variant && !summary.variants.includes(target.variant)) {
    return { ok: false, message: `Variant "${target.variant}" is not available for model "${id}"` };
  }
  let formatHook;
  try {
    formatHook = structuredOutputHook(summary.model.api, request.responseFormat);
  } catch (err) {
    if (err instanceof UnsupportedResponseFormatError) return { ok: false, message: err.message };
    throw err;
  }
  const reasoning = Boolean(target.variant && target.variant !== PI_REASONING_OFF);
  const sendsSampling = request.maxOutputTokens !== undefined || request.temperature !== undefined || request.topP !== undefined;
  const plan = planParams(summary.model, reasoning, request, {
    chatgptSignIn: summary.model.provider === "openai" && sendsSampling && (await isChatGPTSignIn()),
    rejected: rejectedParams(id),
  });
  if (plan.dropped.length > 0) console.warn(`[piai] ${id}: not supported, dropped ${plan.dropped.join(", ")}`);
  const paramsHook = plan.onPayload;
  const onPayload = formatHook && paramsHook ? (p: unknown) => paramsHook(formatHook(p)) : formatHook ?? paramsHook;
  const abort = new AbortController();
  return {
    ok: true,
    summary,
    abort,
    droppedParams: plan.dropped,
    retryable: plan.retryable,
    options: {
      signal: abort.signal,
      ...plan.options,
      // Leaving `reasoning` out is pi-ai's way of switching it off.
      ...(reasoning ? { reasoning: target.variant as ThinkingLevel } : {}),
      ...(onPayload ? { onPayload } : {}),
    },
  };
}

type Failure = { ok: false; message: string };

/**
 * Runs `attempt` again - a fresh request to the same target - when it
 * failed because the provider rejected temperature or top_p, which is then
 * remembered for the model and left out (and reported as dropped). Bounded:
 * each retry drops one more of the parameters that were forwarded.
 */
async function withRejectedParamRetry<TOk extends { ok: true }>(
  target: PiTarget,
  attempt: () => Promise<{ result: TOk | Failure; retryable: string[] }>
): Promise<TOk | Failure> {
  for (;;) {
    const { result, retryable } = await attempt();
    if (result.ok) return result;
    if (!noteRejectedParams(`${target.providerID}/${target.modelID}`, retryable, result.message)) return result;
  }
}

function timeoutMessage(target: PiTarget): string {
  return `Model "${target.providerID}/${target.modelID}" did not respond in time`;
}

export async function piComplete(
  target: PiTarget,
  request: PiRunRequest,
  timeoutMs: number
): Promise<{ ok: true; message: AssistantMessage; droppedParams: string[] } | { ok: false; message: string }> {
  return withRejectedParamRetry(target, async () => {
    const prepared = await prepare(target, request);
    if (!prepared.ok) return { result: prepared, retryable: [] };
    const { summary, options, abort, droppedParams, retryable } = prepared;
    const failed = (message: string): { result: Failure; retryable: string[] } => ({
      result: { ok: false, message: abort.signal.aborted ? timeoutMessage(target) : message },
      retryable,
    });
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const context = messagesToPiContext(request.messages, summary.model);
      const message = await getPiModels().completeSimple(summary.model, context, options);
      if (message.stopReason === "error" || message.stopReason === "aborted") return failed(message.errorMessage ?? "Request failed");
      return { result: { ok: true as const, message, droppedParams }, retryable };
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  });
}

type OpenedStream = { ok: true; events: AsyncIterable<AssistantMessageEvent>; abort: AbortController; droppedParams: string[] };

async function openStream(target: PiTarget, request: PiRunRequest): Promise<(OpenedStream & { retryable: string[] }) | Failure> {
  const prepared = await prepare(target, request);
  if (!prepared.ok) return prepared;
  const { summary, abort, droppedParams, retryable } = prepared;
  const context = messagesToPiContext(request.messages, summary.model);
  return { ok: true, events: getPiModels().streamSimple(summary.model, context, prepared.options), abort, droppedParams, retryable };
}

/** Opens a pi-ai event stream for the target, without any timeout handling. */
export async function piOpenStream(target: PiTarget, request: PiRunRequest): Promise<OpenedStream | { ok: false; message: string }> {
  const opened = await openStream(target, request);
  if (!opened.ok) return opened;
  const { retryable: _retryable, ...stream } = opened;
  return stream;
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
): Promise<{ ok: true; built: TStream; droppedParams: string[] } | { ok: false; message: string }> {
  return withRejectedParamRetry<{ ok: true; built: TStream; droppedParams: string[] }>(target, async () => {
    const opened = await openStream(target, request);
    if (!opened.ok) return { result: opened, retryable: [] };
    const { events, abort, droppedParams, retryable } = opened;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const built = build(events);
    const outcome = await built.firstOutcome;
    clearTimeout(timer);
    if (!outcome.ok) return { result: { ok: false, message: abort.signal.aborted ? timeoutMessage(target) : outcome.message }, retryable };
    return { result: { ok: true as const, built, droppedParams }, retryable };
  });
}
