import { Hono } from "hono";
import { insertRequestLog } from "../../db/requests";
import { createSession, deleteSession, listModels, NO_TOOLS, sendMessage, sendPromptAsync, subscribeEvents } from "../../opencode/client";
import { buildOpenCodeFormat, extractErrorMessage, extractText, parseModelId } from "../../openai/translate";
import { isMessagePartUpdated, isMessageUpdated, isTextPart } from "../../opencode/types";
import { Playground } from "../../views/playground";

export const playgroundRouter = new Hono();

playgroundRouter.get("/playground", async (c) => {
  try {
    const models = await listModels();
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
    | { status: "ok"; httpStatus: number; responseBody: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null }
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
  const variant = typeof body.variant === "string" && body.variant.length > 0 ? body.variant : undefined;
  const stream = body.stream === true;

  let format: ReturnType<typeof buildOpenCodeFormat>;
  if (body.responseFormat !== undefined && body.responseFormat !== null) {
    const rf = body.responseFormat as { type?: unknown; schema?: unknown };
    if (rf.type === "json_schema") {
      if (typeof rf.schema !== "object" || rf.schema === null) {
        return c.json({ error: "`responseFormat.schema` must be an object when type is \"json_schema\"" }, 400);
      }
      format = buildOpenCodeFormat({ type: "json_schema", json_schema: { schema: rf.schema } });
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
    const available = await listModels();
    const matched = available.find((m) => m.id === requestedId);
    if (!matched) {
      return c.json({ error: `Model "${requestedId}" is not available on this gateway` }, 404);
    }
    if (variant && matched.variants && !matched.variants.includes(variant)) {
      return c.json(
        { error: `Variant "${variant}" is not available for model "${requestedId}". Available variants: ${matched.variants.join(", ")}` },
        400
      );
    }
  } catch {
    return c.json({ error: "Failed to look up available models from OpenCode" }, 502);
  }

  let sessionId: string;
  try {
    const session = await createSession("playground");
    sessionId = session.id;
  } catch {
    return c.json({ error: "Failed to create OpenCode session" }, 502);
  }

  if (!stream) {
    try {
      const result = await sendMessage(sessionId, {
        system,
        model: { providerID, modelID },
        parts: [{ type: "text", text: body.prompt }],
        format,
        variant,
        tools: NO_TOOLS,
      });
      // Best-effort cleanup - don't make the caller wait on it, it has
      // nothing to do with whether their answer is ready.
      deleteSession(sessionId);

      if (result.info.error) {
        const message = extractErrorMessage(result.info.error);
        logRun(start, modelString, variant ?? null, false, rawBody, { status: "error", httpStatus: 502, errorMessage: message });
        return c.json({ error: message }, 502);
      }

      const content = extractText(result.parts);
      const structured = result.info.structured;
      const usage = result.info.tokens
        ? {
            promptTokens: result.info.tokens.input,
            completionTokens: result.info.tokens.output,
            totalTokens: result.info.tokens.total,
          }
        : null;

      const responsePayload = { content, structured, usage, latencyMs: Date.now() - start };
      logRun(start, modelString, variant ?? null, false, rawBody, { status: "ok", httpStatus: 200, responseBody: JSON.stringify(responsePayload), usage });
      return c.json(responsePayload, 200);
    } catch (err) {
      deleteSession(sessionId);
      const message = err instanceof Error ? err.message : "Unexpected error calling OpenCode";
      logRun(start, modelString, variant ?? null, false, rawBody, { status: "error", httpStatus: 502, errorMessage: message });
      return c.json({ error: message }, 502);
    }
  }

  // Streaming path: forward incremental text deltas as they arrive, then a
  // single terminal "done" or "error" frame.
  try {
    await sendPromptAsync(sessionId, {
      system,
      model: { providerID, modelID },
      parts: [{ type: "text", text: body.prompt }],
      format,
      variant,
      tools: NO_TOOLS,
    });
  } catch (err) {
    await deleteSession(sessionId);
    const message = err instanceof Error ? err.message : "Failed to start OpenCode prompt";
    logRun(start, modelString, variant ?? null, true, rawBody, { status: "error", httpStatus: 502, errorMessage: message });
    return c.json({ error: message }, 502);
  }

  const abortController = new AbortController();
  const events = subscribeEvents(abortController.signal);
  const encoder = new TextEncoder();

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const partLengths = new Map<string, number>();
      let fullText = "";

      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const finish = (outcome: { status: "ok"; responseBody: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null } | { status: "error"; message: string }) => {
        abortController.abort();
        controller.close();
        if (outcome.status === "ok") {
          logRun(start, modelString, variant ?? null, true, rawBody, { status: "ok", httpStatus: 200, responseBody: outcome.responseBody, usage: outcome.usage });
        } else {
          logRun(start, modelString, variant ?? null, true, rawBody, {
            status: "error",
            httpStatus: 200,
            errorMessage: outcome.message,
            responseBody: fullText || null,
          });
        }
        deleteSession(sessionId);
      };

      try {
        for await (const event of events) {
          const sid = (event as { properties?: { sessionID?: string } }).properties?.sessionID;
          if (sid !== sessionId) continue;

          if (isMessagePartUpdated(event)) {
            const part = event.properties.part;
            if (isTextPart(part)) {
              const prevLen = partLengths.get(part.id) ?? 0;
              if (part.text.length > prevLen) {
                const delta = part.text.slice(prevLen);
                partLengths.set(part.id, part.text.length);
                fullText += delta;
                send({ type: "delta", text: delta });
              }
            }
            continue;
          }

          if (isMessageUpdated(event)) {
            const info = event.properties.info;
            if (info.time?.completed != null) {
              if (info.error) {
                const message = extractErrorMessage(info.error);
                send({ type: "error", message });
                finish({ status: "error", message });
                return;
              }
              const usage = info.tokens
                ? { promptTokens: info.tokens.input, completionTokens: info.tokens.output, totalTokens: info.tokens.total }
                : null;
              const donePayload = { type: "done", content: fullText, structured: info.structured ?? null, usage, latencyMs: Date.now() - start };
              send(donePayload);
              finish({ status: "ok", responseBody: JSON.stringify(donePayload), usage });
              return;
            }
            continue;
          }
        }

        // Event feed ended without an explicit completion signal.
        const donePayload = { type: "done", content: fullText, structured: null, usage: null, latencyMs: Date.now() - start };
        send(donePayload);
        finish({ status: "ok", responseBody: JSON.stringify(donePayload), usage: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected error calling OpenCode";
        try {
          send({ type: "error", message });
        } catch {
          // stream may already be closed
        }
        finish({ status: "error", message });
      }
    },
  });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  return c.newResponse(readable);
});
