import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  failedResponseObject,
  piMessageToResponseObject,
  responsesFormat,
  responsesInputToMessages,
} from "../src/openai/responsesTranslate";

describe("responsesInputToMessages", () => {
  test("plain string input, no instructions", () => {
    expect(responsesInputToMessages("Hi")).toEqual([{ role: "user", content: "Hi" }]);
  });

  test("instructions become a leading system message", () => {
    expect(responsesInputToMessages("Hi", "Be brief.")).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ]);
  });

  test("array items keep their turns; developer counts as system; content parts are joined", () => {
    expect(
      responsesInputToMessages([
        { role: "developer", content: "Answer in Dutch." },
        { role: "user", content: [{ type: "input_text", text: "Mijn naam " }, { type: "input_text", text: "is Paul." }] },
        { role: "assistant", content: [{ type: "output_text", text: "Hallo Paul!" }] },
        { role: "user", content: "Hoe heet ik?" },
      ])
    ).toEqual([
      { role: "system", content: "Answer in Dutch." },
      { role: "user", content: "Mijn naam is Paul." },
      { role: "assistant", content: "Hallo Paul!" },
      { role: "user", content: "Hoe heet ik?" },
    ]);
  });
});

describe("responsesFormat", () => {
  test("json_schema becomes a Chat-Completions-style response_format", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(responsesFormat({ format: { type: "json_schema", name: "out", schema, strict: true } })).toEqual({
      type: "json_schema",
      json_schema: { name: "out", schema, strict: true },
    });
  });

  test("text format, no format and no text config -> undefined", () => {
    expect(responsesFormat({ format: { type: "text" } })).toBeUndefined();
    expect(responsesFormat({})).toBeUndefined();
    expect(responsesFormat(undefined)).toBeUndefined();
  });
});

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Parijs" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: {
      input: 10,
      output: 7,
      reasoning: 3,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 117,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_790_000_000_123,
    ...overrides,
  };
}

describe("piMessageToResponseObject", () => {
  test("completed response with the text (not the thinking) and OpenAI-style usage", () => {
    const response = piMessageToResponseObject({ id: "resp_abc", model: "openai/gpt-5.6-luna", instructions: "Be brief.", message: message() });
    expect(response).toMatchObject({
      id: "resp_abc",
      object: "response",
      created_at: 1_790_000_000,
      status: "completed",
      model: "openai/gpt-5.6-luna",
      output_text: "Parijs",
      error: null,
      instructions: "Be brief.",
      usage: {
        input_tokens: 110,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 117,
      },
    });
    expect(response.output).toEqual([
      { id: "msg_abc", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Parijs", annotations: [] }] },
    ]);
  });
});

describe("failedResponseObject", () => {
  test("failed status, empty output, api_error", () => {
    expect(failedResponseObject({ id: "resp_x", model: "m", instructions: null, createdAt: 1, message: "boom" })).toMatchObject({
      status: "failed",
      output: [],
      output_text: "",
      usage: null,
      error: { code: "api_error", message: "boom" },
    });
  });
});
