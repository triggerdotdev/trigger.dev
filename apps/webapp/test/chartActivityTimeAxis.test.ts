import { describe, expect, it } from "vitest";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function series(startISO: string, count: number, stepMs: number) {
  const start = new Date(startISO).getTime();
  return Array.from({ length: count }, (_, i) => ({ bucket: start + i * stepMs }));
}

describe("buildActivityTimeAxis", () => {
  it("shows seconds in labels for sub-minute buckets", () => {
    const data = series("2026-06-22T00:00:00.000Z", 6, 5 * SECOND); // 5s buckets, 25s span
    const { tickFormatter } = buildActivityTimeAxis(data);
    const label = tickFormatter(data[0].bucket);
    // HH:MM:SS -> two colons
    expect(label.split(":").length).toBe(3);
  });

  it("shows HH:MM (no seconds) for minute+ buckets within a day", () => {
    const data = series("2026-06-22T00:00:00.000Z", 12, 30 * MINUTE); // 30m buckets, 6h span
    const { tickFormatter } = buildActivityTimeAxis(data);
    const label = tickFormatter(data[0].bucket);
    expect(label.split(":").length).toBe(2);
  });

  it("shows the date for multi-day ranges", () => {
    const data = series("2026-06-20T00:00:00.000Z", 4, DAY); // 4 days
    const { tickFormatter } = buildActivityTimeAxis(data);
    const label = tickFormatter(data[0].bucket);
    // e.g. "Jun 20" — no time component
    expect(label).toMatch(/[A-Za-z]{3}\s+\d{1,2}/);
    expect(label).not.toContain(":");
  });

  it("formats labels in UTC", () => {
    const data = series("2026-06-22T13:30:00.000Z", 4, 15 * MINUTE);
    const { tickFormatter } = buildActivityTimeAxis(data);
    expect(tickFormatter(data[0].bucket)).toBe("13:30");
  });

  it("tooltip formatter reads the bucket from payload and includes date + time for sub-day buckets", () => {
    const data = series("2026-06-22T00:00:00.000Z", 12, 30 * MINUTE);
    const { tooltipLabelFormatter } = buildActivityTimeAxis(data);
    const label = tooltipLabelFormatter("", [{ payload: { bucket: data[0].bucket } }]);
    expect(label).toContain("Jun");
    expect(label).toContain(":");
  });

  it("tooltip formatter falls back to the raw label when no bucket is present", () => {
    const data = series("2026-06-22T00:00:00.000Z", 2, 30 * MINUTE);
    const { tooltipLabelFormatter } = buildActivityTimeAxis(data);
    expect(tooltipLabelFormatter("fallback", [{}])).toBe("fallback");
  });
});
