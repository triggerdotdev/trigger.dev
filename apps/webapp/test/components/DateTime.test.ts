import { describe, it, expect } from "vitest";
import { formatDateTimeISO } from "~/components/primitives/DateTime";

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
});
