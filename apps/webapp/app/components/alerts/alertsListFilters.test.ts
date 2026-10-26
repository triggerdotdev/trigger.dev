import { describe, expect, it } from "vitest";
import {
  filterAlertRows,
  isWithinPeriod,
  matchesAreas,
  parseAlertsListSearchParams,
  serializeAlertsListFilters,
} from "./alertsListFilters";
import { AREA_OPTIONS } from "./AlertsList";
import type { AlertListRow } from "~/presenters/v3/alertListRow";

const NOW = Date.parse("2026-01-20T12:00:00Z");
const thirteenDaysAgo = new Date(NOW - 13 * 24 * 60 * 60 * 1000);

describe("isWithinPeriod", () => {
  it("excludes rows older than the period", () => {
    expect(isWithinPeriod(thirteenDaysAgo, "7d", NOW)).toBe(false);
    expect(isWithinPeriod(thirteenDaysAgo.toISOString(), "7d", NOW)).toBe(false);
  });

  it("includes rows within the period or with no period", () => {
    expect(isWithinPeriod(thirteenDaysAgo, "14d", NOW)).toBe(true);
    expect(isWithinPeriod(thirteenDaysAgo, undefined, NOW)).toBe(true);
  });
});

describe("unknown area", () => {
  it("is offered as a filter option", () => {
    expect(AREA_OPTIONS).toContainEqual({ value: "unknown", label: "Unknown" });
  });

  it("matches unknown capabilities only when selected", () => {
    expect(matchesAreas("weird.capability", ["unknown"])).toBe(true);
    expect(matchesAreas("weird.capability", ["queues"])).toBe(false);
    expect(matchesAreas("queues", ["unknown"])).toBe(false);
    expect(matchesAreas("weird.capability", [])).toBe(true);
  });
});

describe("alerts list search params", () => {
  it("parses comma-separated lists and period", () => {
    const parsed = parseAlertsListSearchParams(
      new URLSearchParams("statuses=active,inactive&areas=queues,unknown&period=30d")
    );
    expect(parsed).toEqual({
      statuses: ["active", "inactive"],
      areas: ["queues", "unknown"],
      period: "30d",
    });
  });

  it("falls back to defaults when absent", () => {
    expect(parseAlertsListSearchParams(new URLSearchParams(""))).toEqual({
      statuses: [],
      areas: [],
      period: "7d",
    });
  });

  it("ignores an unparseable period", () => {
    expect(parseAlertsListSearchParams(new URLSearchParams("period=foo")).period).toBe("7d");
  });

  it("serializes cleared filters and all-time period", () => {
    expect(
      serializeAlertsListFilters({ statuses: [], areas: ["runs", "health"], period: "7d" })
    ).toEqual({ statuses: undefined, areas: "runs,health", period: undefined });
    const all = serializeAlertsListFilters({ period: undefined });
    expect(all).toEqual({ period: "all" });
    expect(
      parseAlertsListSearchParams(new URLSearchParams(`period=${all.period}`)).period
    ).toBeUndefined();
  });
});

describe("custom range", () => {
  it("round-trips from/to through serialize and parse", () => {
    const out = serializeAlertsListFilters({ period: undefined, from: "1000", to: "2000" });
    expect(out).toEqual({ period: undefined, from: "1000", to: "2000" });
    const parsed = parseAlertsListSearchParams(
      new URLSearchParams(`from=${out.from}&to=${out.to}`)
    );
    expect(parsed).toMatchObject({ period: undefined, from: 1000, to: 2000 });
  });

  it("clears from/to when a period is chosen", () => {
    expect(serializeAlertsListFilters({ period: "30d" })).toEqual({
      period: "30d",
      from: undefined,
      to: undefined,
    });
  });
});

describe("filterAlertRows", () => {
  const row = (id: string, lastEventAt: Date | null, lastActivityAt: Date): AlertListRow => ({
    id,
    name: id,
    area: "queues",
    conditionSummary: "",
    capabilityKey: "queue.depth",
    capabilityTitle: "Queue depth",
    environmentId: "env_1",
    scope: { type: "all" },
    status: "active",
    lastEventAt,
    notifierCount: 0,
    expiresAt: null,
    lastActivityAt,
  });
  const filters = { search: "", statuses: [], areas: [], period: "7d" as string | undefined };
  const twoMinutesAgo = new Date(NOW - 2 * 60 * 1000);

  it("drops rows whose last activity is outside the period", () => {
    const rows = [row("old", null, thirteenDaysAgo), row("new", null, twoMinutesAgo)];
    expect(filterAlertRows(rows, filters, NOW).map((r) => r.id)).toEqual(["new"]);
    expect(filterAlertRows(rows, { ...filters, period: undefined }, NOW)).toHaveLength(2);
  });

  it("filters rows by a custom from/to range", () => {
    const rows = [row("old", null, thirteenDaysAgo), row("new", null, twoMinutesAgo)];
    const range = { ...filters, period: undefined };
    const ids = (f: object) => filterAlertRows(rows, { ...range, ...f }, NOW).map((r) => r.id);
    expect(ids({ from: NOW - 14 * 86_400_000, to: NOW - 7 * 86_400_000 })).toEqual(["old"]);
    expect(ids({ from: NOW - 5 * 60_000 })).toEqual(["new"]);
    expect(ids({ to: NOW })).toHaveLength(2);
  });

  it("keys the period on the last event when present", () => {
    const rows = [row("fired", twoMinutesAgo, thirteenDaysAgo)];
    expect(filterAlertRows(rows, filters, NOW).map((r) => r.id)).toEqual(["fired"]);
  });
});
