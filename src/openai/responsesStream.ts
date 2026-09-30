import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { piUsageToTokenUsage, type FirstOutcome, type StreamDoneResult } from "../piai/chat";
import { completedResponseObject, failedResponseObject } from "./responsesTranslate";
import type { ResponseObject, ResponseOutputMessageItem, ResponseOutputTextPart, ResponseStreamEvent } from "./responsesTypes";

export interface ResponsesStream {
  /** Raw SSE byte stream ready to hand to a Response / c.newResponse. */
  stream: ReadableStream<Uint8Array>;
  /** Resolves once the stream has finished (successfully or on error). */
  done: Promise<StreamDoneResult>;
  /** See `FirstOutcome` in src/piai/chat.ts. */
  firstOutcome: Promise<FirstOutcome>;
}

/**
 * Turns pi-ai's event stream into an OpenAI Responses API SSE stream:
 * `response.created` / `in_progress`, one output message item with one
 * `output_text` part, a `response.output_text.delta` per text chunk, the
 * matching `*.done` events and finally `response.completed` (or
 * `response.incomplete` when the answer hit `max_output_tokens`, or
 * `response.failed`).
 *
 * Unlike Chat Completions streaming, the real Responses API does NOT end
 * with a `data: [DONE]` sentinel - the stream just closes after
 * `response.completed` / `response.failed`.
 */
export function createResponsesStream(
  events: AsyncIterable<AssistantMessageEvent>,
  responseId: string,
  model: string,
  instructions: string | null
): ResponsesStream {
  const createdAt = Math.floor(Date.now() / 1000);
  const itemId = `msg_${responseId.replace(/^resp_/, "")}`;
  const encoder = new TextEncoder();

  let resolveDone!: (result: StreamDoneResult) => void;
  const done = new Promise<StreamDoneResult>((resolve) => {
    resolveDone = resolve;
  });

  let resolveFirstOutcome!: (result: FirstOutcome) => void;
  let firstOutcomeSettled = false;
  const firstOutcome = new Promise<FirstOutcome>((resolve) => {
    resolveFirstOutcome = resolve;
  });
  const settleFirstOutcome = (result: FirstOutcome) => {
    if (firstOutcomeSettled) return;
    firstOutcomeSettled = true;
    resolveFirstOutcome(result);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = "";
      let sequenceNumber = 0;
      const send = (event: ResponseStreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const inProgress = (): ResponseObject => ({
        id: responseId,
        object: "response",
        created_at: createdAt,
        status: "in_progress",
        model,
        output: [],
        output_text: "",
        usage: null,
        error: null,
        incomplete_details: null,
        instructions,
      });

      send({ type: "response.created", response: inProgress(), sequence_number: sequenceNumber++ });
      send({ type: "response.in_progress", response: inProgress(), sequence_number: sequenceNumber++ });
      const shellItem: ResponseOutputMessageItem = { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] };
      send({ type: "response.output_item.added", output_index: 0, item: shellItem, sequence_number: sequenceNumber++ });
      send({
        type: "response.content_part.added",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
        sequence_number: sequenceNumber++,
      });

      const fail = (message: string) => {
        settleFirstOutcome({ ok: false, message });
        send({
          type: "response.failed",
          response: failedResponseObject({ id: responseId, model, instructions, createdAt, message }),
          sequence_number: sequenceNumber++,
        });
        controller.close();
        resolveDone({ fullText, errorMessage: message });
      };

      try {
        for await (const event of events) {
          if (event.type === "text_delta") {
            settleFirstOutcome({ ok: true });
            fullText += event.delta;
            send({
              type: "response.output_text.delta",
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              delta: event.delta,
              sequence_number: sequenceNumber++,
            });
          } else if (event.type === "done") {
            settleFirstOutcome({ ok: true });
            const usage = piUsageToTokenUsage(event.message.usage);
            const finalPart: ResponseOutputTextPart = { type: "output_text", text: fullText, annotations: [] };
            send({ type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: fullText, sequence_number: sequenceNumber++ });
            send({ type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: finalPart, sequence_number: sequenceNumber++ });
            const truncated = event.message.stopReason === "length";
            const response = completedResponseObject({ id: responseId, model, instructions, createdAt, text: fullText, usage, truncated });
            send({ type: "response.output_item.done", output_index: 0, item: response.output[0]!, sequence_number: sequenceNumber++ });
            send({ type: truncated ? "response.incomplete" : "response.completed", response, sequence_number: sequenceNumber++ });
            controller.close();
            resolveDone({ fullText, usage });
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

  return { stream, done, firstOutcome };
}
