import { Hono, type Context } from "hono";
import { apiKeyAuth, getApiKey, type ApiKeyAuthEnv } from "../auth/apiKeyAuth";
import { listCatalogModels, type ModelSummary } from "../catalog";
import { findAliasByName, listAliases } from "../db/modelAliases";
import { insertRequestLog } from "../db/requests";
import { piMessageToResponseObject, responsesFormat, responsesInputToMessages } from "../openai/responsesTranslate";
import { createResponsesStream } from "../openai/responsesStream";
import type { ResponseCreateParams } from "../openai/responsesTypes";
import { InvalidModelError, parseModelId } from "../openai/translate";
import { openAIError, type ChatCompletionRequest, type ModelListResponse } from "../openai/types";
import type { TokenUsage } from "../openai/usage";
import { createPiChatStream, piMessageToOpenAIResponse, piUsageToTokenUsage, type FirstOutcome, type StreamDoneResult } from "../piai/chat";
import { piComplete, piStartStream, type PiRunRequest } from "../piai/run";
import { defaultReasoningVariant, normalizeReasoningVariant } from "../reasoning";
import type { RequestLogEntry } from "../types";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export const v1Router = new Hono<ApiKeyAuthEnv>();

v1Router.use("*", apiKeyAuth);

interface PendingLog {
  apiKeyId: number | null;
  appName: string;
  model: string;
  variant: string | null;
  stream: boolean;
  requestBody: string | null;
}

type TokenFields = "promptTokens" | "completionTokens" | "totalTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens";

function baseLog(pending: PendingLog, start: number): Omit<RequestLogEntry, "status" | "httpStatus" | "errorMessage" | "responseBody" | TokenFields> {
  return {
    apiKeyId: pending.apiKeyId,
    appName: pending.appName,
    model: pending.model,
    variant: pending.variant,
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

type ModelResolution =
  | { ok: true; targets: ResolvedTarget[] }
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
 * it points to, ignoring `explicitVariant` since an alias's variant is
 * always pinned) and, for a plain model, that it actually offers the
 * requested reasoning variant.
 */
async function resolveRequestedModel(
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
    const orderedTargets = alias.mode === "random" ? shuffled(alias.targets) : alias.targets;
    const targets: ResolvedTarget[] = orderedTargets
      .filter((t) => available.some((m) => m.providerID === t.providerID && m.modelID === t.modelID))
      .map((t) => ({ providerID: t.providerID, modelID: t.modelID, variant: t.variant }));
    if (targets.length === 0) {
      return {
        ok: false,
        status: 502,
        message: `Alias "${requestedModel}" has no currently-available target model`,
        type: "api_error",
      };
    }
    return { ok: true, targets };
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
    // No level requested -> as little reasoning as the model allows (see
    // defaultReasoningVariant). "none"/"off" on a model without any
    // reasoning levels is trivially satisfied, so it's dropped.
    let variant = normalizeReasoningVariant(requestedVariant, matched.variants);
    if (variant === undefined) {
      variant = defaultReasoningVariant(matched.variants);
    } else if ((variant === "none" || variant === "off") && !matched.variants?.length) {
      variant = undefined;
    }
    const knownVariants = matched.variants ?? [];
    if (variant && !knownVariants.includes(variant)) {
      return {
        ok: false,
        status: 400,
        message: `Variant "${variant}" is not available for model "${requestedId}". Available variants: ${knownVariants.join(", ") || "(this model has no reasoning levels)"}`,
        type: "invalid_request_error",
        code: "variant_not_found",
      };
    }
    return { ok: true, targets: [{ providerID, modelID, variant }] };
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
 * next on any failure (provider error, unavailable model, timeout).
 * Returns the first success, or the last failure's message.
 */
async function completeWithFailover(
  targets: ResolvedTarget[],
  request: PiRunRequest
): Promise<{ ok: true; target: ResolvedTarget; message: AssistantMessage } | { ok: false; message: string }> {
  let lastMessage = "No target model available";
  for (const target of targets) {
    const attempt = await piComplete(target, request, FAILOVER_TIMEOUT_MS);
    if (attempt.ok) return { ok: true, target, message: attempt.message };
    lastMessage = attempt.message;
  }
  return { ok: false, message: lastMessage };
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
): Promise<{ ok: true; target: ResolvedTarget; built: TStream } | { ok: false; message: string }> {
  let lastMessage = "No target model available";
  for (const target of targets) {
    const attempt = await piStartStream(target, request, build, FAILOVER_TIMEOUT_MS);
    if (attempt.ok) return { ok: true, target, built: attempt.built };
    lastMessage = attempt.message;
  }
  return { ok: false, message: lastMessage };
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

function commitTarget(pending: PendingLog, target: ResolvedTarget): void {
  pending.model = `${target.providerID}/${target.modelID}`;
  pending.variant = target.variant ?? null;
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
  if (resolution.targets.length === 1) pending.variant = resolution.targets[0].variant ?? null;

  const request: PiRunRequest = { messages: body.messages, responseFormat: body.response_format };

  if (!body.stream) {
    const result = await completeWithFailover(resolution.targets, request);
    if (!result.ok) {
      logError(pending, start, 502, result.message, rawBody);
      return c.json(openAIError(result.message, "api_error"), 502);
    }
    commitTarget(pending, result.target);
    const response = piMessageToOpenAIResponse(body.model, result.message);
    logOk(pending, start, 200, JSON.stringify(response), piUsageToTokenUsage(result.message.usage));
    return c.json(response, 200);
  }

  const includeUsage = body.stream_options?.include_usage === true;
  const result = await streamWithFailover(resolution.targets, request, (events) =>
    createPiChatStream(events, body.model, { includeUsage })
  );
  if (!result.ok) {
    logError(pending, start, 502, result.message, rawBody);
    return c.json(openAIError(result.message, "api_error"), 502);
  }
  commitTarget(pending, result.target);
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
  if (resolution.targets.length === 1) pending.variant = resolution.targets[0].variant ?? null;

  const instructions = typeof body.instructions === "string" ? body.instructions : null;
  const request: PiRunRequest = {
    messages: responsesInputToMessages(body.input, instructions ?? undefined),
    responseFormat: responsesFormat(body.text),
  };
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;

  if (!body.stream) {
    const result = await completeWithFailover(resolution.targets, request);
    if (!result.ok) {
      logError(pending, start, 502, result.message, rawBody);
      return c.json(openAIError(result.message, "api_error"), 502);
    }
    commitTarget(pending, result.target);
    const response = piMessageToResponseObject({ id: responseId, model: body.model, instructions, message: result.message });
    logOk(pending, start, 200, JSON.stringify(response), piUsageToTokenUsage(result.message.usage));
    return c.json(response, 200);
  }

  const result = await streamWithFailover(resolution.targets, request, (events) =>
    createResponsesStream(events, responseId, body.model, instructions)
  );
  if (!result.ok) {
    logError(pending, start, 502, result.message, rawBody);
    return c.json(openAIError(result.message, "api_error"), 502);
  }
  commitTarget(pending, result.target);
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
