import { describe, expect, it } from "vitest";
import {
  FREE_SCHEDULE_MINIMUM_WINDOW_SECONDS,
  validateMinimumCronInterval,
} from "~/v3/validateMinimumCronInterval";

const HOUR_MS = FREE_SCHEDULE_MINIMUM_WINDOW_SECONDS * 1_000;

describe("validateMinimumCronInterval", () => {
  it.each([
    ["* * * * *", "every minute"],
    ["*/5 * * * *", "every five minutes"],
    ["0,30 * * * *", "twice an hour"],
    ["0,20,40 * * * *", "three times an hour"],
  ])("rejects sub-hourly cron %s (%s)", (cron) => {
    const result = validateMinimumCronInterval({ cron, minimumMs: HOUR_MS });
    expect(result.valid).toBe(false);
  });

  it.each([
    ["0 * * * *", "hourly"],
    ["30 * * * *", "hourly at :30"],
    ["0 */2 * * *", "every two hours"],
    ["0 9,10 * * *", "gap exactly 60 minutes"],
    ["0 9 * * 1-5", "weekdays at 9am"],
    ["0 0 * * *", "daily"],
    ["0 0 1 * *", "monthly"],
  ])("accepts cron %s (%s)", (cron) => {
    const result = validateMinimumCronInterval({ cron, minimumMs: HOUR_MS });
    expect(result.valid).toBe(true);
  });

  it("checks nominal cadence rather than timezone DST transitions", () => {
    const result = validateMinimumCronInterval({
      cron: "30 * * * *",
      timezone: "Australia/Lord_Howe",
      minimumMs: HOUR_MS,
    });
    expect(result.valid).toBe(true);
  });

  it("reports the smallest offending nominal gap", () => {
    const result = validateMinimumCronInterval({ cron: "*/5 * * * *", minimumMs: HOUR_MS });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.smallestGapMs).toBe(5 * 60_000);
      expect(result.message).toContain("5 minutes");
    }
  });

  it("accepts a gap exactly equal to the minimum", () => {
    // 09:00 and 10:00 daily → a 60-minute adjacent gap (and a 23-hour gap), never below the floor.
    const result = validateMinimumCronInterval({ cron: "0 9,10 * * *", minimumMs: HOUR_MS });
    expect(result.valid).toBe(true);
  });
});
