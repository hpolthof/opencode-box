import type { AssistantMessage, AssistantMessageError, OutputFormat, Part } from "../opencode/types";
import { buildOpenCodeFormat, extractErrorMessage, extractText } from "./translate";
import type {
  ResponseErrorObject,
  ResponseInput,
  ResponseObject,
  ResponseOutputMessageItem,
  ResponseOutputTextPart,
  ResponseTextConfig,
  ResponseUsage,
} from "./responsesTypes";

/**
 * Flattens the Responses API's `input` (+ top-level `instructions`) into
 * OpenCode's single-shot `{system, text}` prompt shape - the same target
 * shape `messagesToOpenCodePrompt` produces from Chat Completions'
 * `messages` array, for the same reason: OpenCode sessions take one
 * `system` string plus one prompt `text` string, not a turn array.
 */
export function parseResponsesInput(input: ResponseInput, instructions?: string): { system: string | undefined; text: string } {
  const systemParts: string[] = [];
  if (instructions) systemParts.push(instructions);

  if (typeof input === "string") {
    return {
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      text: input,
    };
  }

  const turns: string[] = [];
  for (const item of input) {
    const content = typeof item.content === "string" ? item.content : item.content.map((part) => part.text).join("");
    switch (item.role) {
      case "system":
      case "developer":
        systemParts.push(content);
        break;
      case "user":
        turns.push(`User: ${content}`);
        break;
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    text: turns.join("\n\n"),
  };
}

/**
 * Builds OpenCode's `format` field from the Responses API's `text.format`.
 * `{type:"text"}` and absence both mean "just give me text" - reuses
 * `buildOpenCodeFormat` (via a constructed Chat-Completions-shaped wrapper)
 * so the json_schema -> OpenCode translation lives in exactly one place.
 * Like the existing `/v1/chat/completions` path, `name`/`strict`/
 * `description` have no OpenCode equivalent and are dropped.
 */
export function buildResponsesFormat(text?: ResponseTextConfig): OutputFormat | undefined {
  const format = text?.format;
  if (!format || format.type !== "json_schema") return undefined;
  return buildOpenCodeFormat({ type: "json_schema", json_schema: { schema: format.schema } });
}

/** Wraps `extractErrorMessage` into a Responses-API-shaped error object. */
export function extractResponsesError(error: AssistantMessageError | undefined): ResponseErrorObject {
  return { code: "api_error", message: extractErrorMessage(error) };
}

/**
 * Builds the complete `ResponseObject` for both success and failure - reused
 * by the non-streaming route and by the streaming layer's terminal
 * `response.completed` / `response.failed` event, so it fully self-
 * determines success vs failure from `args.info.error`.
 */
export function buildResponseObject(args: {
  id: string;
  model: string;
  instructions: string | null;
  info: AssistantMessage;
  parts: Part[];
}): ResponseObject {
  const { id, model, instructions, info, parts } = args;

  if (info.error) {
    return {
      id,
      object: "response",
      // OpenCode is a JS/TS backend; `time.created` follows the standard
      // `Date.now()` convention (milliseconds), hence the /1000 below.
      created_at: Math.floor(info.time.created / 1000),
      status: "failed",
      model,
      output: [],
      output_text: "",
      usage: null,
      error: extractResponsesError(info.error),
      instructions,
    };
  }

  const text = extractText(parts);
  const outputItem: ResponseOutputMessageItem = {
    id: `msg_${info.id}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] } satisfies ResponseOutputTextPart],
  };

  const usage: ResponseUsage | null = info.tokens
    ? {
        input_tokens: info.tokens.input,
        input_tokens_details: { cached_tokens: info.tokens.cache?.read ?? 0 },
        output_tokens: info.tokens.output,
        output_tokens_details: { reasoning_tokens: info.tokens.reasoning ?? 0 },
        total_tokens: info.tokens.total,
      }
    : null;

  return {
    id,
    object: "response",
    created_at: Math.floor(info.time.created / 1000),
    status: "completed",
    model,
    output: [outputItem],
    output_text: text,
    usage,
    error: null,
    instructions,
  };
}
