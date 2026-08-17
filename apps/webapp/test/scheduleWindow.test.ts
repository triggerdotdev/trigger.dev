import { SCHEDULE_PHASE_DENOMINATOR } from "@internal/schedule-engine";
import { describe, expect, it } from "vitest";
import {
  calculateNextScheduleRunTimes,
  formatScheduleWindow,
  normalizeScheduleWindow,
  validateScheduleWindowSyntax,
} from "~/v3/scheduleWindow.server";

describe("schedule window persistence", () => {
  it("normalizes duration and percentage windows", () => {
    expect(normalizeScheduleWindow("30m")).toEqual({
      windowDurationSeconds: 1_800,
      windowPercentage: null,
    });
    expect(normalizeScheduleWindow("0m")).toEqual({
      windowDurationSeconds: 0,
      windowPercentage: null,
    });
    expect(normalizeScheduleWindow("30%")).toEqual({
      windowDurationSeconds: null,
      windowPercentage: 30,
    });
    expect(normalizeScheduleWindow(undefined)).toEqual({
      windowDurationSeconds: null,
      windowPercentage: null,
    });
  });

  it("formats stored windows canonically", () => {
    expect(
      formatScheduleWindow({
        windowDurationSeconds: 0,
        windowPercentage: null,
      })
    ).toBe("0m");
    expect(
      formatScheduleWindow({
        windowDurationSeconds: 86_400,
        windowPercentage: null,
      })
    ).toBe("24h");
    expect(
      formatScheduleWindow({
        windowDurationSeconds: 7_200,
        windowPercentage: null,
      })
    ).toBe("2h");
    expect(
      formatScheduleWindow({
        windowDurationSeconds: null,
        windowPercentage: 30,
      })
    ).toBe("30%");
  });

  it.each(["30.5%", "1d", "25h"])(
    "rejects invalid syntax through the authoritative timing parser: %s",
    (window) => {
      expect(validateScheduleWindowSyntax(window)).toMatchObject({ valid: false });
    }
  );

  it("accepts an absolute window independently of the cron interval", () => {
    expect(validateScheduleWindowSyntax("30m")).toEqual({ valid: true });
  });

  it("calculates stable nominal and effective times", () => {
    const [first, second] = calculateNextScheduleRunTimes({
      cron: "*/5 * * * *",
      timezone: "UTC",
      deduplicationKey: "five-minute-task",
      environmentId: "env_123",
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      phaseSecret: "test-secret",
      windowDurationSeconds: null,
      windowPercentage: 30,
      from: new Date("2026-08-11T09:59:00.000Z"),
      count: 2,
    });

    expect(first).toEqual({
      nominalAt: new Date("2026-08-11T10:00:00.000Z"),
      effectiveAt: new Date("2026-08-11T10:00:45.000Z"),
    });
    expect(second).toEqual({
      nominalAt: new Date("2026-08-11T10:05:00.000Z"),
      effectiveAt: new Date("2026-08-11T10:05:45.000Z"),
    });
  });

  it("derives a stable phase when one has not been persisted", () => {
    const input = {
      cron: "0 * * * *",
      timezone: "UTC",
      deduplicationKey: "hourly-task",
      environmentId: "env_123",
      schedulePhase: null,
      phaseSecret: "test-secret",
      windowDurationSeconds: null,
      windowPercentage: null,
      from: new Date("2026-08-11T09:59:00.000Z"),
    };

    expect(calculateNextScheduleRunTimes(input)).toEqual(calculateNextScheduleRunTimes(input));
    expect(calculateNextScheduleRunTimes(input)[0].effectiveAt.getTime()).toBeGreaterThanOrEqual(
      calculateNextScheduleRunTimes(input)[0].nominalAt.getTime()
    );
  });
});
