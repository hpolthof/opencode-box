import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiKeyAuth, getApiKey, type ApiKeyAuthEnv } from "../auth/apiKeyAuth";
import { listCatalogModels, type ModelSummary } from "../catalog";
import { findAliasByName, listAliases } from "../db/modelAliases";
import { finishActiveRequest, startActiveRequest, updateActiveRequest } from "../activeRequests";
import { insertRequestLog } from "../db/requests";
import { piMessageToResponseObject, responsesFormat, responsesInputToMessages } from "../openai/responsesTranslate";
import { createResponsesStream } from "../openai/responsesStream";
import type { ResponseCreateParams } from "../openai/responsesTypes";
import { InvalidModelError, parseModelId } from "../openai/translate";
import { openAIError, type ChatCompletionRequest, type ModelListResponse } from "../openai/types";
import type { TokenUsage } from "../openai/usage";
import { createPiChatStream, piMessageToOpenAIResponse, piUsageToTokenUsage, type FirstOutcome, type StreamDoneResult } from "../piai/chat";
import { gatewayError } from "../piai/errors";
import type { RequestParams } from "../piai/params";
import { piComplete, piStartStream, type PiRunRequest, type TargetError } from "../piai/run";
import { isReasoningLevel, resolveReasoningVariant } from "../reasoning";
import type { RequestLogEntry } from "../types";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export const v1Router = new Hono<ApiKeyAuthEnv>();

v1Router.use("*", apiKeyAuth);

interface PendingLog {
  apiKeyId: number | null;
  appName: string;
  model: string;
  variant: string | null;
  alias?: string | null;
  notes?: string | null;
  stream: boolean;
  requestBody: string | null;
  /** Id in the in-flight registry (see activeRequests.ts); cleared when the request is logged. */
  activeId?: number;
}

/** Registers the request as in flight; it is removed again by `logOk`/`logError`. */
function trackActive(pending: PendingLog, endpoint: string): void {
  pending.activeId = startActiveRequest({
    endpoint,
    appName: pending.appName,
    requestedModel: pending.model,
    variant: pending.variant,
    alias: pending.alias ?? null,
    stream: pending.stream,
    requestBytes: pending.requestBody?.length ?? 0,
  });
}

type TokenFields = "promptTokens" | "completionTokens" | "totalTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens";

function baseLog(pending: PendingLog, start: number): Omit<RequestLogEntry, "status" | "httpStatus" | "errorMessage" | "responseBody" | TokenFields> {
  return {
    apiKeyId: pending.apiKeyId,
    appName: pending.appName,
    model: pending.model,
    variant: pending.variant,
    alias: pending.alias ?? null,
    notes: pending.notes ?? null,
    stream: pending.stream,
    requestBody: pending.requestBody,
    latencyMs: Date.now() - start,
  };
}

function logOk(
  pending: PendingLog,
  start: number,
  httpStatus: number,
  responseBody: string,
  usage?: TokenUsage | null
) {
  finishActiveRequest(pending.activeId);
  insertRequestLog({
    ...baseLog(pending, start),
    status: "ok",
    httpStatus,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    errorMessage: null,
    responseBody,
  });
}

function logError(pending: PendingLog, start: number, httpStatus: number, errorMessage: string, responseBody: string | null = null) {
  finishActiveRequest(pending.activeId);
  insertRequestLog({
    ...baseLog(pending, start),
    status: "error",
    httpStatus,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    errorMessage,
    responseBody,
  });
}

interface ResolvedTarget {
  providerID: string;
  modelID: string;
  variant: string | undefined;
}

export type ModelResolution =
  | {
      ok: true;
      /** Each target's `variant` is the level that will actually be sent (after mapping/clamping). */
      targets: ResolvedTarget[];
      /**
       * True when the client sent an explicit effort to an alias that pins
       * its levels (`clientEffortOverrides` off), so that effort was
       * ignored. Always false for a plain model.
       */
      clientEffortIgnored: boolean;
      /** The alias that was resolved, or null for a plain model. */
      alias: string | null;
    }
  | { ok: false; status: 400 | 403 | 404 | 502; message: string; type: "invalid_request_error" | "api_error"; code?: string };

