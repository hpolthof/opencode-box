import { isMessagePartUpdated, isMessageUpdated, isTextPart } from "../opencode/types";
import type { AssistantMessage, OpenCodeEvent, Part } from "../opencode/types";
import { buildResponseObject } from "./responsesTranslate";
import type {
  ResponseContentPartDoneEvent,
  ResponseObject,
  ResponseOutputItemDoneEvent,
  ResponseOutputMessageItem,
  ResponseOutputTextPart,
  ResponseStreamEvent,
  ResponseUsage,
} from "./responsesTypes";

export interface ResponsesStreamDoneResult {
  fullText: string;
  usage: ResponseUsage | null;
  errorMessage?: string;
}

export interface ResponsesStream {
  /** Raw SSE byte stream ready to hand to a Response / c.newResponse. */
  stream: ReadableStream<Uint8Array>;
  /** Resolves once the stream has finished (successfully or on error). */
  done: Promise<ResponsesStreamDoneResult>;
}

/**
 * Consumes OpenCode's global event feed (filtered to `sessionId`) and
 * produces an OpenAI Responses API SSE stream.
 *
 * `message.part.updated` events carry the FULL current text of a part, not
 * a delta - we track the previously-seen length per part id and emit only
 * the newly-appended substring as `response.output_text.delta`.
 *
 * Unlike Chat Completions streaming, the real Responses API does NOT end
 * with a `data: [DONE]` sentinel - the stream just closes after
 * `response.completed` / `response.failed`.
 */
export function createResponsesStream(
  events: AsyncIterable<OpenCodeEvent>,
  sessionId: string,
  responseId: string,
  model: string,
  instructions: string | null
): ResponsesStream {
  const createdAt = Math.floor(Date.now() / 1000);
  const itemId = `msg_${sessionId}`;
  const encoder = new TextEncoder();

  let resolveDone!: (result: ResponsesStreamDoneResult) => void;
  const done = new Promise<ResponsesStreamDoneResult>((resolve) => {
    resolveDone = resolve;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const partLengths = new Map<string, number>();
      let fullText = "";
      let sequenceNumber = 0;

      const send = (event: ResponseStreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      const shellResponse = (): ResponseObject => ({
        id: responseId,
        object: "response",
        created_at: createdAt,
        status: "in_progress",
        model,
        output: [],
        output_text: "",
        usage: null,
        error: null,
        instructions,
      });

      const shellItem = (): ResponseOutputMessageItem => ({
        id: itemId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      });

      const finish = (result: ResponsesStreamDoneResult) => {
        try {
          controller.close();
        } catch {
          // stream may already be closed/errored
        }
        resolveDone(result);
      };

      // --- initial shell events -------------------------------------------
      send({ type: "response.created", response: shellResponse(), sequence_number: sequenceNumber++ });
      send({ type: "response.in_progress", response: shellResponse(), sequence_number: sequenceNumber++ });
      send({ type: "response.output_item.added", output_index: 0, item: shellItem(), sequence_number: sequenceNumber++ });
      const shellPart: ResponseOutputTextPart = { type: "output_text", text: "", annotations: [] };
      send({
        type: "response.content_part.added",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: shellPart,
        sequence_number: sequenceNumber++,
      });

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
                send({
                  type: "response.output_text.delta",
                  item_id: itemId,
                  output_index: 0,
                  content_index: 0,
                  delta,
                  sequence_number: sequenceNumber++,
                });
              }
            }
            continue;
          }

          if (isMessageUpdated(event)) {
            const info: AssistantMessage = event.properties.info;
            if (info.time?.completed == null) continue;

            if (info.error) {
              const response = buildResponseObject({ id: responseId, model, instructions, info, parts: [] });
              send({ type: "response.failed", response, sequence_number: sequenceNumber++ });
              finish({ fullText, usage: null, errorMessage: response.error?.message ?? "OpenCode reported an error" });
              return;
            }

            const finalPart: ResponseOutputTextPart = { type: "output_text", text: fullText, annotations: [] };
            send({
              type: "response.output_text.done",
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              text: fullText,
              sequence_number: sequenceNumber++,
            });
            const contentPartDone: ResponseContentPartDoneEvent = {
              type: "response.content_part.done",
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              part: finalPart,
              sequence_number: sequenceNumber++,
            };
            send(contentPartDone);
            const finalItem: ResponseOutputMessageItem = { id: itemId, type: "message", role: "assistant", status: "completed", content: [finalPart] };
            const itemDone: ResponseOutputItemDoneEvent = {
              type: "response.output_item.done",
              output_index: 0,
              item: finalItem,
              sequence_number: sequenceNumber++,
            };
            send(itemDone);

            const syntheticParts: Part[] = [
              { id: "synthetic", sessionID: sessionId, messageID: info.id, type: "text", text: fullText },
            ];
            const response = buildResponseObject({ id: responseId, model, instructions, info, parts: syntheticParts });
            send({ type: "response.completed", response, sequence_number: sequenceNumber++ });
            finish({ fullText, usage: response.usage });
            return;
          }
        }

        // Event feed ended without an explicit completion signal - still
        // terminate the client-facing stream cleanly, treating it as success.
        const finalPart: ResponseOutputTextPart = { type: "output_text", text: fullText, annotations: [] };
        send({
          type: "response.output_text.done",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text: fullText,
          sequence_number: sequenceNumber++,
        });
        send({
          type: "response.content_part.done",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: finalPart,
          sequence_number: sequenceNumber++,
        });
        const finalItem: ResponseOutputMessageItem = { id: itemId, type: "message", role: "assistant", status: "completed", content: [finalPart] };
        send({ type: "response.output_item.done", output_index: 0, item: finalItem, sequence_number: sequenceNumber++ });
        const fallbackResponse: ResponseObject = {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "completed",
          model,
          output: [finalItem],
          output_text: fullText,
          usage: null,
          error: null,
          instructions,
        };
        send({ type: "response.completed", response: fallbackResponse, sequence_number: sequenceNumber++ });
        finish({ fullText, usage: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          const failedResponse: ResponseObject = {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "failed",
            model,
            output: [],
            output_text: "",
            usage: null,
            error: { code: "api_error", message },
            instructions,
          };
          send({ type: "response.failed", response: failedResponse, sequence_number: sequenceNumber++ });
        } catch {
          // stream may already be closed/errored
        }
        finish({ fullText, usage: null, errorMessage: message });
      }
    },
  });

  return { stream, done };
}
