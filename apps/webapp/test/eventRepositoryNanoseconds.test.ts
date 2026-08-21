import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateDurationFromStart,
  convertDateToNanoseconds,
  getNowInNanoseconds,
} from "~/v3/eventRepository/common.server";

const EPOCH_MS = 1_782_994_600_413;

describe("event repository nanosecond conversion", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("converts a date to nanoseconds without losing precision", () => {
    expect(convertDateToNanoseconds(new Date(EPOCH_MS))).toBe(1_782_994_600_413_000_000n);
  });

  it("returns the current time in exact nanoseconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(EPOCH_MS));

    expect(getNowInNanoseconds()).toBe(1_782_994_600_413_000_000n);
  });

  it("calculates an exact duration from a nanosecond start time", () => {
    const startTime = convertDateToNanoseconds(new Date(EPOCH_MS));

    expect(calculateDurationFromStart(startTime, new Date(EPOCH_MS + 2))).toBe(2_000_000);
  });
});