/** Fisher-Yates - used for alias `mode: "random"` so each request gets a fresh order to try targets in. */
function shuffled<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Shared by /chat/completions and /responses. `requestedModel` is exactly
 * what the client sent as `model` - first checked against the model-alias
 * table (an alias always wins over a same-named real model), then, if it
 * isn't an alias, parsed as a plain "provider/model[#variant]" id.
 *
 * On success this returns an ORDERED list of one or more targets to attempt
 * in turn (see `completeWithFailover`/`streamWithFailover` below) - a plain
 * model resolves to exactly one; an alias resolves to its configured
 * targets, ordered by `position` for `mode: "priority"` or shuffled fresh
 * for `mode: "random"`, with any target whose underlying model is no longer
 * available (e.g. its provider was signed out) filtered out up front. Either way this confirms
 * the request is allowed for the calling key (checked against
 * `requestedModel` as typed - the alias name itself for an alias, not what
 * it points to) and, for a plain model, that it actually offers the
 * requested reasoning variant.
 *
 * Reasoning levels (see `resolveReasoningVariant`): no level, or an
 * explicit "none"/"off", means as little reasoning as the model allows. For
 * a plain model any other level it doesn't offer is a 400. An alias uses
 * each target's pinned level (a pinned "none" mapped the same way), unless
 * it has `clientEffortOverrides` on and the client sent an effort: then
 * that effort goes to every target, clamped to the nearest level each
 * target offers. With the setting off, an explicit effort is ignored and
 * `clientEffortIgnored` says so.
 */
export async function resolveRequestedModel(
  requestedModel: string,
  explicitVariant: string | undefined,
  allowedModels: string[] | null
): Promise<ModelResolution> {
  const alias = findAliasByName(requestedModel);
  if (alias) {
    if (allowedModels && !allowedModels.includes(requestedModel)) {
      return {
        ok: false,
        status: 403,
        message: `API key is not permitted to use model "${requestedModel}"`,
        type: "invalid_request_error",
        code: "model_not_allowed",
      };
    }
    let available: ModelSummary[];
    try {
      available = await listCatalogModels();
    } catch {
      return { ok: false, status: 502, message: "Failed to look up available models", type: "api_error" };
    }
    const applyClientEffort = alias.clientEffortOverrides && explicitVariant !== undefined;
    if (applyClientEffort && !isReasoningLevel(explicitVariant)) {
      return {
        ok: false,
        status: 400,
        message: `Variant "${explicitVariant}" is not a reasoning level (alias "${requestedModel}")`,
        type: "invalid_request_error",
        code: "variant_not_found",
      };
    }
    const orderedTargets = alias.mode === "random" ? shuffled(alias.targets) : alias.targets;
    const targets: ResolvedTarget[] = [];
    for (const t of orderedTargets) {
      const matched = available.find((m) => m.providerID === t.providerID && m.modelID === t.modelID);
      if (!matched) continue;
      const resolved = applyClientEffort
        ? resolveReasoningVariant(explicitVariant, matched.variants, { clamp: true })
        : resolveReasoningVariant(t.variant, matched.variants);
      // A pinned level the model no longer offers (other than "none"/"off")
      // is passed on as is, so prepare() rejects it and the next target runs.
      targets.push({ providerID: t.providerID, modelID: t.modelID, variant: resolved.ok ? resolved.variant : t.variant });
    }
    if (targets.length === 0) {
      return {
        ok: false,
        status: 502,
        message: `Alias "${requestedModel}" has no currently-available target model`,
        type: "api_error",
      };
    }
    return { ok: true, targets, clientEffortIgnored: explicitVariant !== undefined && !alias.clientEffortOverrides, alias: alias.alias };
  }

  let providerID: string;
  let modelID: string;
  let variantFromModel: string | undefined;
  try {
    ({ providerID, modelID, variant: variantFromModel } = parseModelId(requestedModel));
  } catch (err) {
    const message = err instanceof InvalidModelError ? err.message : "Invalid model id";
    return { ok: false, status: 400, message, type: "invalid_request_error" };
  }
  const requestedVariant = explicitVariant ?? variantFromModel;
  const requestedId = `${providerID}/${modelID}`;

  try {
    const available = await listCatalogModels();
    const matched = available.find((m) => m.id === requestedId);
    if (!matched) {
      return {
        ok: false,
        status: 404,
        message: `Model "${requestedId}" is not available on this gateway`,
        type: "invalid_request_error",
        code: "model_not_found",
      };
    }
    if (allowedModels && !allowedModels.includes(requestedId)) {
      return {
        ok: false,
        status: 403,
        message: `API key is not permitted to use model "${requestedId}"`,
        type: "invalid_request_error",
        code: "model_not_allowed",
      };
    }
    // No level, or "none"/"off" -> as little reasoning as the model allows;
    // any other level the model doesn't offer is rejected.
    const resolved = resolveReasoningVariant(requestedVariant, matched.variants);
    if (!resolved.ok) {
      const knownVariants = matched.variants ?? [];
      return {
        ok: false,
        status: 400,
        message: `Variant "${requestedVariant}" is not available for model "${requestedId}". Available variants: ${knownVariants.join(", ") || "(this model has no reasoning levels)"}`,
        type: "invalid_request_error",
        code: "variant_not_found",
      };
    }
    return { ok: true, targets: [{ providerID, modelID, variant: resolved.variant }], clientEffortIgnored: false, alias: null };
  } catch {
    return { ok: false, status: 502, message: "Failed to look up available models", type: "api_error" };
  }
}

