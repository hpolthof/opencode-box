import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { listCatalogModels } from "../../catalog";
import { insertRequestLog } from "../../db/requests";
import { parseModelId } from "../../openai/translate";
import type { ChatMessage, ResponseFormat } from "../../openai/types";
import type { TokenUsage } from "../../openai/usage";
import { assistantText, piUsageToTokenUsage } from "../../piai/chat";
import { piComplete, piOpenStream } from "../../piai/run";
import { defaultReasoningVariant, normalizeReasoningVariant } from "../../reasoning";
import { Playground } from "../../views/playground";

export const playgroundRouter = new Hono();

playgroundRouter.get("/playground", async (c) => {
  try {
    const models = await listCatalogModels();
    return c.html(Playground({ models }) as string);
  } catch {
    return c.html(Playground({ unreachable: true }) as string);
  }
});

interface RunBody {
  model?: unknown;
  system?: unknown;
  prompt?: unknown;
  variant?: unknown;
  stream?: unknown;
  responseFormat?: unknown;
}

function logRun(
  start: number,
  model: string,
  variant: string | null,
  stream: boolean,
  requestBody: string,
  outcome:
    | { status: "ok"; httpStatus: number; responseBody: string; usage?: TokenUsage | null }
    | { status: "error"; httpStatus: number; errorMessage: string; responseBody?: string | null }
) {
  insertRequestLog({
    apiKeyId: null,
    appName: "playground",
    model,
    variant,
    stream,
    requestBody,
    latencyMs: Date.now() - start,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    promptTokens: outcome.status === "ok" ? (outcome.usage?.promptTokens ?? null) : null,
    completionTokens: outcome.status === "ok" ? (outcome.usage?.completionTokens ?? null) : null,
    totalTokens: outcome.status === "ok" ? (outcome.usage?.totalTokens ?? null) : null,
    reasoningTokens: outcome.status === "ok" ? (outcome.usage?.reasoningTokens ?? null) : null,
    cacheReadTokens: outcome.status === "ok" ? (outcome.usage?.cacheReadTokens ?? null) : null,
    cacheWriteTokens: outcome.status === "ok" ? (outcome.usage?.cacheWriteTokens ?? null) : null,
    errorMessage: outcome.status === "error" ? outcome.errorMessage : null,
    responseBody: outcome.status === "ok" ? outcome.responseBody : (outcome.responseBody ?? null),
  });
}

playgroundRouter.post("/playground/run", async (c) => {
  const start = Date.now();

  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.json({ error: "Failed to read request body" }, 400);
  }

  let body: RunBody;
  try {
    body = JSON.parse(rawBody) as RunBody;
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return c.json({ error: "Request must include a non-empty string `prompt`" }, 400);
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return c.json({ error: "Request must include a string `model`" }, 400);
  }
  const modelString = body.model;
  const system = typeof body.system === "string" && body.system.length > 0 ? body.system : undefined;
  const requestedVariant = typeof body.variant === "string" && body.variant.length > 0 ? body.variant : undefined;
  let variant: string | undefined;
  const stream = body.stream === true;

  let responseFormat: ResponseFormat | undefined;
  if (body.responseFormat !== undefined && body.responseFormat !== null) {
    const rf = body.responseFormat as { type?: unknown; schema?: unknown };
    if (rf.type === "json_schema") {
      if (typeof rf.schema !== "object" || rf.schema === null) {
        return c.json({ error: "`responseFormat.schema` must be an object when type is \"json_schema\"" }, 400);
      }
      responseFormat = { type: "json_schema", json_schema: { schema: rf.schema } };
    } else if (rf.type !== "text" && rf.type !== undefined) {
      return c.json({ error: '`responseFormat.type` must be "json_schema" or "text"' }, 400);
    }
  }

  let providerID: string;
  let modelID: string;
  try {
    ({ providerID, modelID } = parseModelId(modelString));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid model id";
    return c.json({ error: message }, 400);
  }

  const requestedId = `${providerID}/${modelID}`;
  try {
    const available = await listCatalogModels();
    const matched = available.find((m) => m.id === requestedId);
    if (!matched) {
      return c.json({ error: `Model "${requestedId}" is not available on this gateway` }, 404);
    }
    // Same rule as /v1: no level chosen -> as little reasoning as the model allows.
    variant = normalizeReasoningVariant(requestedVariant, matched.variants) ?? defaultReasoningVariant(matched.variants);
    if (variant && matched.variants && !matched.variants.includes(variant)) {
      return c.json(
        { error: `Variant "${variant}" is not available for model "${requestedId}". Available variants: ${matched.variants.join(", ")}` },
        400
      );
    }
  } catch {
    return c.json({ error: "Failed to look up available models" }, 502);
  }

  return runModel(c, { start, rawBody, modelString, providerID, modelID, variant, stream, system, prompt: body.prompt, responseFormat });
});

