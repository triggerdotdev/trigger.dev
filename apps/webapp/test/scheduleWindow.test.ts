import { describe, expect, it } from "vitest";
import {
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
});
