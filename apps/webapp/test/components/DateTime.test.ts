import { describe, it, expect } from "vitest";
import { formatDateTimeISO, formatUtcOffset } from "~/components/primitives/DateTime";

describe("formatDateTimeISO", () => {
  it("should format UTC dates with Z suffix", () => {
    const date = new Date("2025-04-29T14:01:19.000Z");
    const result = formatDateTimeISO(date, "UTC");
    expect(result).toBe("2025-04-29T14:01:19.000Z");
  });

  describe("British Time (Europe/London)", () => {
    it("should format with +01:00 during BST (summer)", () => {
      // BST - British Summer Time (last Sunday in March to last Sunday in October)
      const summerDate = new Date("2025-07-15T14:01:19.000Z");
      const result = formatDateTimeISO(summerDate, "Europe/London");
      expect(result).toBe("2025-07-15T15:01:19.000+01:00");
    });

    it("should format with +00:00 during GMT (winter)", () => {
      // GMT - Greenwich Mean Time (winter)
      const winterDate = new Date("2025-01-15T14:01:19.000Z");
      const result = formatDateTimeISO(winterDate, "Europe/London");
      expect(result).toBe("2025-01-15T14:01:19.000+00:00");
    });
  });

  describe("US Pacific Time (America/Los_Angeles)", () => {
    it("should format with -07:00 during PDT (summer)", () => {
      // PDT - Pacific Daylight Time (second Sunday in March to first Sunday in November)
      const summerDate = new Date("2025-07-15T14:01:19.000Z");
      const result = formatDateTimeISO(summerDate, "America/Los_Angeles");
      expect(result).toBe("2025-07-15T07:01:19.000-07:00");
    });

    it("should format with -08:00 during PST (winter)", () => {
      // PST - Pacific Standard Time (winter)
      const winterDate = new Date("2025-01-15T14:01:19.000Z");
      const result = formatDateTimeISO(winterDate, "America/Los_Angeles");
      expect(result).toBe("2025-01-15T06:01:19.000-08:00");
    });
  });

  it("should preserve milliseconds", () => {
    const date = new Date("2025-04-29T14:01:19.123Z");
    const result = formatDateTimeISO(date, "UTC");
    expect(result).toBe("2025-04-29T14:01:19.123Z");
  });

  it("should preserve milliseconds, not UTC", () => {
    const date = new Date("2025-04-29T14:01:19.123Z");
    const result = formatDateTimeISO(date, "Europe/London");
    expect(result).toBe("2025-04-29T15:01:19.123+01:00");
  });
});

describe("formatUtcOffset", () => {
  const date = new Date("2026-06-30T13:16:26.000Z");

  it("returns an empty string for UTC", () => {
    expect(formatUtcOffset(date, "UTC")).toBe("");
  });

  it("returns an empty offset for UTC-equivalent zones", () => {
    expect(formatUtcOffset(date, "Atlantic/Reykjavik")).toBe("(UTC +0)");
  });

  // The reported bug: the offset label must reflect the displayed timezone, not the
  // viewer's machine. A viewer on a UTC machine looking at a UTC+3 zone must see +3.
  it("reflects the timezone being displayed, not the viewer's machine", () => {
    expect(formatUtcOffset(date, "Europe/Moscow")).toBe("(UTC +3)");
  });

  it("formats half-hour offsets", () => {
    expect(formatUtcOffset(date, "Asia/Kolkata")).toBe("(UTC +5:30)");
  });

  it("formats negative offsets", () => {
    expect(formatUtcOffset(date, "America/Los_Angeles")).toBe("(UTC -7)");
  });

  // The offset is derived from the given instant, so it stays correct across DST
  // boundaries regardless of what season the viewer is currently in.
  describe("is DST-aware for the given instant", () => {
    it("uses +0 for a London winter date", () => {
      expect(formatUtcOffset(new Date("2026-01-15T12:00:00.000Z"), "Europe/London")).toBe(
        "(UTC +0)"
      );
    });

    it("uses +1 for a London summer date", () => {
      expect(formatUtcOffset(new Date("2026-07-15T12:00:00.000Z"), "Europe/London")).toBe(
        "(UTC +1)"
      );
    });
  });
});