const PI_PLAYGROUND_TIMEOUT_MS = 120_000;

/** JSON-schema answers come back as text; also hand them back parsed as `structured`. */
function parseStructured(content: string, responseFormat: ResponseFormat | undefined): unknown {
  if (responseFormat?.type !== "json_schema") return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function runModel(
  c: Context,
  run: {
    start: number;
    rawBody: string;
    modelString: string;
    providerID: string;
    modelID: string;
    variant: string | undefined;
    stream: boolean;
    system: string | undefined;
    prompt: string;
    responseFormat: ResponseFormat | undefined;
  }
) {
  const { start, rawBody, modelString, variant, stream } = run;
  const target = { providerID: run.providerID, modelID: run.modelID, variant };
  const messages: ChatMessage[] = [
    ...(run.system ? [{ role: "system" as const, content: run.system }] : []),
    { role: "user", content: run.prompt },
  ];
  const request = { messages, responseFormat: run.responseFormat };

  if (!stream) {
    const result = await piComplete(target, request, PI_PLAYGROUND_TIMEOUT_MS);
    if (!result.ok) {
      const { status, message } = result.error;
      logRun(start, modelString, variant ?? null, false, rawBody, { status: "error", httpStatus: status, errorMessage: message });
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
    const content = assistantText(result.message);
    const usage = piUsageToTokenUsage(result.message.usage);
    const responsePayload = { content, structured: parseStructured(content, run.responseFormat), usage, latencyMs: Date.now() - start };
    logRun(start, modelString, variant ?? null, false, rawBody, { status: "ok", httpStatus: 200, responseBody: JSON.stringify(responsePayload), usage });
    return c.json(responsePayload, 200);
  }

  const opened = await piOpenStream(target, request);
  if (!opened.ok) {
    const { status, message } = opened.error;
    logRun(start, modelString, variant ?? null, true, rawBody, { status: "error", httpStatus: status, errorMessage: message });
    return c.json({ error: message }, status as ContentfulStatusCode);
  }
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = "";
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const fail = (message: string) => {
        send({ type: "error", message });
        controller.close();
        logRun(start, modelString, variant ?? null, true, rawBody, { status: "error", httpStatus: 200, errorMessage: message, responseBody: fullText || null });
      };
      try {
        for await (const event of opened.events) {
          if (event.type === "text_delta") {
            fullText += event.delta;
            send({ type: "delta", text: event.delta });
          } else if (event.type === "done") {
            const usage = piUsageToTokenUsage(event.message.usage);
            const donePayload = { type: "done", content: fullText, structured: parseStructured(fullText, run.responseFormat), usage, latencyMs: Date.now() - start };
            send(donePayload);
            controller.close();
            logRun(start, modelString, variant ?? null, true, rawBody, { status: "ok", httpStatus: 200, responseBody: JSON.stringify(donePayload), usage });
            return;
          } else if (event.type === "error") {
            return fail(event.error.errorMessage ?? `Request ${event.reason}`);
          }
        }
        fail("Stream ended without a result");
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.newResponse(readable);
}
