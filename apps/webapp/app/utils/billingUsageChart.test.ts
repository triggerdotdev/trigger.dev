import { describe, expect, it } from "vitest";
import {
  costDaySeries,
  fillMonthDays,
  includedUsageDollars,
  projectDaySeries,
  projectTotals,
  usageBarScale,
} from "./billingUsageChart";

const days = [
  {
    date: "2026-10-01",
    projects: [
      { projectId: "a", computeMs: 100, runs: 2 },
      { projectId: "b", computeMs: 50, runs: 5 },
    ],
  },
  { date: "2026-10-02", projects: [{ projectId: "a", computeMs: 10, runs: 1 }] },
];

describe("costDaySeries", () => {
  it("converts each day's total from minor units", () => {
    expect(costDaySeries([{ date: "2026-10-01", total: 1250 }], 100)).toEqual([
      { date: "2026-10-01", cost: 12.5 },
    ]);
  });
});

describe("projectDaySeries", () => {
  it("gives every listed project a value on every day", () => {
    expect(projectDaySeries(days, ["a", "b"], "computeMs")).toEqual([
      { date: "2026-10-01", a: 100, b: 50 },
      { date: "2026-10-02", a: 10, b: 0 },
    ]);
  });

  it("keeps only the selected projects and the chosen metric", () => {
    expect(projectDaySeries(days, ["b"], "runs")).toEqual([
      { date: "2026-10-01", b: 5 },
      { date: "2026-10-02", b: 0 },
    ]);
  });
});

describe("projectTotals", () => {
  it("sums compute time and runs per project across the month", () => {
    expect(Object.fromEntries(projectTotals(days))).toEqual({
      a: { computeMs: 110, runs: 3 },
      b: { computeMs: 50, runs: 5 },
    });
  });
});

describe("fillMonthDays", () => {
  it("adds an empty day for every date the API did not return", () => {
    const filled = fillMonthDays(
      [{ date: "2026-10-02", total: 5 }],
      ["2026-10-01", "2026-10-02", "2026-10-03"],
      (date) => ({ date, total: 0 })
    );

    expect(filled).toEqual([
      { date: "2026-10-01", total: 0 },
      { date: "2026-10-02", total: 5 },
      { date: "2026-10-03", total: 0 },
    ]);
  });

  it("matches days sent as full timestamps", () => {
    const filled = fillMonthDays(
      [{ date: "2026-10-01T00:00:00.000Z", total: 5 }],
      ["2026-10-01"],
      (date) => ({ date, total: 0 })
    );

    expect(filled[0].total).toBe(5);
  });
});

describe("includedUsageDollars", () => {
  const credits = [{ id: "c1" }, { id: "promo" }];

  it("uses Metronome's credit for usage in the month, in past months too", () => {
    expect(
      includedUsageDollars({ isCurrentMonth: false, creditsForUsage: 3661.29, credits }, 100, 50)
    ).toBeCloseTo(36.6129);
  });

  it("leaves out a goodwill credit that paid a fee instead of usage", () => {
    const withGoodwill = {
      isCurrentMonth: true,
      creditsGranted: 5161.29,
      creditsForUsage: 3661.29,
      credits,
    };

    expect(includedUsageDollars(withGoodwill, 100, 50)).toBeCloseTo(36.6129);
  });

  it("falls back to the plan allowance only for the current month without Metronome credits", () => {
    expect(includedUsageDollars({ isCurrentMonth: true, credits: [] }, 100, 50)).toBe(50);
    expect(includedUsageDollars({ isCurrentMonth: false }, 100, 50)).toBeUndefined();
  });
});

describe("usageBarScale", () => {
  it("places usage, included usage and the limit against the largest with headroom", () => {
    const scale = usageBarScale(50, 25, 100);

    expect(scale.limit).toBeCloseTo(100 / 1.08);
    expect(scale.used).toBeCloseTo(50 / 1.08);
    expect(scale.included).toBeCloseTo(25 / 1.08);
  });

  it("hides included usage that is missing or zero", () => {
    expect(usageBarScale(8, 0, undefined).included).toBeUndefined();
    expect(usageBarScale(8, undefined, undefined).included).toBeUndefined();
  });

  it("keeps an empty month at zero", () => {
    expect(usageBarScale(0, undefined, undefined)).toEqual({
      used: 0,
      included: undefined,
      limit: undefined,
    });
  });
});
