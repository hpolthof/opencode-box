import { Hono } from "hono";
import { apiKeyAuth, getApiKey, type ApiKeyAuthEnv } from "../auth/apiKeyAuth";
import { findAliasByName, listAliases } from "../db/modelAliases";
import { insertRequestLog } from "../db/requests";
import {
  createSession,
  deleteSession,
  listModels,
  NO_TOOLS,
  sendMessage,
  sendPromptAsync,
  subscribeEvents,
  type SendMessageBody,
} from "../opencode/client";
import {
  assistantMessageToOpenAIResponse,
  buildOpenCodeFormat,
  extractErrorMessage,
  InvalidModelError,
  messagesToOpenCodePrompt,
  parseModelId,
} from "../openai/translate";
import { createOpenAIChatStream, type FirstOutcome, type OpenAIChatStream } from "../openai/stream";
import { openAIError, type ChatCompletionRequest, type ModelListResponse } from "../openai/types";
import { buildResponseObject, buildResponsesFormat, parseResponsesInput } from "../openai/responsesTranslate";
import { createResponsesStream, type ResponsesStream } from "../openai/responsesStream";
import type { ResponseCreateParams } from "../openai/responsesTypes";
import type { ModelSummary, OpenCodeEvent, SessionPromptResponse } from "../opencode/client";
import type { RequestLogEntry } from "../types";

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