/**
 * How long a single target gets to respond before it's treated as
 * non-responsive and the next target (if any) is tried instead. Applies per
 * target, not to the request as a whole - an alias with several targets can
 * take a multiple of this in the worst case. 120s comfortably covers slow
 * high-reasoning-effort variants (e.g. "xhigh") that are legitimately just
 * thinking for a while, not stuck.
 */
const FAILOVER_TIMEOUT_MS = 120_000;

/**
 * Tries each target in order for a non-streaming request, moving on to the
 * next on a failure another target might not have (provider 5xx/429/auth,
 * unavailable model, network error, timeout). Stops at a failure that marks
 * the request itself as invalid (`failover: false`, e.g. a provider 400).
 * Returns the first success, or the last failure.
 */
async function completeWithFailover(
  targets: ResolvedTarget[],
  request: PiRunRequest,
  onAttempt: (target: ResolvedTarget) => void
): Promise<
  | { ok: true; target: ResolvedTarget; targetIndex: number; message: AssistantMessage; droppedParams: string[] }
  | { ok: false; error: TargetError }
> {
  let lastError = gatewayError("No target model available");
  for (const [targetIndex, target] of targets.entries()) {
    onAttempt(target);
    const attempt = await piComplete(target, request, FAILOVER_TIMEOUT_MS);
    if (attempt.ok) return { ok: true, target, targetIndex, message: attempt.message, droppedParams: attempt.droppedParams };
    lastError = attempt.error;
    if (!lastError.failover) break;
  }
  return { ok: false, error: lastError };
}

/**
 * Streaming counterpart: tries each target only until its stream gets off
 * the ground (see `piStartStream`). Nothing reaches the client before a
 * target is committed to, so a failure up to that point can still fail
 * over; after it, the stream runs to completion (or fails) on its own.
 */
async function streamWithFailover<TStream extends { firstOutcome: Promise<FirstOutcome>; stream: ReadableStream<Uint8Array>; done: Promise<StreamDoneResult> }>(
  targets: ResolvedTarget[],
  request: PiRunRequest,
  build: (events: AsyncIterable<AssistantMessageEvent>) => TStream
): Promise<
  | { ok: true; target: ResolvedTarget; targetIndex: number; built: TStream; droppedParams: string[] }
  | { ok: false; error: TargetError }
> {
  let lastError = gatewayError("No target model available");
  for (const [targetIndex, target] of targets.entries()) {
    const attempt = await piStartStream(target, request, build, FAILOVER_TIMEOUT_MS);
    if (attempt.ok) return { ok: true, target, targetIndex, built: attempt.built, droppedParams: attempt.droppedParams };
    lastError = attempt.error;
    if (!lastError.failover) break;
  }
  return { ok: false, error: lastError };
}

