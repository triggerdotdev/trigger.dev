import { describe, expect, it } from "vitest";
import {
  type ActivityDay,
  gridWeeks,
  isCalendarDay,
  summarizeActivity,
} from "~/components/deployments/deployActivityDays";

const day = (day: string, deployed: number, failed = 0): ActivityDay => ({
  day,
  total: deployed + failed,
  deployed,
  failed,
});

describe("gridWeeks", () => {
  // Catches: weeks starting on Sunday, which splits the weekend across two columns.
  it("lays out 53 Monday-first weeks ending in today's week", () => {
    // 2026-11-20 is a Friday.
    const weeks = gridWeeks("2026-11-20");

    expect(weeks).toHaveLength(53);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]).toEqual([
      "2025-11-17",
      "2025-11-18",
      "2025-11-19",
      "2025-11-20",
      "2025-11-21",
      "2025-11-22",
      "2025-11-23",
    ]);
    expect(weeks[52]).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      null,
      null,
    ]);
  });

  it("starts a new column on a Monday and fills it by Sunday", () => {
    expect(gridWeeks("2026-11-16", 2)).toEqual([
      [
        "2026-11-09",
        "2026-11-10",
        "2026-11-11",
        "2026-11-12",
        "2026-11-13",
        "2026-11-14",
        "2026-11-15",
      ],
      ["2026-11-16", null, null, null, null, null, null],
    ]);
    expect(gridWeeks("2026-11-22", 1)[0]).not.toContain(null);
  });

  it("crosses a leap day and a year boundary", () => {
    const days = gridWeeks("2024-03-03").flat();
    expect(days).toContain("2024-02-29");
    expect(days).toContain("2023-12-31");
    expect(new Set(days).size).toBe(days.length);
  });
});

describe("summarizeActivity", () => {
  // Catches: the heading counting deploys the grid has no square for.
  it("counts only the days the grid shows", () => {
    const summary = summarizeActivity("2026-11-20", [
      day("2025-11-16", 5, 1), // the day before the first column
      day("2025-11-17", 2),
      day("2026-11-20", 1, 2),
      day("2026-11-21", 9), // after today
    ]);

    expect(summary).toMatchObject({ total: 5, deployed: 3, failed: 2, weeks: 53, activeWeeks: 2 });
  });

  it("finds the longest stretch with nothing going live, up to today", () => {
    const summary = summarizeActivity("2026-11-20", [
      day("2026-10-01", 1),
      day("2026-10-05", 0, 3), // failures only: still a day without a deploy going live
      day("2026-10-20", 2),
      day("2026-11-01", 1),
    ]);

    expect(summary.longestGap).toEqual({ from: "2026-11-02", to: "2026-11-20", days: 19 });
  });

  it("has no gap when nothing went live", () => {
    expect(summarizeActivity("2026-11-20", [day("2026-11-19", 0, 1)]).longestGap).toBeUndefined();
    expect(summarizeActivity("2026-11-20", [day("2026-11-20", 1)]).longestGap).toBeUndefined();
  });

  it("follows a narrower grid", () => {
    const summary = summarizeActivity(
      "2026-11-20",
      [day("2026-11-01", 4), day("2026-11-18", 1)],
      2
    );
    expect(summary).toMatchObject({ total: 1, weeks: 2, activeWeeks: 1 });
  });
});

describe("isCalendarDay", () => {
  // Catches: a day the database can't hold failing the request.
  it("accepts only real days written YYYY-MM-DD", () => {
    expect(isCalendarDay("2026-11-20")).toBe(true);
    expect(isCalendarDay("2024-02-29")).toBe(true);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("2026-02-31")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
    // The database has no year 0.
    expect(isCalendarDay("0000-01-01")).toBe(false);
    expect(isCalendarDay("1969-12-31")).toBe(false);
    expect(isCalendarDay("1970-01-01")).toBe(true);
    expect(isCalendarDay("2026-1-1")).toBe(false);
    expect(isCalendarDay("2026-11-20T00:00:00Z")).toBe(false);
    expect(isCalendarDay("")).toBe(false);
  });
});
