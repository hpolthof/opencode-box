/**
 * Wire types for the subset of the OpenAI Chat Completions API that this
 * gateway implements (POST /v1/chat/completions, GET /v1/models).
 */

export type ChatMessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  [key: string]: unknown;
}

export interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: { name?: string; schema: unknown; strict?: boolean };
}

export interface JsonObjectResponseFormat {
  type: "json_object";
}

export interface TextResponseFormat {
  type: "text";
}

export type ResponseFormat = TextResponseFormat | JsonObjectResponseFormat | JsonSchemaResponseFormat;

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  response_format?: ResponseFormat;
  /**
   * Reasoning effort / thinking budget preset to use, e.g. "low" | "high" -
   * must match one of the target model's configured variant ids (see
   * GET /v1/models or the admin Models page). Equivalent to appending
   * "#<value>" to `model`; if both are given, this field wins.
   */
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "error";
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens: number };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: "stop" | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

export function openAIError(message: string, type: string, code?: string): OpenAIErrorBody {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

export interface ModelListEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Non-standard: reasoning effort / thinking budget preset ids this model accepts as `reasoning_effort` or a "#variant" suffix on `model`. */
  variants?: string[];
}

export interface ModelListResponse {
  object: "list";
  data: ModelListEntry[];
}
