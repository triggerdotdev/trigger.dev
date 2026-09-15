import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ScheduleWindow,
  parseScheduleWindow,
  type ValidatedScheduleWindow,
} from "./scheduleWindow.js";

describe("ScheduleWindow", () => {
  it.each(["0m", "30m", "1440m", "0h", "2h", "24h", "0%", "30%", "100%"])(
    "accepts %s",
    (window) => {
      expect(ScheduleWindow.safeParse(window).success).toBe(true);
    }
  );

  it.each([
    "",
    "00m",
    "01m",
    "1.5h",
    "0d",
    "1d",
    "25h",
    "1441m",
    "30s",
    "-1m",
    "0.5%",
    "101%",
    "1e2%",
    " 30m",
    "30m ",
  ])("rejects %j", (window) => {
    expect(ScheduleWindow.safeParse(window).success).toBe(false);
  });

  it("reports percentages above 100% precisely", () => {
    expect(() => parseScheduleWindow("110%")).toThrow(
      "Schedule window percentage cannot exceed 100%"
    );
  });

  it("normalizes valid windows", () => {
    expect(parseScheduleWindow("30m")).toEqual({
      type: "duration",
      durationSeconds: 1_800,
    });
    expect(parseScheduleWindow("25%")).toEqual({
      type: "percentage",
      percentage: 25,
    });
  });

  it("validates literal types without rejecting runtime strings", () => {
    expectTypeOf<ValidatedScheduleWindow<"30m">>().toEqualTypeOf<"30m">();
    expectTypeOf<ValidatedScheduleWindow<"24h">>().toEqualTypeOf<"24h">();
    expectTypeOf<ValidatedScheduleWindow<"100%">>().toEqualTypeOf<"100%">();
    expectTypeOf<ValidatedScheduleWindow<string>>().toEqualTypeOf<string>();
    expectTypeOf<ValidatedScheduleWindow<undefined>>().toEqualTypeOf<undefined>();
    expectTypeOf<
      ValidatedScheduleWindow<"25h">
    >().toEqualTypeOf<"⛔ window duration cannot exceed 24 hours">();
    expectTypeOf<
      ValidatedScheduleWindow<"101%">
    >().toEqualTypeOf<"⛔ percentage cannot exceed 100%">();
    expectTypeOf<
      ValidatedScheduleWindow<"1d">
    >().toEqualTypeOf<'⛔ window must look like "30m", "2h", or "50%"'>();
  });
});
