import { describe, expect, it } from "vitest";
import { auditLogSummaryRange } from "~/components/auditLogs/AuditLogCredentialSummary";
import { timeFilterRenderValues } from "~/components/runs/v3/SharedFilters";

// The label in front of the credential summary: the time range it covers, worded as the page's time
// filter shows it, so "First seen" isn't read as the first use ever.

describe("audit log summary range label", () => {
  // Catches: a period worded differently from the time filter, or the default period unlabelled.
  it("names a period as the time filter does", () => {
    expect(auditLogSummaryRange("")).toEqual({ text: "Last 7 days", value: null });
    expect(auditLogSummaryRange("credential=key%3Ak1&period=7d")).toEqual({
      text: "Last 7 days",
      value: null,
    });
    expect(auditLogSummaryRange("period=30d").text).toBe("Last 30 days");
    expect(auditLogSummaryRange("period=1d").text).toBe("Last 1 day");
    expect(auditLogSummaryRange("period=90m").text).toBe("Last 90 minutes");
  });

  // Catches: a custom range, or an open-ended one, shown other than as the time filter shows it.
  it("shows a custom range, or its one end, as the time filter does", () => {
    const from = "2026-11-12T00:00:00.000Z";
    const to = "2026-11-19T00:00:00.000Z";
    const filter = (range: { from?: Date; to?: Date }) =>
      timeFilterRenderValues({ ...range, labelName: "Occurred" });

    expect(auditLogSummaryRange(new URLSearchParams({ from, to }).toString())).toEqual({
      text: null,
      value: filter({ from: new Date(from), to: new Date(to) }).valueLabel,
    });
    expect(auditLogSummaryRange(new URLSearchParams({ from }).toString())).toEqual({
      text: "Occurred after",
      value: filter({ from: new Date(from) }).valueLabel,
    });
    expect(auditLogSummaryRange(new URLSearchParams({ to }).toString())).toEqual({
      text: "Occurred before",
      value: filter({ to: new Date(to) }).valueLabel,
    });
  });
});
