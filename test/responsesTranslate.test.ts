import { describe, expect, test } from "bun:test";
import {
  buildResponseObject,
  buildResponsesFormat,
  extractResponsesError,
  parseResponsesInput,
} from "../src/openai/responsesTranslate";
import type { AssistantMessage } from "../src/opencode/types";

describe("parseResponsesInput", () => {
  test("plain string input, no instructions", () => {
    expect(parseResponsesInput("hello there")).toEqual({ system: undefined, text: "hello there" });
  });

  test("plain string input with instructions", () => {
    expect(parseResponsesInput("hello there", "Be concise.")).toEqual({
      system: "Be concise.",
      text: "hello there",
    });
  });

  test("single user-role array item, string content", () => {
    expect(parseResponsesInput([{ role: "user", content: "hi" }])).toEqual({
      system: undefined,
      text: "User: hi",
    });
  });

  test("single user-role array item, array-of-input_text content", () => {
    expect(
      parseResponsesInput([
        { role: "user", content: [{ type: "input_text", text: "part one " }, { type: "input_text", text: "part two" }] },
      ])
    ).toEqual({ system: undefined, text: "User: part one part two" });
  });

  test("system + user combo", () => {
    expect(
      parseResponsesInput([
        { role: "system", content: "You are terse." },
        { role: "user", content: "hi" },
      ])
    ).toEqual({ system: "You are terse.", text: "User: hi" });
  });

  test("developer role also seeds system, instructions come first", () => {
    expect(
      parseResponsesInput(
        [
          { role: "developer", content: "dev note" },
          { role: "user", content: "hi" },
        ],
        "top-level instructions"
      )
    ).toEqual({ system: "top-level instructions\n\ndev note", text: "User: hi" });
  });

  test("multiple user turns are joined and labeled", () => {
    expect(
      parseResponsesInput([
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ])
    ).toEqual({ system: undefined, text: "User: first\n\nUser: second" });
  });
});

describe("buildResponsesFormat", () => {
  test("json_schema format produces an OpenCode OutputFormat", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    expect(buildResponsesFormat({ format: { type: "json_schema", name: "answer", schema } })).toEqual({
      type: "json_schema",
      schema,
    });
  });

  test("text format -> undefined", () => {
    expect(buildResponsesFormat({ format: { type: "text" } })).toBeUndefined();
  });

  test("undefined text config -> undefined", () => {
    expect(buildResponsesFormat(undefined)).toBeUndefined();
  });

  test("text config with no format -> undefined", () => {
    expect(buildResponsesFormat({})).toBeUndefined();
  });
});

describe("extractResponsesError", () => {
  test("real error is wrapped with code api_error", () => {
    expect(extractResponsesError({ message: "boom" })).toEqual({ code: "api_error", message: "boom" });
  });

  test("undefined error still produces a fallback message", () => {
    expect(extractResponsesError(undefined)).toEqual({ code: "api_error", message: "OpenCode reported an error" });
  });
});

function makeInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "msg_abc",
    sessionID: "ses_1",
    role: "assistant",
    parentID: "",
    modelID: "gpt-5.4",
    providerID: "openai",
    mode: "build",
    agent: "build",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { total: 30, input: 10, output: 20 },
    time: { created: 1_700_000_000_000, completed: 1_700_000_000_500 },
    ...overrides,
  };
}

describe("buildResponseObject", () => {
  test("successful completion", () => {
    const info = makeInfo();
    const result = buildResponseObject({
      id: "resp_1",
      model: "openai/gpt-5.4",
      instructions: "Be nice.",
      info,
      parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_abc", type: "text", text: "hi there" }],
    });

    expect(result.status).toBe("completed");
    expect(result.output_text).toBe("hi there");
    expect(result.output).toEqual([
      {
        id: "msg_msg_abc",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hi there", annotations: [] }],
      },
    ]);
    expect(result.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 30,
    });
    expect(result.error).toBeNull();
    expect(result.instructions).toBe("Be nice.");
    expect(result.created_at).toBe(1_700_000_000);
  });

  test("completion with reasoning tokens and cache reads", () => {
    const info = makeInfo({ tokens: { total: 50, input: 10, output: 20, reasoning: 15, cache: { read: 5, write: 0 } } });
    const result = buildResponseObject({ id: "resp_1", model: "m", instructions: null, info, parts: [] });
    expect(result.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 15 },
      total_tokens: 50,
    });
  });

  test("error -> failed status, empty output, no usage", () => {
    const info = makeInfo({ error: { message: "provider unavailable" } });
    const result = buildResponseObject({
      id: "resp_2",
      model: "openai/gpt-5.4",
      instructions: null,
      info,
      parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_abc", type: "text", text: "partial" }],
    });

    expect(result.status).toBe("failed");
    expect(result.output).toEqual([]);
    expect(result.output_text).toBe("");
    expect(result.usage).toBeNull();
    expect(result.error).toEqual({ code: "api_error", message: "provider unavailable" });
  });

  test("no tokens on info -> usage is null", () => {
    const info = makeInfo({ tokens: undefined as unknown as AssistantMessage["tokens"] });
    const result = buildResponseObject({ id: "resp_3", model: "m", instructions: null, info, parts: [] });
    expect(result.usage).toBeNull();
  });
});
