import type { AssistantMessage, AssistantMessageError, OutputFormat, Part } from "../opencode/types";
import { isTextPart } from "../opencode/types";
import type { ChatCompletionResponse, ChatMessage, ResponseFormat } from "./types";

/**
 * OpenCode wraps provider-side failures (e.g. "this model isn't available on
 * your plan") in an `APIError` whose useful text lives at `error.data.message`,
 * not `error.message`/`error.name` (those are typically just "APIError").
 * Digs through both shapes so clients see the actual reason, not just the
 * error class name.
 */
export function extractErrorMessage(error: AssistantMessageError | undefined): string {
  if (!error) return "OpenCode reported an error";
  const nestedMessage = (error as { data?: { message?: string } }).data?.message;
  return nestedMessage ?? error.message ?? error.name ?? "OpenCode reported an error";
}

export class InvalidModelError extends Error {
  constructor(model: string) {
    super(`Invalid model id "${model}": expected "provider/model" format`);
    this.name = "InvalidModelError";
  }
}

/**
 * Splits an OpenAI-style "provider/model" string, with an optional
 * "#variant" suffix (matching OpenCode's own CLI convention, e.g.
 * "openai/gpt-5.2#high"), into OpenCode's { providerID, modelID, variant }
 * shape. The "/" is resolved on the part before "#", so a variant id may
 * itself never contain "/" or "#".
 */
export function parseModelId(model: string): { providerID: string; modelID: string; variant?: string } {
  const hashIdx = model.indexOf("#");
  const variant = hashIdx >= 0 ? model.slice(hashIdx + 1) : undefined;
  const base = hashIdx >= 0 ? model.slice(0, hashIdx) : model;

  const idx = base.indexOf("/");
  if (idx <= 0 || idx === base.length - 1 || variant === "") {
    throw new InvalidModelError(model);
  }
  return {
    providerID: base.slice(0, idx),
    modelID: base.slice(idx + 1),
    ...(variant !== undefined ? { variant } : {}),
  };
}

/**
 * Flattens an OpenAI chat `messages` array into OpenCode's single-shot
 * prompt shape: system messages are concatenated into `system`, and the
 * remaining turns are rendered into one labeled transcript string since
 * OpenCode sessions don't support bulk-seeding prior turns any other way
 * via this endpoint (and OpenAI chat completions resend full history on
 * every call anyway, so one-shot flattening is correct and simple).
 */
export function messagesToOpenCodePrompt(messages: ChatMessage[]): {
  system: string | undefined;
  text: string;
} {
  const systemParts: string[] = [];
  const turns: string[] = [];

  for (const message of messages) {
    const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
    switch (message.role) {
      case "system":
        systemParts.push(content);
        break;
      case "user":
        turns.push(`User: ${content}`);
        break;
      case "assistant":
        turns.push(`Assistant: ${content}`);
        break;
      case "tool":
        turns.push(`Tool: ${content}`);
        break;
      default:
        turns.push(`${message.role}: ${content}`);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    text: turns.join("\n\n"),
  };
}

/**
 * Builds OpenCode's `format` field from an OpenAI `response_format`.
 * `json_object` (schema-less) and absence both mean "just give me text" -
 * we omit `format` entirely rather than bothering with prompt-injection
 * fallbacks, since OpenCode natively supports `json_schema`.
 */
export function buildOpenCodeFormat(responseFormat?: ResponseFormat): OutputFormat | undefined {
  if (!responseFormat) return undefined;
  if (responseFormat.type === "json_schema") {
    return { type: "json_schema", schema: responseFormat.json_schema.schema };
  }
  return undefined;
}

export function extractText(parts: Part[]): string {
  return parts.filter(isTextPart).map((p) => p.text).join("");
}

/**
 * With `format: { type: "json_schema" }`, OpenCode returns the actual
 * result out-of-band on `info.structured` (a parsed object matching the
 * schema) rather than as a text part - `parts`/`extractText` alone comes
 * back empty in that case, even though the model did produce (and pay for)
 * output. Real OpenAI Structured Outputs still hands the result back as a
 * JSON *string* in `content`/`output_text` for the caller to parse
 * themselves (same as plain `json_object` mode) - not a nested object -
 * so this bridges the gap by stringifying `info.structured` when present.
 */
export function extractResponseContent(info: AssistantMessage, parts: Part[]): string {
  if (info.structured !== undefined && info.structured !== null) {
    return JSON.stringify(info.structured);
  }
  return extractText(parts);
}

export function assistantMessageToOpenAIResponse(
  model: string,
  info: AssistantMessage,
  parts: Part[]
): ChatCompletionResponse {
  const content = extractResponseContent(info, parts);

  const response: ChatCompletionResponse = {
    id: `chatcmpl-${info.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: info.error ? "error" : "stop",
      },
    ],
  };

  if (info.tokens) {
    response.usage = {
      prompt_tokens: info.tokens.input,
      completion_tokens: info.tokens.output,
      total_tokens: info.tokens.total,
    };
    if (info.tokens.reasoning) {
      response.usage.completion_tokens_details = { reasoning_tokens: info.tokens.reasoning };
    }
  }

  return response;
}
