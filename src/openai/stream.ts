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

export interface OpenAIChatStream {
  /** Raw SSE byte stream ready to hand to a Response / c.newResponse. */
  stream: ReadableStream<Uint8Array>;
  /** Resolves once the stream has finished (successfully or on error). */
  done: Promise<StreamDoneResult>;
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const partLengths = new Map<string, number>();
      let fullText = "";
      let usage: StreamUsage | undefined;
      let errorMessage: string | undefined;

      const emitDelta = (content: string) => {
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
            }
            if (info.tokens) {
              usage = {
                prompt_tokens: info.tokens.input,
                completion_tokens: info.tokens.output,
                total_tokens: info.tokens.total,
              };
            }
            if (info.time?.completed != null) {
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
        emitFinish();
        controller.close();
        resolveDone({ fullText, usage, errorMessage });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
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

  return { stream, done };
}
