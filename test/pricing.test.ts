import { describe, expect, test } from "bun:test";
import { estimateCost, formatCost, resolveModelRate } from "../src/pricing";

describe("resolveModelRate", () => {
  test("uses the model's own reported cost when non-zero", () => {
    const rate = resolveModelRate({ input: 3, output: 12 }, "openai/gpt-5.4");
    expect(rate).toEqual({ input: 3, output: 12, estimated: false });
  });

  test("falls back to the reference table when reported cost is {0,0}", () => {
    const rate = resolveModelRate({ input: 0, output: 0 }, "openai/gpt-5.4");
    expect(rate).toEqual({ input: 2.5, output: 15, estimated: true });
  });

  test("falls back to the reference table when reported cost is missing", () => {
    const rate = resolveModelRate(undefined, "openai/gpt-6-astra");
    expect(rate).toEqual({ input: 10, output: 50, estimated: true });
  });

  test("derives -fast variants as 2x the base model's reference rate", () => {
    const rate = resolveModelRate(undefined, "openai/gpt-5.6-luna-fast");
    expect(rate).toEqual({ input: 0.4, output: 2.4, estimated: true });
  });

  test("returns null when there's no reported cost and no reference entry", () => {
    expect(resolveModelRate(undefined, "openai/gpt-5.3-codex-spark")).toBeNull();
    expect(resolveModelRate(undefined, "opencode/some-free-model")).toBeNull();
  });
});

describe("estimateCost", () => {
  test("computes $ from $/1M rates and token counts", () => {
    const rate = { input: 2.5, output: 15, estimated: false };
    // 1,000,000 prompt tokens * $2.5/1M + 100,000 completion tokens * $15/1M
    expect(estimateCost(rate, 1_000_000, 100_000)).toBeCloseTo(2.5 + 1.5, 5);
  });

  test("treats null token counts as zero", () => {
    const rate = { input: 2.5, output: 15, estimated: false };
    expect(estimateCost(rate, null, null)).toBe(0);
  });

  test("returns null when there's no rate", () => {
    expect(estimateCost(null, 1000, 1000)).toBeNull();
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
