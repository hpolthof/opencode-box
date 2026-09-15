import { isMessagePartUpdated, isMessageUpdated, isTextPart } from "../opencode/types";
import type { OpenCodeEvent } from "../opencode/types";
import { extractErrorMessage } from "./translate";
import type { ChatCompletionChunk } from "./types";

export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamDoneResult {
  fullText: string;
  usage?: StreamUsage;
  errorMessage?: string;
}

export type FirstOutcome = { ok: true } | { ok: false; message: string };

export interface OpenAIChatStream {
  /** Raw SSE byte stream ready to hand to a Response / c.newResponse. */
  stream: ReadableStream<Uint8Array>;
  /** Resolves once the stream has finished (successfully or on error). */
  done: Promise<StreamDoneResult>;
  /**
   * Resolves as soon as we know whether the response got off the ground -
   * the first content delta was emitted, or the stream completed/failed
   * with no content at all - whichever happens first. Lets a caller decide
   * whether to fail over to another target before ever attaching `stream`
   * to the real HTTP response: nothing reaches an actual client until then,
   * since `stream`'s `start()` only buffers into the ReadableStream's
   * internal queue until something reads from it.
   */
  firstOutcome: Promise<FirstOutcome>;
}

function sseFrame(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Consumes OpenCode's global event feed (filtered to `sessionId`) and
 * produces an OpenAI-compatible `chat.completion.chunk` SSE stream.
 *
 * `message.part.updated` events carry the FULL current text of a part, not
 * a delta - we track the previously-seen length per part id and emit only
 * the newly-appended substring as the OpenAI delta.
 */
export function createOpenAIChatStream(
  events: AsyncIterable<OpenCodeEvent>,
  sessionId: string,
  model: string
): OpenAIChatStream {
  const id = `chatcmpl-${sessionId}`;
  const created = Math.floor(Date.now() / 1000);
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
      const partLengths = new Map<string, number>();
      let fullText = "";
      let usage: StreamUsage | undefined;
      let errorMessage: string | undefined;

      const emitDelta = (content: string) => {
        settleFirstOutcome({ ok: true });
        const chunk: ChatCompletionChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        };
        controller.enqueue(encoder.encode(sseFrame(chunk)));
      };

      const emitFinish = () => {
        const chunk: ChatCompletionChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        controller.enqueue(encoder.encode(sseFrame(chunk)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
                emitDelta(delta);
              }
            }
            continue;
          }

          if (isMessageUpdated(event)) {
            const info = event.properties.info;
            if (info.error) {
              errorMessage = extractErrorMessage(info.error);
              settleFirstOutcome({ ok: false, message: errorMessage });
            }
            if (info.tokens) {
              usage = {
                prompt_tokens: info.tokens.input,
                completion_tokens: info.tokens.output,
                total_tokens: info.tokens.total,
              };
            }
            if (info.time?.completed != null) {
              // No-op if a delta or an error already settled this.
              settleFirstOutcome({ ok: true });
              emitFinish();
              controller.close();
              resolveDone({ fullText, usage, errorMessage });
              return;
            }
            continue;
          }
        }

        // Event feed ended without an explicit completion signal - still
        // terminate the client-facing stream cleanly.
        settleFirstOutcome(errorMessage ? { ok: false, message: errorMessage } : { ok: true });
        emitFinish();
        controller.close();
        resolveDone({ fullText, usage, errorMessage });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        settleFirstOutcome({ ok: false, message: errorMessage });
        try {
          emitFinish();
          controller.close();
        } catch {
          // stream may already be closed/errored
        }
        resolveDone({ fullText, usage, errorMessage });
      }
    },
  });

  return { stream, done, firstOutcome };
}
