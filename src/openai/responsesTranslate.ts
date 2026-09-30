import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantText, piUsageToTokenUsage } from "../piai/chat";
import type { ChatMessage, ResponseFormat } from "./types";
import type {
  ResponseInput,
  ResponseObject,
  ResponseOutputMessageItem,
  ResponseOutputTextPart,
  ResponseTextConfig,
  ResponseUsage,
} from "./responsesTypes";
import type { TokenUsage } from "./usage";

/**
 * Maps the Responses API's `input` (+ top-level `instructions`) onto the
 * same Chat-Completions-shaped message list the pi-ai backend takes for
 * /v1/chat/completions: `instructions` first as a system message, then each
 * input item as its own turn.
 */
export function responsesInputToMessages(input: ResponseInput, instructions?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  for (const item of input) {
    const content = typeof item.content === "string" ? item.content : item.content.map((part) => part.text).join("");
    messages.push({ role: item.role === "developer" ? "system" : item.role, content });
  }
  return messages;
}

/** The Responses API's `text.format` as the Chat Completions `response_format` the pi-ai backend understands. */
export function responsesFormat(text?: ResponseTextConfig): ResponseFormat | undefined {
  const format = text?.format;
  if (!format || format.type !== "json_schema") return undefined;
  return { type: "json_schema", json_schema: { name: format.name, schema: format.schema, strict: format.strict } };
}

export function toResponseUsage(usage: TokenUsage): ResponseUsage {
  return {
    input_tokens: usage.promptTokens,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens },
    output_tokens: usage.completionTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.totalTokens,
  };
}

export function completedResponseObject(args: {
  id: string;
  model: string;
  instructions: string | null;
  createdAt: number;
  text: string;
  usage: TokenUsage | null;
}): ResponseObject {
  const item: ResponseOutputMessageItem = {
    id: `msg_${args.id.replace(/^resp_/, "")}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: args.text, annotations: [] } satisfies ResponseOutputTextPart],
  };
  return {
    id: args.id,
    object: "response",
    created_at: args.createdAt,
    status: "completed",
    model: args.model,
    output: [item],
    output_text: args.text,
    usage: args.usage ? toResponseUsage(args.usage) : null,
    error: null,
    instructions: args.instructions,
  };
}

export function failedResponseObject(args: {
  id: string;
  model: string;
  instructions: string | null;
  createdAt: number;
  message: string;
}): ResponseObject {
  return {
    id: args.id,
    object: "response",
    created_at: args.createdAt,
    status: "failed",
    model: args.model,
    output: [],
    output_text: "",
    usage: null,
    error: { code: "api_error", message: args.message },
    instructions: args.instructions,
  };
}

/** Non-streaming /v1/responses result from a completed pi-ai message. */
export function piMessageToResponseObject(args: {
  id: string;
  model: string;
  instructions: string | null;
  message: AssistantMessage;
}): ResponseObject {
  return completedResponseObject({
    id: args.id,
    model: args.model,
    instructions: args.instructions,
    createdAt: Math.floor(args.message.timestamp / 1000),
    text: assistantText(args.message),
    usage: piUsageToTokenUsage(args.message.usage),
  });
}
