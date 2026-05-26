import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateDurationFromStart,
  convertDateToNanoseconds,
  getNowInNanoseconds,
} from "~/v3/eventRepository/common.server";

describe("event repository nanosecond conversion", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("converts epoch milliseconds to nanoseconds after BigInt conversion", () => {
    const date = new Date(1_700_000_000_001);

    expect(convertDateToNanoseconds(date)).toBe(1_700_000_000_001_000_000n);
  });

  it("uses precise nanosecond conversion for current time and durations", () => {
    const startTime = convertDateToNanoseconds(new Date(1_700_000_000_001));
    const endTime = new Date(1_700_000_000_003);

    vi.useFakeTimers();
    vi.setSystemTime(endTime);

    expect(getNowInNanoseconds()).toBe(1_700_000_000_003_000_000n);
    expect(calculateDurationFromStart(startTime)).toBe(2_000_000);
  });
});