/** Logs and answers a request whose every attempted target failed, with the (last) target's classified error. */
function targetErrorResponse(c: Context<ApiKeyAuthEnv>, pending: PendingLog, start: number, rawBody: string, error: TargetError): Response {
  logError(pending, start, error.status, error.message, rawBody);
  return c.json(openAIError(error.message, error.type, error.code, error.param), error.status as ContentfulStatusCode);
}

type JsonBody<T> = { ok: true; rawBody: string; body: T } | { ok: false; response: Response };

/** Reads and parses the request body, logging and answering 400 on failure. */
async function readJsonBody<T>(c: Context<ApiKeyAuthEnv>, start: number): Promise<JsonBody<T>> {
  const apiKey = getApiKey(c);
  const unknownRequest = (requestBody: string | null): PendingLog => ({
    apiKeyId: apiKey.id,
    appName: apiKey.name,
    model: "unknown",
    variant: null,
    stream: false,
    requestBody,
  });
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    const message = "Failed to read request body";
    logError(unknownRequest(null), start, 400, message);
    return { ok: false, response: c.json(openAIError(message, "invalid_request_error"), 400) };
  }
  try {
    return { ok: true, rawBody, body: JSON.parse(rawBody) as T };
  } catch {
    const message = "Request body must be valid JSON";
    logError(unknownRequest(rawBody), start, 400, message, rawBody);
    return { ok: false, response: c.json(openAIError(message, "invalid_request_error"), 400) };
  }
}

function sseResponse(c: Context<ApiKeyAuthEnv>, stream: ReadableStream<Uint8Array>): Response {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.newResponse(stream);
}

/** Logs a committed stream's outcome once it has finished. */
function logWhenDone(pending: PendingLog, start: number, done: Promise<StreamDoneResult>): void {
  done
    .then((result) => {
      if (result.errorMessage) {
        logError(pending, start, 200, result.errorMessage, result.fullText);
      } else {
        logOk(pending, start, 200, result.fullText, result.usage);
      }
    })
    .catch((err) => {
      console.error("[routes/v1] streaming done handler failed:", err);
    });
}

/**
 * The sampling / limit fields shared by both endpoints; `capField` is the
 * body field holding the output token cap (Chat: `max_completion_tokens`,
 * else the legacy `max_tokens`; Responses: `max_output_tokens`). Values of
 * the wrong type are ignored.
 */
function requestParams(body: Record<string, unknown>, capField: "max_output_tokens" | "max_completion_tokens" | "max_tokens"): RequestParams {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const cap = body[capField];
  return {
    ...(typeof cap === "number" && Number.isInteger(cap) && cap > 0 ? { maxOutputTokens: cap, maxOutputTokensParam: capField } : {}),
    ...(num(body.temperature) !== undefined ? { temperature: num(body.temperature) } : {}),
    ...(num(body.top_p) !== undefined ? { topP: num(body.top_p) } : {}),
    ...(typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0 ? { promptCacheKey: body.prompt_cache_key } : {}),
  };
}

/**
 * Records which target served the request - in the request log and in
 * response headers, which clients can read without changing the OpenAI
 * response shape their SDKs parse:
 *
 * - `x-served-model`: the concrete provider/model that answered;
 * - `x-served-reasoning`: the reasoning level sent to the provider, or
 *   `default` when none was (the model's own minimum);
 * - `x-alias-target-index` (aliases only): 0-based position of that target,
 *   and `x-failover: true` when it wasn't the first;
 * - `x-reasoning-overridden: true`: the client's effort was ignored because
 *   the alias pins its levels;
 * - `x-dropped-params`: client parameters not forwarded to this model.
 */
