import { describe, expect, it } from "vitest";
import { calculateDurationFromStart } from "./common.server";

describe("calculateDurationFromStart", () => {
  it("converts to nanoseconds with exact BigInt math", () => {
    // 1754000000001 is one of the ~0.2% of epoch-ms where Number(ms * 1_000_000)
    // rounds (ms * 1e6 exceeds Number.MAX_SAFE_INTEGER). The duration from the
    // exact nanoseconds of the previous whole millisecond must be exactly 1ms.
    const startTime = BigInt(1754000000000) * BigInt(1_000_000);
    const endTime = new Date(1754000000001);
    expect(calculateDurationFromStart(startTime, endTime)).toBe(1_000_000);
  });
});
