import { describe, expect, it } from "vitest";
import { BAR_Y_AXIS_DOMAIN } from "./ChartBar";

const [lower, upper] = BAR_Y_AXIS_DOMAIN;

describe("bar y-axis domain", () => {
  it("keeps zero as the baseline for non-negative data", () => {
    expect(lower(4)).toBe(0);
    expect(upper(4)).toBeCloseTo(4 * 1.15);
    // A single value still has a visible bar.
    expect(upper(4)).toBeGreaterThan(4);
  });

  it("extends below zero for mixed data", () => {
    expect(lower(-2)).toBeCloseTo(-2 * 1.15);
    expect(upper(6)).toBeCloseTo(6 * 1.15);
  });

  it("stops at zero when every value is negative", () => {
    expect(lower(-5)).toBeCloseTo(-5 * 1.15);
    expect(upper(-1)).toBe(0);
  });
});