function commitServed(
  c: Context<ApiKeyAuthEnv>,
  pending: PendingLog,
  resolution: Extract<ModelResolution, { ok: true }>,
  served: { target: ResolvedTarget; targetIndex: number; droppedParams: string[] }
): void {
  const { target, targetIndex, droppedParams } = served;
  pending.model = `${target.providerID}/${target.modelID}`;
  pending.variant = target.variant ?? null;
  const notes: string[] = [];
  c.header("x-served-model", pending.model);
  c.header("x-served-reasoning", target.variant ?? "default");
  if (resolution.alias) {
    c.header("x-alias-target-index", String(targetIndex));
    if (targetIndex > 0) {
      c.header("x-failover", "true");
      notes.push(`failover: served by target ${targetIndex + 1} of ${resolution.targets.length}`);
    }
  }
  if (resolution.clientEffortIgnored) {
    c.header("x-reasoning-overridden", "true");
    notes.push("client reasoning effort ignored: the alias pins its levels");
  }
  if (droppedParams.length > 0) {
    c.header("x-dropped-params", droppedParams.join(", "));
    notes.push(`not forwarded: ${droppedParams.join(", ")}`);
  }
  pending.notes = notes.length > 0 ? notes.join("; ") : null;
  updateActiveRequest(pending.activeId, { servedModel: pending.model, variant: pending.variant });
}

/**
 * Shows the target a non-streaming request is waiting on in the in-flight
 * list: such a request has no first-token moment, so without this it would
 * read "connecting" until the whole answer is in (and then be gone).
 */
function trackAttempt(pending: PendingLog, target: ResolvedTarget): void {
  updateActiveRequest(pending.activeId, { servedModel: `${target.providerID}/${target.modelID}`, variant: target.variant ?? null });
}

v1Router.post("/chat/completions", async (c) => {
  const start = Date.now();
  const apiKey = getApiKey(c);
  const parsed = await readJsonBody<ChatCompletionRequest>(c, start);
  if (!parsed.ok) return parsed.response;
  const { rawBody, body } = parsed;

  const pending: PendingLog = {
    apiKeyId: apiKey.id,
    appName: apiKey.name,
    model: typeof body?.model === "string" ? body.model : "unknown",
    variant: null,
    stream: Boolean(body?.stream),
    requestBody: rawBody,
  };
  trackActive(pending, "/v1/chat/completions");

  if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    const message = "Request must include a string `model` and an array `messages`";
    logError(pending, start, 400, message, rawBody);
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

  const explicitVariant =
    typeof body.reasoning_effort === "string" && body.reasoning_effort.length > 0 ? body.reasoning_effort : undefined;

  const resolution = await resolveRequestedModel(body.model, explicitVariant, apiKey.allowedModels);
  if (!resolution.ok) {
    pending.variant = explicitVariant ?? null;
    logError(pending, start, resolution.status, resolution.message, rawBody);
    return c.json(openAIError(resolution.message, resolution.type, resolution.code), resolution.status);
  }
  // A plain model resolves to one target whose (possibly defaulted)
  // reasoning level is known up front - log it even if the call fails.
  pending.alias = resolution.alias;
  if (resolution.targets.length === 1) pending.variant = resolution.targets[0].variant ?? null;
  updateActiveRequest(pending.activeId, { alias: pending.alias, variant: pending.variant });

  const request: PiRunRequest = {
    messages: body.messages,
    responseFormat: body.response_format,
    ...requestParams(body, typeof body.max_completion_tokens === "number" ? "max_completion_tokens" : "max_tokens"),
  };

  if (!body.stream) {
    const result = await completeWithFailover(resolution.targets, request, (target) => trackAttempt(pending, target));
    if (!result.ok) return targetErrorResponse(c, pending, start, rawBody, result.error);
    commitServed(c, pending, resolution, result);
    const response = piMessageToOpenAIResponse(body.model, result.message);
    logOk(pending, start, 200, JSON.stringify(response), piUsageToTokenUsage(result.message.usage));
    return c.json(response, 200);
  }

  const includeUsage = body.stream_options?.include_usage === true;
  const result = await streamWithFailover(resolution.targets, request, (events) =>
    createPiChatStream(events, body.model, { includeUsage })
  );
  if (!result.ok) return targetErrorResponse(c, pending, start, rawBody, result.error);
  commitServed(c, pending, resolution, result);
  logWhenDone(pending, start, result.built.done);
  return sseResponse(c, result.built.stream);
});

