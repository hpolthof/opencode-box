import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  StopReason,
  ThinkingLevel,
  Usage,
} from "@earendil-works/pi-ai";
import type { FirstOutcome, StreamDoneResult } from "../openai/stream";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionUsage,
  ChatMessage,
  ResponseFormat,
} from "../openai/types";
import type { TokenUsage } from "../openai/usage";

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

/** OpenAI allows `content` as a string or an array of typed parts; only text parts are carried over. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : ""
      )
      .join("");
  }
  return content == null ? "" : String(content);
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Maps an OpenAI `messages` array onto a pi-ai Context, keeping the turns
 * as real turns (unlike the OpenCode path, which has to flatten history
 * into one labeled transcript). System/developer messages become the
 * system prompt. Prior assistant turns are attributed to the target model.
 * `tool` messages are rendered as user text for now - tool calls are not
 * passed through yet.
 */
export function messagesToPiContext(messages: ChatMessage[], model: Model<Api>): Context {
  const systemParts: string[] = [];
  const out: Message[] = [];
  const timestamp = Date.now();

  for (const message of messages) {
    const text = contentToText(message.content);
    switch (message.role as string) {
      case "system":
      case "developer":
        systemParts.push(text);
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: [{ type: "text", text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp,
        });
        break;
      case "tool":
        out.push({ role: "user", content: `Tool result:\n${text}`, timestamp });
        break;
      default:
        out.push({ role: "user", content: text, timestamp });
    }
  }

  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
    messages: out,
  };
}

export class UnsupportedResponseFormatError extends Error {
  constructor(api: string) {
    super(`response_format json_schema is not supported for models using the "${api}" API`);
    this.name = "UnsupportedResponseFormatError";
  }
}

type PayloadHook = (payload: unknown) => unknown;

/**
 * pi-ai has no structured-output option, but its `onPayload` hook may
 * replace the provider payload right before it is sent. This returns a hook
 * that adds each API's native structured-output field:
 *
 * - OpenAI Chat Completions: `response_format`
 * - OpenAI Responses (incl. Azure and ChatGPT/Codex): `text.format`
 * - Anthropic Messages: `output_config.format` (merged - pi-ai may already
 *   have put `effort` in `output_config`)
 *
 * `json_object` is passed through where the API has an equivalent and
 * otherwise ignored, matching how the OpenCode path treats it.
 */
export function structuredOutputHook(api: Api, responseFormat: ResponseFormat | undefined): PayloadHook | undefined {
  if (!responseFormat || responseFormat.type === "text") return undefined;

  if (responseFormat.type === "json_object") {
    switch (api) {
      case "openai-completions":
        return (p) => ({ ...(p as object), response_format: { type: "json_object" } });
      case "openai-responses":
      case "azure-openai-responses":
      case "openai-codex-responses":
        return (p) => {
          const payload = p as { text?: object };
          return { ...payload, text: { ...payload.text, format: { type: "json_object" } } };
        };
      default:
        return undefined;
    }
  }

  const { schema } = responseFormat.json_schema;
  const name = responseFormat.json_schema.name || "response";
  const strict = responseFormat.json_schema.strict ?? false;

  switch (api) {
    case "openai-completions":
      return (p) => ({
        ...(p as object),
        response_format: { type: "json_schema", json_schema: { name, schema, strict } },
      });
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return (p) => {
        const payload = p as { text?: object };
        return { ...payload, text: { ...payload.text, format: { type: "json_schema", name, schema, strict } } };
      };
    case "anthropic-messages":
      return (p) => {
        const payload = p as { output_config?: object };
        return { ...payload, output_config: { ...payload.output_config, format: { type: "json_schema", schema } } };
      };
    default:
      throw new UnsupportedResponseFormatError(api);
  }
}

/**
 * Splits an optional "#level" suffix off a pi model id, mirroring the
 * "#variant" convention of the OpenCode path.
 */
export function splitVariant(model: string): { base: string; variant?: string } {
  const hashIdx = model.indexOf("#");
  if (hashIdx < 0) return { base: model };
  return { base: model.slice(0, hashIdx), variant: model.slice(hashIdx + 1) };
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

/** pi-ai's `input` excludes cached input and its `output` already includes reasoning. */
export function piUsageToTokenUsage(usage: Usage): TokenUsage {
  return {
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoning ?? 0,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

function toOpenAIUsage(usage: TokenUsage): ChatCompletionUsage {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    ...(usage.cacheReadTokens ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
    ...(usage.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  };
}

function finishReason(stopReason: StopReason): "stop" | "length" | "error" {
  if (stopReason === "length") return "length";
  if (stopReason === "error" || stopReason === "aborted") return "error";
  return "stop";
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export function piMessageToOpenAIResponse(model: string, message: AssistantMessage): ChatCompletionResponse {
  return {
    id: `chatcmpl-${message.responseId ?? crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: assistantText(message) },
        finish_reason: finishReason(message.stopReason),
      },
    ],
    usage: toOpenAIUsage(piUsageToTokenUsage(message.usage)),
  };
}

export interface PiChatStream {
  stream: ReadableStream<Uint8Array>;
  done: Promise<StreamDoneResult>;
  firstOutcome: Promise<FirstOutcome>;
}

/**
 * Turns pi-ai's event stream into an OpenAI `chat.completion.chunk` SSE
 * stream. Same contract as `createOpenAIChatStream`: events are consumed
 * eagerly into the ReadableStream's queue, and `firstOutcome` settles on
 * the first text delta or on a failure before any text, so the caller can
 * still answer with a plain error response when nothing was produced.
 */
export function createPiChatStream(
  events: AsyncIterable<AssistantMessageEvent>,
  model: string,
  options: { includeUsage?: boolean } = {}
): PiChatStream {
  const id = `chatcmpl-${crypto.randomUUID()}`;
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
      let fullText = "";
      let sentRole = false;
      const send = (chunk: Omit<ChatCompletionChunk, "id" | "object" | "created" | "model">) => {
        const full = { id, object: "chat.completion.chunk", created, model, ...chunk };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(full)}\n\n`));
      };
      const finish = (reason: "stop" | "length", usage?: TokenUsage) => {
        send({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
        if (options.includeUsage && usage) send({ choices: [], usage: toOpenAIUsage(usage) });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      try {
        for await (const event of events) {
          if (event.type === "text_delta") {
            settleFirstOutcome({ ok: true });
            fullText += event.delta;
            send({
              choices: [{ index: 0, delta: sentRole ? { content: event.delta } : { role: "assistant", content: event.delta }, finish_reason: null }],
            });
            sentRole = true;
          } else if (event.type === "done") {
            const usage = piUsageToTokenUsage(event.message.usage);
            settleFirstOutcome({ ok: true });
            finish(event.message.stopReason === "length" ? "length" : "stop", usage);
            resolveDone({ fullText, usage });
            return;
          } else if (event.type === "error") {
            const errorMessage = event.error.errorMessage ?? `Request ${event.reason}`;
            settleFirstOutcome({ ok: false, message: errorMessage });
            finish("stop");
            resolveDone({ fullText, errorMessage });
            return;
          }
        }
        settleFirstOutcome({ ok: true });
        finish("stop");
        resolveDone({ fullText });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        settleFirstOutcome({ ok: false, message: errorMessage });
        finish("stop");
        resolveDone({ fullText, errorMessage });
      }
    },
  });

  return { stream, done, firstOutcome };
}

export type { ThinkingLevel };
