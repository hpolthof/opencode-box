import { describe, expect, test } from "bun:test";
import { NO_TOOLS } from "../src/opencode/client";

describe("NO_TOOLS", () => {
  test("disables every known OpenCode tool", () => {
    expect(NO_TOOLS).toEqual({
      question: false,
      bash: false,
      read: false,
      glob: false,
      grep: false,
      edit: false,
      write: false,
      task: false,
      webfetch: false,
      todowrite: false,
      websearch: false,
      skill: false,
      apply_patch: false,
    });
  });

  test("every value is false - a stray true would silently re-enable a tool", () => {
    expect(Object.values(NO_TOOLS).every((v) => v === false)).toBe(true);
  });
});
