import { describe, expect, it } from "vitest";
import {
  formatScheduleWindow,
  normalizeScheduleWindow,
  validateScheduleWindowAgainstCron,
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
    ).toBe("1d");
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

  it("rejects invalid syntax through the authoritative timing parser", () => {
    expect(
      validateScheduleWindowAgainstCron({
        window: "30.5%",
        cron: "0 * * * *",
        timezone: "UTC",
      })
    ).toMatchObject({ valid: false });
  });

  it("rejects an absolute window longer than the next nominal interval", () => {
    expect(
      validateScheduleWindowAgainstCron({
        window: "30m",
        cron: "*/5 * * * *",
        timezone: "UTC",
      })
    ).toMatchObject({ valid: false });

    expect(
      validateScheduleWindowAgainstCron({
        window: "5m",
        cron: "*/5 * * * *",
        timezone: "UTC",
      })
    ).toEqual({ valid: true });
  });
});
