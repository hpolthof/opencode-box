import { Hono } from "hono";
import { apiKeyAuth, getApiKey, type ApiKeyAuthEnv } from "../auth/apiKeyAuth";
import { insertRequestLog } from "../db/requests";
import {
  createSession,
  deleteSession,
  listModels,
  NO_TOOLS,
  sendMessage,
  sendPromptAsync,
  subscribeEvents,
} from "../opencode/client";
import {
  assistantMessageToOpenAIResponse,
  buildOpenCodeFormat,
  extractErrorMessage,
  InvalidModelError,
  messagesToOpenCodePrompt,
  parseModelId,
} from "../openai/translate";
import { createOpenAIChatStream } from "../openai/stream";
import { openAIError, type ChatCompletionRequest, type ModelListResponse } from "../openai/types";
import { buildResponseObject, buildResponsesFormat, parseResponsesInput } from "../openai/responsesTranslate";
import { createResponsesStream } from "../openai/responsesStream";
import type { ResponseCreateParams } from "../openai/responsesTypes";
import type { ModelSummary } from "../opencode/client";
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

type ModelResolution =
  | { ok: true; matched: ModelSummary }
  | { ok: false; status: 400 | 403 | 404 | 502; message: string; type: "invalid_request_error" | "api_error"; code?: string };

/**
 * Shared by /chat/completions and /responses: confirms `requestedId` exists
 * on this gateway, is allowed for the calling key, and - if a reasoning
 * variant was requested - that the model actually offers it.
 */
