import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateDurationFromStart,
  convertDateToNanoseconds,
  getNowInNanoseconds,
} from "~/v3/eventRepository/common.server";

// 1700000000001 * 1e6 is not representable as a double (spacing is 256 at ~1.7e18),
// so Number multiplication before BigInt conversion rounds it to ...000999936.
const unsafeMs = 1_700_000_000_001;
const unsafeNs = 1_700_000_000_001_000_000n;

describe("eventRepository nanosecond conversions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("convertDateToNanoseconds keeps exact precision beyond MAX_SAFE_INTEGER", () => {
    expect(convertDateToNanoseconds(new Date(unsafeMs))).toBe(unsafeNs);
  });

  it("getNowInNanoseconds keeps exact precision beyond MAX_SAFE_INTEGER", () => {
    vi.useFakeTimers();
    vi.setSystemTime(unsafeMs);

    expect(getNowInNanoseconds()).toBe(unsafeNs);
    expect(getNowInNanoseconds() % 1_000_000n).toBe(0n);
  });

  it("calculateDurationFromStart is exact for sub-millisecond-sensitive end times", () => {
    const startTime = convertDateToNanoseconds(new Date(unsafeMs - 1));

    expect(calculateDurationFromStart(startTime, new Date(unsafeMs))).toBe(1_000_000);
  });

  it("calculateDurationFromStart applies the minimum duration", () => {
    const startTime = convertDateToNanoseconds(new Date(unsafeMs - 1));

    expect(calculateDurationFromStart(startTime, new Date(unsafeMs), 5_000_000)).toBe(5_000_000);
  });
});
