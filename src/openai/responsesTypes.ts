/**
 * Wire types for the subset of the OpenAI Responses API this gateway
 * implements (POST /v1/responses). Field names and shapes verified against
 * the real openai-python SDK's TypedDicts (`openai/types/responses/*`) -
 * not guessed. Only the fields this gateway actually reads or writes are
 * modeled; anything else a client sends is accepted and ignored, matching
 * how `ChatCompletionRequest` already behaves in ./types.ts.
 */

// ---------------------------------------------------------------------------
// Request (POST /v1/responses)
// ---------------------------------------------------------------------------

export interface ResponseInputTextPart {
  type: "input_text";
  text: string;
}

/** A single item in the structured (array) form of `input`. Only the "message" variant is supported - the other 33 variants in OpenAI's union (function_call_output, computer_call, mcp_call, ...) all require tool-calling, which this gateway does not offer. */
export interface ResponseInputMessageItem {
  type?: "message";
  role: "user" | "system" | "developer";
  content: string | ResponseInputTextPart[];
}

export type ResponseInput = string | ResponseInputMessageItem[];

export interface ReasoningParam {
  /** "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" - forwarded verbatim as OpenCode's `variant`. Values are model-defined, not a fixed enum, so this is typed as a plain string. */
  effort?: string;
}

export interface ResponseFormatTextJSONSchemaConfig {
  type: "json_schema";
  name: string;
  schema: unknown;
  description?: string;
  strict?: boolean;
}

export interface ResponseTextConfig {
  format?: ResponseFormatTextJSONSchemaConfig | { type: "text" };
}

export interface ResponseCreateParams {
  model: string;
  input: ResponseInput;
  instructions?: string;
  stream?: boolean;
  reasoning?: ReasoningParam;
  text?: ResponseTextConfig;
  previous_response_id?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Response object (the shape returned by both the non-streaming call and
// embedded in every streaming event's `response` field)
// ---------------------------------------------------------------------------

export type ResponseStatus = "completed" | "failed" | "incomplete" | "in_progress";

export interface ResponseOutputTextPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface ResponseOutputMessageItem {
  id: string;
  type: "message";
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: ResponseOutputTextPart[];
}

export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export interface ResponseErrorObject {
  code: string;
  message: string;
}

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: ResponseStatus;
  model: string;
  output: ResponseOutputMessageItem[];
  output_text: string;
  usage: ResponseUsage | null;
  error: ResponseErrorObject | null;
  instructions: string | null;
}

// ---------------------------------------------------------------------------
// Streaming events (POST /v1/responses with stream: true)
//
// Real Responses API streaming does NOT end with a "data: [DONE]" sentinel
// (unlike Chat Completions) - the stream just closes after
// response.completed / response.failed. Each frame is `data: <json>\n\n`.
// This gateway implements only the minimal event sequence needed for plain
// text (+ structured-output) generation: no tool-call, audio, image, or MCP
// event types, since tools are disabled gateway-wide (see NO_TOOLS).
// ---------------------------------------------------------------------------

export interface ResponseCreatedEvent {
  type: "response.created";
  response: ResponseObject;
  sequence_number: number;
}

export interface ResponseInProgressEvent {
  type: "response.in_progress";
  response: ResponseObject;
  sequence_number: number;
}

export interface ResponseOutputItemAddedEvent {
  type: "response.output_item.added";
  output_index: number;
  item: ResponseOutputMessageItem;
  sequence_number: number;
}

export interface ResponseContentPartAddedEvent {
  type: "response.content_part.added";
  item_id: string;
  output_index: number;
  content_index: number;
  part: ResponseOutputTextPart;
  sequence_number: number;
}

export interface ResponseOutputTextDeltaEvent {
  type: "response.output_text.delta";
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
  sequence_number: number;
}

export interface ResponseOutputTextDoneEvent {
  type: "response.output_text.done";
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
  sequence_number: number;
}

export interface ResponseContentPartDoneEvent {
  type: "response.content_part.done";
  item_id: string;
  output_index: number;
  content_index: number;
  part: ResponseOutputTextPart;
  sequence_number: number;
}

export interface ResponseOutputItemDoneEvent {
  type: "response.output_item.done";
  output_index: number;
  item: ResponseOutputMessageItem;
  sequence_number: number;
}

export interface ResponseCompletedEvent {
  type: "response.completed";
  response: ResponseObject;
  sequence_number: number;
}

export interface ResponseFailedEvent {
  type: "response.failed";
  response: ResponseObject;
  sequence_number: number;
}

export type ResponseStreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseOutputItemAddedEvent
  | ResponseContentPartAddedEvent
  | ResponseOutputTextDeltaEvent
  | ResponseOutputTextDoneEvent
  | ResponseContentPartDoneEvent
  | ResponseOutputItemDoneEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent;