function baseLog(pending: PendingLog, start: number): Omit<RequestLogEntry, "status" | "httpStatus" | "errorMessage" | "responseBody" | "promptTokens" | "completionTokens" | "totalTokens"> {
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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
) {
  insertRequestLog({
    ...baseLog(pending, start),
    status: "ok",
    httpStatus,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
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
 * in turn (see `sendWithFailover`/`attemptStreamingTarget` below) - a plain
 * model resolves to exactly one; an alias resolves to its configured
 * targets, ordered by `position` for `mode: "priority"` or shuffled fresh
 * for `mode: "random"`, with any target whose underlying model is no longer
 * available from OpenCode filtered out up front. Either way this confirms
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
      available = await listModels();
    } catch {
      return { ok: false, status: 502, message: "Failed to look up available models from OpenCode", type: "api_error" };
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
  const variant = explicitVariant ?? variantFromModel;
  const requestedId = `${providerID}/${modelID}`;

  try {
    const available = await listModels();
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
    if (variant && matched.variants && !matched.variants.includes(variant)) {
      return {
        ok: false,
        status: 400,
        message: `Variant "${variant}" is not available for model "${requestedId}". Available variants: ${matched.variants.join(", ")}`,
        type: "invalid_request_error",
        code: "variant_not_found",
      };
    }
    return { ok: true, targets: [{ providerID, modelID, variant }] };
  } catch {
    return { ok: false, status: 502, message: "Failed to look up available models from OpenCode", type: "api_error" };
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

function abortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function delayedOutcome(ms: number, message: string): { promise: Promise<{ ok: false; message: string }>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<{ ok: false; message: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, message }), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

interface NonStreamingAttempt {
  target: ResolvedTarget;
  sessionId: string;
  result: SessionPromptResponse;
}

/**
 * Tries each target in order for a non-streaming request, moving on to the
 * next on an OpenCode-reported error, a thrown/network error, or a timeout
 * (treated as "non-responsive"). Returns the first success, or the last
 * failure's message if every target failed.
 */
async function sendWithFailover(
  targets: ResolvedTarget[],
  buildBody: (target: ResolvedTarget) => Omit<SendMessageBody, "model" | "variant">
): Promise<{ ok: true; attempt: NonStreamingAttempt } | { ok: false; message: string }> {
  let lastMessage = "No target model available";
  for (const target of targets) {
    let sessionId: string;
    try {
      sessionId = (await createSession("gateway request")).id;
    } catch {
      lastMessage = "Failed to create OpenCode session";
      continue;
    }

    const { signal, cancel } = abortAfter(FAILOVER_TIMEOUT_MS);
    try {
      const result = await sendMessage(
        sessionId,
        { ...buildBody(target), model: { providerID: target.providerID, modelID: target.modelID }, variant: target.variant },
        signal
      );
      cancel();
      if (result.info.error) {
        lastMessage = extractErrorMessage(result.info.error);
        deleteSession(sessionId);
        continue;
      }
      return { ok: true, attempt: { target, sessionId, result } };
    } catch (err) {
      cancel();
      lastMessage =
        err instanceof Error && err.name === "AbortError"
          ? `Model "${target.providerID}/${target.modelID}" did not respond in time`
          : err instanceof Error
            ? err.message
            : "Unexpected error calling OpenCode";
      deleteSession(sessionId);
    }
  }
  return { ok: false, message: lastMessage };
}

interface StreamingAttempt<TStream extends { firstOutcome: Promise<FirstOutcome> }> {
  target: ResolvedTarget;
  sessionId: string;
  abortController: AbortController;
  built: TStream;
}

/**
 * Starts a streaming attempt against one target and waits only for its
 * `firstOutcome` (first content emitted, or a failure/timeout before any
 * content) - never for the full response. Nothing reaches the real HTTP
 * client from this attempt until the caller decides to commit to it (by
 * returning `attempt.built.stream` from the route), so a failure here can
 * still safely fail over to the next target. Once content has started
 * flowing for a committed attempt, this function is no longer in the
 * picture - the stream just runs to completion (or fails) on its own, same
 * as before this feature existed.
 */
async function attemptStreamingTarget<TStream extends { firstOutcome: Promise<FirstOutcome> }>(
  target: ResolvedTarget,
  buildBody: (target: ResolvedTarget) => Omit<SendMessageBody, "model" | "variant">,
  buildStream: (events: AsyncIterable<OpenCodeEvent>, sessionId: string) => TStream
): Promise<{ ok: true; attempt: StreamingAttempt<TStream> } | { ok: false; message: string }> {
  let sessionId: string;
  try {
    sessionId = (await createSession("gateway request")).id;
  } catch {
    return { ok: false, message: "Failed to create OpenCode session" };
  }

  const { signal, cancel } = abortAfter(FAILOVER_TIMEOUT_MS);
  try {
    await sendPromptAsync(
      sessionId,
      { ...buildBody(target), model: { providerID: target.providerID, modelID: target.modelID }, variant: target.variant },
      signal
    );
    cancel();
  } catch (err) {
    cancel();
    deleteSession(sessionId);
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `Model "${target.providerID}/${target.modelID}" did not respond in time`
        : err instanceof Error
          ? err.message
          : "Failed to start OpenCode prompt";
    return { ok: false, message };
  }

  const abortController = new AbortController();
  const events = subscribeEvents(abortController.signal);
  const built = buildStream(events, sessionId);

  const { promise: watchdog, cancel: cancelWatchdog } = delayedOutcome(
    FAILOVER_TIMEOUT_MS,
    `Model "${target.providerID}/${target.modelID}" did not respond in time`
  );
  const outcome = await Promise.race([built.firstOutcome, watchdog]);
  cancelWatchdog();

  if (outcome.ok) {
    return { ok: true, attempt: { target, sessionId, abortController, built } };
  }
  abortController.abort();
  deleteSession(sessionId);
  return { ok: false, message: outcome.message };
}

v1Router.post("/chat/completions", async (c) => {
  const start = Date.now();
  const apiKey = getApiKey(c);

  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch (err) {
    const message = "Failed to read request body";
    logError({ apiKeyId: apiKey.id, appName: apiKey.name, model: "unknown", variant: null, stream: false, requestBody: null }, start, 400, message);
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(rawBody) as ChatCompletionRequest;
  } catch {
    const message = "Request body must be valid JSON";
    logError(
      { apiKeyId: apiKey.id, appName: apiKey.name, model: "unknown", variant: null, stream: false, requestBody: rawBody },
      start,
      400,
      message,
      rawBody
    );
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

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
  const { system, text } = messagesToOpenCodePrompt(body.messages);
  const format = buildOpenCodeFormat(body.response_format);
  const buildBody = (): Omit<SendMessageBody, "model" | "variant"> => ({
    system,
    parts: [{ type: "text", text }],
    format,
    tools: NO_TOOLS,
  });

  if (!body.stream) {
    const attempt = await sendWithFailover(resolution.targets, buildBody);
    if (!attempt.ok) {
      logError(pending, start, 502, attempt.message, rawBody);
      return c.json(openAIError(attempt.message, "api_error"), 502);
    }
    const { target, sessionId, result } = attempt.attempt;
    // Best-effort cleanup - don't make the caller wait on it, it has
    // nothing to do with whether their answer is ready.
    deleteSession(sessionId);
    pending.model = `${target.providerID}/${target.modelID}`;
    pending.variant = target.variant ?? null;

    const response = assistantMessageToOpenAIResponse(body.model, result.info, result.parts);
    const responseBody = JSON.stringify(response);
    logOk(pending, start, 200, responseBody, response.usage);
    return c.json(response, 200);
  }

  // Streaming path: try each target in turn, but only for getting the
  // response off the ground - see attemptStreamingTarget's docstring.
  let lastMessage = "No target model available";
  let selected: StreamingAttempt<OpenAIChatStream> | null = null;
  for (const target of resolution.targets) {
    const attempt = await attemptStreamingTarget(target, buildBody, (events, sessionId) =>
      createOpenAIChatStream(events, sessionId, body.model)
    );
    if (attempt.ok) {
      selected = attempt.attempt;
      break;
    }
    lastMessage = attempt.message;
  }

  if (!selected) {
    logError(pending, start, 502, lastMessage, rawBody);
    return c.json(openAIError(lastMessage, "api_error"), 502);
  }

  const { target: selectedTarget, sessionId: selectedSessionId, abortController: selectedAbort, built } = selected;
  pending.model = `${selectedTarget.providerID}/${selectedTarget.modelID}`;
  pending.variant = selectedTarget.variant ?? null;

  built.done
    .then((result) => {
      selectedAbort.abort();
      if (result.errorMessage) {
        logError(pending, start, 200, result.errorMessage, result.fullText);
      } else {
        logOk(pending, start, 200, result.fullText, result.usage);
      }
    })
    .catch((err) => {
      console.error("[routes/v1] streaming done handler failed:", err);
    })
    .finally(() => {
      deleteSession(selectedSessionId);
    });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.newResponse(built.stream);
});

v1Router.post("/responses", async (c) => {
  const start = Date.now();
  const apiKey = getApiKey(c);

  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    const message = "Failed to read request body";
    logError({ apiKeyId: apiKey.id, appName: apiKey.name, model: "unknown", variant: null, stream: false, requestBody: null }, start, 400, message);
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

  let body: ResponseCreateParams;
  try {
    body = JSON.parse(rawBody) as ResponseCreateParams;
  } catch {
    const message = "Request body must be valid JSON";
    logError(
      { apiKeyId: apiKey.id, appName: apiKey.name, model: "unknown", variant: null, stream: false, requestBody: rawBody },
      start,
      400,
      message,
      rawBody
    );
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

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
    const message = "`previous_response_id` is not supported - this gateway is stateless, so every call starts a fresh session";
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
  const { system, text } = parseResponsesInput(body.input, body.instructions);
  const format = buildResponsesFormat(body.text);
  const instructions = typeof body.instructions === "string" ? body.instructions : null;
  const buildBody = (): Omit<SendMessageBody, "model" | "variant"> => ({
    system,
    parts: [{ type: "text", text }],
    format,
    tools: NO_TOOLS,
  });

  if (!body.stream) {
    const attempt = await sendWithFailover(resolution.targets, buildBody);
    if (!attempt.ok) {
      logError(pending, start, 502, attempt.message, rawBody);
      return c.json(openAIError(attempt.message, "api_error"), 502);
    }
    const { target, sessionId, result } = attempt.attempt;
    // Best-effort cleanup - don't make the caller wait on it, it has
    // nothing to do with whether their answer is ready.
    deleteSession(sessionId);
    pending.model = `${target.providerID}/${target.modelID}`;
    pending.variant = target.variant ?? null;

    const response = buildResponseObject({ id: `resp_${result.info.id}`, model: body.model, instructions, info: result.info, parts: result.parts });
    const responseBody = JSON.stringify(response);
    logOk(
      pending,
      start,
      200,
      responseBody,
      response.usage
        ? { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens, total_tokens: response.usage.total_tokens }
        : undefined
    );
    return c.json(response, 200);
  }

  // Streaming path: try each target in turn, but only for getting the
  // response off the ground - see attemptStreamingTarget's docstring.
  let lastMessage = "No target model available";
  let selected: StreamingAttempt<ResponsesStream> | null = null;
  for (const target of resolution.targets) {
    const attempt = await attemptStreamingTarget(target, buildBody, (events, sessionId) =>
      createResponsesStream(events, sessionId, `resp_${sessionId}`, body.model, instructions)
    );
    if (attempt.ok) {
      selected = attempt.attempt;
      break;
    }
    lastMessage = attempt.message;
  }

  if (!selected) {
    logError(pending, start, 502, lastMessage, rawBody);
    return c.json(openAIError(lastMessage, "api_error"), 502);
  }

  const { target: selectedTarget, sessionId: selectedSessionId, abortController: selectedAbort, built } = selected;
  pending.model = `${selectedTarget.providerID}/${selectedTarget.modelID}`;
  pending.variant = selectedTarget.variant ?? null;

  built.done
    .then((result) => {
      selectedAbort.abort();
      if (result.errorMessage) {
        logError(pending, start, 200, result.errorMessage, result.fullText);
      } else {
        logOk(
          pending,
          start,
          200,
          result.fullText,
          result.usage
            ? { prompt_tokens: result.usage.input_tokens, completion_tokens: result.usage.output_tokens, total_tokens: result.usage.total_tokens }
            : undefined
        );
      }
    })
    .catch((err) => {
      console.error("[routes/v1] responses streaming done handler failed:", err);
    })
    .finally(() => {
      deleteSession(selectedSessionId);
    });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.newResponse(built.stream);
});

v1Router.get("/models", async (c) => {
  try {
    const apiKey = getApiKey(c);
    const all = await listModels();
    const filtered = apiKey.allowedModels
      ? all.filter((m) => apiKey.allowedModels!.includes(m.id))
      : all;

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
          owned_by: "opencode",
          ...(m.variants && m.variants.length > 0 ? { variants: m.variants } : {}),
        })),
        ...aliases.map((a) => ({
          id: a.alias,
          object: "model" as const,
          created: 0,
          owned_by: "opencode",
        })),
      ],
    };
    return c.json(response, 200);
  } catch (err) {
    const message = "Failed to list models from OpenCode";
    return c.json(openAIError(message, "api_error"), 502);
  }
});
