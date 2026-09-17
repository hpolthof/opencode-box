import { describe, expect, test } from "bun:test";
import { InvalidModelError, assistantMessageToOpenAIResponse, extractResponseContent, parseModelId } from "../src/openai/translate";
import type { AssistantMessage } from "../src/opencode/types";

describe("parseModelId", () => {
  test("plain provider/model", () => {
    expect(parseModelId("openai/gpt-5.4")).toEqual({ providerID: "openai", modelID: "gpt-5.4" });
  });

  test("provider/model#variant", () => {
    expect(parseModelId("openai/gpt-5.4#high")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
      variant: "high",
    });
  });

  test("modelID may itself contain slashes", () => {
    expect(parseModelId("openrouter/meta-llama/llama-3.1#low")).toEqual({
      providerID: "openrouter",
      modelID: "meta-llama/llama-3.1",
      variant: "low",
    });
  });

  test("no slash -> InvalidModelError", () => {
    expect(() => parseModelId("not-a-valid-model-id")).toThrow(InvalidModelError);
  });

  test("no slash but has a variant suffix -> still InvalidModelError", () => {
    expect(() => parseModelId("not-a-valid-model-id#high")).toThrow(InvalidModelError);
  });

  test("empty variant after # -> InvalidModelError", () => {
    expect(() => parseModelId("openai/gpt-5.4#")).toThrow(InvalidModelError);
  });

  test("empty provider or model segment -> InvalidModelError", () => {
    expect(() => parseModelId("/gpt-5.4")).toThrow(InvalidModelError);
    expect(() => parseModelId("openai/")).toThrow(InvalidModelError);
  });
});

function baseInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "msg1",
    sessionID: "ses1",
    role: "assistant",
    parentID: "p1",
    modelID: "gpt-5.4",
    providerID: "openai",
    mode: "chat",
    agent: "chat",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { total: 10, input: 5, output: 5 },
    time: { created: 0, completed: 1 },
    ...overrides,
  };
}

describe("extractResponseContent", () => {
  // Regression test: with `format: { type: "json_schema" }`, OpenCode
  // returns the result on `info.structured` instead of as a text part, so
  // relying on parts alone silently produces an empty response even though
  // the model actually generated (and was billed for) output.
  test("prefers info.structured, stringified, over parts when present", () => {
    const info = baseInfo({ structured: { greeting: "hallo" } });
    expect(extractResponseContent(info, [])).toBe('{"greeting":"hallo"}');
  });

  test("falls back to text parts when structured is absent", () => {
    const info = baseInfo();
    expect(extractResponseContent(info, [{ id: "p1", type: "text", text: "hi there" }])).toBe("hi there");
  });

  test("structured: null is treated as absent, not a valid result", () => {
    const info = baseInfo({ structured: null });
    expect(extractResponseContent(info, [{ id: "p1", type: "text", text: "fallback text" }])).toBe("fallback text");
  });
});

describe("assistantMessageToOpenAIResponse", () => {
  test("message.content carries the stringified structured result", () => {
    const info = baseInfo({ structured: { greeting: "hallo" } });
    const response = assistantMessageToOpenAIResponse("openai/gpt-5.4", info, []);
    expect(response.choices[0]!.message.content).toBe('{"greeting":"hallo"}');
  });
});
