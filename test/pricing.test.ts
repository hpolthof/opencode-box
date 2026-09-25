import { describe, expect, test } from "bun:test";
import { estimateCost, formatCost, resolveModelRate } from "../src/pricing";

describe("resolveModelRate", () => {
  test("uses the model's own reported cost when non-zero", () => {
    const rate = resolveModelRate({ input: 3, output: 12, cache: { read: 0.3, write: 3.75 } }, "openai/gpt-5.4");
    expect(rate).toEqual({ input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3.75, estimated: false });
  });

  test("reported cost without cache pricing bills cached input at the input rate", () => {
    const rate = resolveModelRate({ input: 3, output: 12, cache: { read: 0, write: 0 } }, "some/model");
    expect(rate).toEqual({ input: 3, output: 12, cacheRead: 3, cacheWrite: 3, estimated: false });
  });

  test("falls back to the reference table when reported cost is {0,0}", () => {
    const rate = resolveModelRate({ input: 0, output: 0 }, "openai/gpt-5.4");
    expect(rate).toEqual({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5, estimated: true });
  });

  test("falls back to the reference table when reported cost is missing", () => {
    const rate = resolveModelRate(undefined, "openai/gpt-6-astra");
    expect(rate).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, estimated: true });
  });

  test("derives -fast variants as 2x the base model's reference rate", () => {
    const rate = resolveModelRate(undefined, "openai/gpt-5.6-luna-fast");
    expect(rate).toEqual({ input: 0.4, output: 2.4, cacheRead: 0.04, cacheWrite: 0.5, estimated: true });
  });

  test("returns null when there's no reported cost and no reference entry", () => {
    expect(resolveModelRate(undefined, "openai/gpt-5.3-codex-spark")).toBeNull();
    expect(resolveModelRate(undefined, "opencode/some-free-model")).toBeNull();
  });
});

describe("estimateCost", () => {
  const rate = { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3, estimated: false };

  test("computes $ from $/1M rates and token counts", () => {
    // 1,000,000 prompt tokens * $2.5/1M + 100,000 completion tokens * $15/1M
    expect(estimateCost(rate, { promptTokens: 1_000_000, completionTokens: 100_000 })).toBeCloseTo(2.5 + 1.5, 5);
  });

  test("bills cached prompt tokens at the cache rates, the rest at the input rate", () => {
    // 1M prompt = 600K cache read + 100K cache write + 300K uncached
    const cost = estimateCost(rate, { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 600_000, cacheWriteTokens: 100_000 });
    expect(cost).toBeCloseTo(0.6 * 0.25 + 0.1 * 3 + 0.3 * 2.5, 5);
  });

  test("treats null token counts as zero", () => {
    expect(estimateCost(rate, { promptTokens: null, completionTokens: null, cacheReadTokens: null })).toBe(0);
  });

  test("returns null when there's no rate", () => {
    expect(estimateCost(null, { promptTokens: 1000, completionTokens: 1000 })).toBeNull();
  });
});

describe("formatCost", () => {
  test("formats null as a dash", () => {
    expect(formatCost(null)).toBe("-");
  });

  test("formats exact zero", () => {
    expect(formatCost(0)).toBe("$0.00000");
  });

  test("formats sub-cent amounts to 5 decimals instead of rounding away to zero", () => {
    expect(formatCost(0.0042)).toBe("$0.00420");
  });

  test("formats normal amounts to 5 decimals", () => {
    expect(formatCost(1.239)).toBe("$1.23900");
  });
});
