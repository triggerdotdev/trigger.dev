import { describe, expect, it } from "vitest";
import { clampPriorityMs } from "./priority";

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

describe("clampPriorityMs", () => {
  it("converts seconds to milliseconds for in-range values", () => {
    expect(clampPriorityMs(10)).toBe(10_000);
    expect(clampPriorityMs(0.5)).toBe(500);
  });

  it("rounds a sub-millisecond fractional priority to an integer", () => {
    expect(clampPriorityMs(0.0005)).toBe(1);
    expect(clampPriorityMs(0.00049)).toBe(0);
    expect(Number.isInteger(clampPriorityMs(0.0005))).toBe(true);
  });

  it("clamps a value that would overflow INT4 down to the column max", () => {
    const priority = 31_536_000;
    expect(priority * 1_000).toBeGreaterThan(INT4_MAX);
    expect(clampPriorityMs(priority)).toBe(INT4_MAX);
  });

  it("leaves the largest safe priority untouched", () => {
    expect(clampPriorityMs(2_147_483)).toBe(2_147_483_000);
  });

  it("clamps a large negative priority to the column min", () => {
    expect(clampPriorityMs(-3_000_000)).toBe(INT4_MIN);
  });

  it("keeps every result inside the INT4 range", () => {
    for (const priority of [-1e12, -5, -0.3, 0, 0.7, 5, 1234.5678, 1e12]) {
      const result = clampPriorityMs(priority);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(INT4_MIN);
      expect(result).toBeLessThanOrEqual(INT4_MAX);
    }
  });
});