v1Router.post("/responses", async (c) => {
  const start = Date.now();
  const apiKey = getApiKey(c);
  const parsed = await readJsonBody<ResponseCreateParams>(c, start);
  if (!parsed.ok) return parsed.response;
  const { rawBody, body } = parsed;

  const pending: PendingLog = {
    apiKeyId: apiKey.id,
    appName: apiKey.name,
    model: typeof body?.model === "string" ? body.model : "unknown",
    variant: null,
    stream: Boolean(body?.stream),
    requestBody: rawBody,
  };
  trackActive(pending, "/v1/responses");

  const hasInput = typeof body?.input === "string" ? body.input.length > 0 : Array.isArray(body?.input);
  if (!body || typeof body.model !== "string" || !hasInput) {
    const message = 'Request must include a string `model` and a non-empty `input` (string or array of message items)';
    logError(pending, start, 400, message, rawBody);
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

  if (typeof body.previous_response_id === "string" && body.previous_response_id.length > 0) {
    const message = "`previous_response_id` is not supported - this gateway is stateless, so send the full conversation as `input`";
    logError(pending, start, 400, message, rawBody);
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

  if (body.text?.format?.type === "json_schema" && (typeof body.text.format.schema !== "object" || body.text.format.schema === null)) {
    const message = '`text.format.schema` must be an object when `text.format.type` is "json_schema"';
    logError(pending, start, 400, message, rawBody);
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

  const explicitVariant =
    typeof body.reasoning?.effort === "string" && body.reasoning.effort.length > 0 ? body.reasoning.effort : undefined;

  const resolution = await resolveRequestedModel(body.model, explicitVariant, apiKey.allowedModels);
  if (!resolution.ok) {
    pending.variant = explicitVariant ?? null;
    logError(pending, start, resolution.status, resolution.message, rawBody);
    return c.json(openAIError(resolution.message, resolution.type, resolution.code), resolution.status);
  }
  pending.alias = resolution.alias;
  if (resolution.targets.length === 1) pending.variant = resolution.targets[0].variant ?? null;
  updateActiveRequest(pending.activeId, { alias: pending.alias, variant: pending.variant });

  const instructions = typeof body.instructions === "string" ? body.instructions : null;
  const request: PiRunRequest = {
    messages: responsesInputToMessages(body.input, instructions ?? undefined),
    responseFormat: responsesFormat(body.text),
    ...requestParams(body, "max_output_tokens"),
  };
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;

  if (!body.stream) {
    const result = await completeWithFailover(resolution.targets, request, (target) => trackAttempt(pending, target));
    if (!result.ok) return targetErrorResponse(c, pending, start, rawBody, result.error);
    commitServed(c, pending, resolution, result);
    const response = piMessageToResponseObject({ id: responseId, model: body.model, instructions, message: result.message });
    logOk(pending, start, 200, JSON.stringify(response), piUsageToTokenUsage(result.message.usage));
    return c.json(response, 200);
  }

  const result = await streamWithFailover(resolution.targets, request, (events) =>
    createResponsesStream(events, responseId, body.model, instructions)
  );
  if (!result.ok) return targetErrorResponse(c, pending, start, rawBody, result.error);
  commitServed(c, pending, resolution, result);
  logWhenDone(pending, start, result.built.done);
  return sseResponse(c, result.built.stream);
});

v1Router.get("/models", async (c) => {
  try {
    const apiKey = getApiKey(c);
    const all = await listCatalogModels();
    const filtered = apiKey.allowedModels ? all.filter((m) => apiKey.allowedModels!.includes(m.id)) : all;
    const aliases = apiKey.allowedModels
      ? listAliases().filter((a) => apiKey.allowedModels!.includes(a.alias))
      : listAliases();

    const response: ModelListResponse = {
      object: "list",
      data: [
        ...filtered.map((m) => ({
          id: m.id,
          object: "model" as const,
          created: 0,
          owned_by: m.providerID,
          ...(m.variants && m.variants.length > 0 ? { variants: m.variants } : {}),
        })),
        ...aliases.map((a) => ({
          id: a.alias,
          object: "model" as const,
          created: 0,
          owned_by: "alias",
        })),
      ],
    };
    return c.json(response, 200);
  } catch {
    return c.json(openAIError("Failed to list models", "api_error"), 502);
  }
});
