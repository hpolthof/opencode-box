import { describe, expect, test } from "bun:test";
import { InvalidModelError, parseModelId } from "../src/openai/translate";

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
