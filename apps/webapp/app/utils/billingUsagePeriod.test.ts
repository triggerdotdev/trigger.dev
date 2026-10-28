import { describe, expect, it } from "vitest";
import {
  adjacentUsageMonths,
  daysInUsageMonth,
  formatCreditPeriod,
  formatUsageMonth,
  resolveUsageMonth,
  usageMonths,
} from "./billingUsagePeriod";

const now = new Date("2026-10-16T12:00:00Z");

describe("usageMonths", () => {
  it("lists the last six months, newest first", () => {
    expect(usageMonths(now)).toEqual([
      "2026-10",
      "2026-09",
      "2026-08",
      "2026-07",
      "2026-06",
      "2026-05",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(usageMonths(new Date("2027-01-03T00:00:00Z"), 3)).toEqual([
      "2027-01",
      "2026-12",
      "2026-11",
    ]);
  });
});

describe("resolveUsageMonth", () => {
  const months = usageMonths(now);

  it("uses a listed month from the URL", () => {
    expect(resolveUsageMonth("2026-07", months)).toBe("2026-07");
  });

  it("falls back to the current month for a missing or unlisted month", () => {
    expect(resolveUsageMonth(undefined, months)).toBe("2026-10");
    expect(resolveUsageMonth("2025-01", months)).toBe("2026-10");
  });
});

describe("adjacentUsageMonths", () => {
  const months = usageMonths(now);

  it("returns the older and newer neighbours", () => {
    expect(adjacentUsageMonths("2026-08", months)).toEqual({
      previous: "2026-07",
      next: "2026-09",
    });
  });

  it("has no next month for the current month and no previous for the oldest", () => {
    expect(adjacentUsageMonths("2026-10", months).next).toBeUndefined();
    expect(adjacentUsageMonths("2026-05", months).previous).toBeUndefined();
  });
});

describe("formatCreditPeriod", () => {
  it("shows the last day covered, not the exclusive end", () => {
    expect(formatCreditPeriod("2026-10-15T12:00:00Z", "2026-11-01T00:00:00Z")).toBe(
      "Oct 15 – Oct 31"
    );
  });

  it("adds years when the period crosses one, and handles an open end", () => {
    expect(formatCreditPeriod("2026-10-26T15:00:00Z", "2031-10-26T15:00:00Z")).toBe(
      "Oct 26, 2026 – Oct 26, 2031"
    );
    expect(formatCreditPeriod("2026-10-01T00:00:00Z", null)).toBe("From Oct 1, 2026");
  });
});

describe("formatUsageMonth", () => {
  it("names the month in UTC", () => {
    expect(formatUsageMonth("2026-02")).toBe("February 2026");
  });
});

describe("daysInUsageMonth", () => {
  it("lists every day of the month, leap years included", () => {
    const days = daysInUsageMonth("2028-02");
    expect(days).toHaveLength(29);
    expect(days[0]).toBe("2028-02-01");
    expect(days[28]).toBe("2028-02-29");
  });
});
