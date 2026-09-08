import { SCHEDULE_PHASE_DENOMINATOR } from "@internal/schedule-engine";
import { describe, expect, it } from "vitest";
import {
  calculateNextScheduleRunTimes,
  formatResolvedScheduleWindow,
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

  it("formatScheduleWindow shows only the configured value, ignoring a captured default", () => {
    // The edit form must render blank so the captured default surfaces via placeholder copy.
    expect(
      formatScheduleWindow({ windowDurationSeconds: null, windowPercentage: null })
    ).toBeUndefined();
  });

  it("formatResolvedScheduleWindow falls back to the captured default", () => {
    expect(
      formatResolvedScheduleWindow({
        windowDurationSeconds: null,
        windowPercentage: null,
        defaultWindowDurationSeconds: 3_600,
      })
      // 3600s canonicalizes to "1h", exactly as an explicit "60m" would.
    ).toEqual({ window: "1h", source: "schedule_default" });

    expect(
      formatResolvedScheduleWindow({
        windowDurationSeconds: 900,
        windowPercentage: null,
        defaultWindowDurationSeconds: 3_600,
      })
    ).toEqual({ window: "15m", source: "explicit" });

    expect(
      formatResolvedScheduleWindow({
        windowDurationSeconds: 0,
        windowPercentage: null,
        defaultWindowDurationSeconds: 3_600,
      })
    ).toEqual({ window: "0m", source: "explicit" });

    expect(
      formatResolvedScheduleWindow({
        windowDurationSeconds: null,
        windowPercentage: null,
        defaultWindowDurationSeconds: null,
      })
    ).toEqual({ window: undefined, source: undefined });
  });

  it("applies the captured default when resolving run times for an omitted window", () => {
    const from = new Date("2026-08-11T09:59:00.000Z");
    const base = {
      cron: "0 * * * *",
      timezone: "UTC",
      deduplicationKey: "hourly-task",
      environmentId: "env_123",
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      phaseSecret: "test-secret",
      windowDurationSeconds: null,
      windowPercentage: null,
      from,
    };

    // With no default the hourly schedule only gets the 60-second minimum spread.
    const [grandfathered] = calculateNextScheduleRunTimes(base);
    expect(grandfathered.effectiveAt).toEqual(new Date("2026-08-11T10:00:30.000Z"));

    // A captured 60m default spreads the same occurrence across the full hour.
    const [defaulted] = calculateNextScheduleRunTimes({
      ...base,
      defaultWindowDurationSeconds: 3_600,
    });
    expect(defaulted.effectiveAt).toEqual(new Date("2026-08-11T10:30:00.000Z"));
  });

  it("applies a persisted policy minimum to a windowless hourly schedule", () => {
    const [first] = calculateNextScheduleRunTimes({
      cron: "0 * * * *",
      timezone: "UTC",
      deduplicationKey: "hourly-task",
      environmentId: "env_123",
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 2,
      phaseSecret: "test-secret",
      windowDurationSeconds: null,
      windowPercentage: null,
      minimumWindowDurationSeconds: 3_600,
      from: new Date("2026-08-11T09:30:00.000Z"),
    });

    // Half phase over a 60-minute floor spreads the effective time to the middle of the hour.
    expect(first).toEqual({
      nominalAt: new Date("2026-08-11T10:00:00.000Z"),
      effectiveAt: new Date("2026-08-11T10:30:00.000Z"),
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