async function resolveModelAndVariant(
  requestedId: string,
  variant: string | undefined,
  allowedModels: string[] | null
): Promise<ModelResolution> {
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
    return { ok: true, matched };
  } catch {
    return { ok: false, status: 502, message: "Failed to look up available models from OpenCode", type: "api_error" };
  }
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

  let providerID: string;
  let modelID: string;
  let variantFromModel: string | undefined;
  try {
    ({ providerID, modelID, variant: variantFromModel } = parseModelId(body.model));
  } catch (err) {
    const message = err instanceof InvalidModelError ? err.message : "Invalid model id";
    logError(pending, start, 400, message, rawBody);
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

  const variant =
    typeof body.reasoning_effort === "string" && body.reasoning_effort.length > 0
      ? body.reasoning_effort
      : variantFromModel;
  pending.variant = variant ?? null;

  const requestedId = `${providerID}/${modelID}`;
  const resolution = await resolveModelAndVariant(requestedId, variant, apiKey.allowedModels);
  if (!resolution.ok) {
    logError(pending, start, resolution.status, resolution.message, rawBody);
    return c.json(openAIError(resolution.message, resolution.type, resolution.code), resolution.status);
  }

  const { system, text } = messagesToOpenCodePrompt(body.messages);
  const format = buildOpenCodeFormat(body.response_format);

  let sessionId: string;
  try {
    const session = await createSession("gateway request");
    sessionId = session.id;
  } catch (err) {
    const message = "Failed to create OpenCode session";
    logError(pending, start, 502, message, rawBody);
    return c.json(openAIError(message, "api_error"), 502);
  }

  if (!body.stream) {
    try {
      const result = await sendMessage(sessionId, {
        system,
        model: { providerID, modelID },
        parts: [{ type: "text", text }],
        format,
        variant,
        tools: NO_TOOLS,
      });
      // Best-effort cleanup - don't make the caller wait on it, it has
      // nothing to do with whether their answer is ready.
      deleteSession(sessionId);

      if (result.info.error) {
        const message = extractErrorMessage(result.info.error);
        logError(pending, start, 502, message, JSON.stringify(result));
        return c.json(openAIError(message, "api_error"), 502);
      }

      const response = assistantMessageToOpenAIResponse(body.model, result.info, result.parts);
      const responseBody = JSON.stringify(response);
      logOk(pending, start, 200, responseBody, response.usage);
      return c.json(response, 200);
    } catch (err) {
      deleteSession(sessionId);
      const message = err instanceof Error ? err.message : "Unexpected error calling OpenCode";
      logError(pending, start, 502, message);
      return c.json(openAIError(message, "api_error"), 502);
    }
  }

  // Streaming path.
  try {
    await sendPromptAsync(sessionId, {
      system,
      model: { providerID, modelID },
      parts: [{ type: "text", text }],
      format,
      variant,
      tools: NO_TOOLS,
    });
  } catch (err) {
    await deleteSession(sessionId);
    const message = err instanceof Error ? err.message : "Failed to start OpenCode prompt";
    logError(pending, start, 502, message);
    return c.json(openAIError(message, "api_error"), 502);
  }

  const abortController = new AbortController();
  const events = subscribeEvents(abortController.signal);
  const { stream, done } = createOpenAIChatStream(events, sessionId, body.model);

  done
    .then((result) => {
      abortController.abort();
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
      deleteSession(sessionId);
    });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.newResponse(stream);
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

  let providerID: string;
  let modelID: string;
  let variantFromModel: string | undefined;
  try {
    ({ providerID, modelID, variant: variantFromModel } = parseModelId(body.model));
  } catch (err) {
    const message = err instanceof InvalidModelError ? err.message : "Invalid model id";
    logError(pending, start, 400, message, rawBody);
    return c.json(openAIError(message, "invalid_request_error"), 400);
  }

  const variant =
    typeof body.reasoning?.effort === "string" && body.reasoning.effort.length > 0 ? body.reasoning.effort : variantFromModel;
  pending.variant = variant ?? null;

  const requestedId = `${providerID}/${modelID}`;
  const resolution = await resolveModelAndVariant(requestedId, variant, apiKey.allowedModels);
  if (!resolution.ok) {
    logError(pending, start, resolution.status, resolution.message, rawBody);
    return c.json(openAIError(resolution.message, resolution.type, resolution.code), resolution.status);
  }

  const { system, text } = parseResponsesInput(body.input, body.instructions);
  const format = buildResponsesFormat(body.text);
  const instructions = typeof body.instructions === "string" ? body.instructions : null;

  let sessionId: string;
  try {
    const session = await createSession("gateway request");
    sessionId = session.id;
  } catch {
    const message = "Failed to create OpenCode session";
    logError(pending, start, 502, message, rawBody);
    return c.json(openAIError(message, "api_error"), 502);
  }

  if (!body.stream) {
    try {
      const result = await sendMessage(sessionId, {
        system,
        model: { providerID, modelID },
        parts: [{ type: "text", text }],
        format,
        variant,
        tools: NO_TOOLS,
      });
      // Best-effort cleanup - don't make the caller wait on it, it has
      // nothing to do with whether their answer is ready.
      deleteSession(sessionId);

      if (result.info.error) {
        const message = extractErrorMessage(result.info.error);
        logError(pending, start, 502, message, JSON.stringify(result));
        return c.json(openAIError(message, "api_error"), 502);
      }

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
    } catch (err) {
      deleteSession(sessionId);
      const message = err instanceof Error ? err.message : "Unexpected error calling OpenCode";
      logError(pending, start, 502, message);
      return c.json(openAIError(message, "api_error"), 502);
    }
  }

  // Streaming path.
  try {
    await sendPromptAsync(sessionId, {
      system,
      model: { providerID, modelID },
      parts: [{ type: "text", text }],
      format,
      variant,
      tools: NO_TOOLS,
    });
  } catch (err) {
    await deleteSession(sessionId);
    const message = err instanceof Error ? err.message : "Failed to start OpenCode prompt";
    logError(pending, start, 502, message);
    return c.json(openAIError(message, "api_error"), 502);
  }

  const abortController = new AbortController();
  const events = subscribeEvents(abortController.signal);
  const responseId = `resp_${sessionId}`;
  const { stream, done } = createResponsesStream(events, sessionId, responseId, body.model, instructions);

  done
    .then((result) => {
      abortController.abort();
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
      deleteSession(sessionId);
    });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.newResponse(stream);
});

v1Router.get("/models", async (c) => {
  try {
    const apiKey = getApiKey(c);
    const all = await listModels();
    const filtered = apiKey.allowedModels
      ? all.filter((m) => apiKey.allowedModels!.includes(m.id))
      : all;

    const response: ModelListResponse = {
      object: "list",
      data: filtered.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: "opencode",
        ...(m.variants && m.variants.length > 0 ? { variants: m.variants } : {}),
      })),
    };
    return c.json(response, 200);
  } catch (err) {
    const message = "Failed to list models from OpenCode";
    return c.json(openAIError(message, "api_error"), 502);
  }
});
