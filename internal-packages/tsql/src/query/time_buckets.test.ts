import { describe, it, expect } from "vitest";
import { calculateTimeBucketInterval, type TimeBucketInterval } from "./time_buckets.js";

/**
 * Helper to create a Date range from a start date and a duration
 */
function makeRange(from: Date, durationMs: number): { from: Date; to: Date } {
  return { from, to: new Date(from.getTime() + durationMs) };
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("calculateTimeBucketInterval", () => {
  describe("small ranges (seconds-level buckets)", () => {
    it("should return 5 SECOND for a 1-minute range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 1 * MINUTE);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 5,
        unit: "SECOND",
      });
    });

    it("should return 5 SECOND for a 4-minute range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 4 * MINUTE);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 5,
        unit: "SECOND",
      });
    });

    it("should return 30 SECOND for a 10-minute range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 10 * MINUTE);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 30,
        unit: "SECOND",
      });
    });

    it("should return 30 SECOND for a 29-minute range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 29 * MINUTE);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 30,
        unit: "SECOND",
      });
    });
  });

  describe("medium ranges (minute-level buckets)", () => {
    it("should return 1 MINUTE for a 45-minute range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 45 * MINUTE);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 1,
        unit: "MINUTE",
      });
    });

    it("should return 1 MINUTE for a 1-hour range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 1 * HOUR);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 1,
        unit: "MINUTE",
      });
    });

    it("should return 5 MINUTE for a 3-hour range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 3 * HOUR);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 5,
        unit: "MINUTE",
      });
    });

    it("should return 15 MINUTE for a 12-hour range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 12 * HOUR);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 15,
        unit: "MINUTE",
      });
    });
  });

  describe("large ranges (hour/day-level buckets)", () => {
    it("should return 1 HOUR for a 2-day range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 2 * DAY);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 1,
        unit: "HOUR",
      });
    });

    it("should return 6 HOUR for a 7-day range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 7 * DAY);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 6,
        unit: "HOUR",
      });
    });

    it("should return 1 DAY for a 30-day range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 30 * DAY);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 1,
        unit: "DAY",
      });
    });

    it("should return 1 WEEK for a 90-day range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 90 * DAY);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 1,
        unit: "WEEK",
      });
    });
  });

  describe("very large ranges (month-level buckets)", () => {
    it("should return 1 MONTH for a 365-day range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 365 * DAY);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 1,
        unit: "MONTH",
      });
    });

    it("should return 1 MONTH for a 2-year range", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 730 * DAY);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 1,
        unit: "MONTH",
      });
    });
  });

  describe("edge cases", () => {
    it("should handle zero-length range (from === to)", () => {
      const date = new Date("2024-01-01T00:00:00Z");
      const result = calculateTimeBucketInterval(date, date);
      // Zero range is under 5 minutes, so 5 SECOND
      expect(result).toEqual<TimeBucketInterval>({ value: 5, unit: "SECOND" });
    });

    it("should handle reversed dates (to < from) using absolute difference", () => {
      const from = new Date("2024-01-08T00:00:00Z");
      const to = new Date("2024-01-01T00:00:00Z");
      // 7 days reversed → same as 7 days forward
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 6,
        unit: "HOUR",
      });
    });

    it("should handle boundary exactly at 5 minutes", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 5 * MINUTE);
      // Exactly 5 minutes is NOT under 5 minutes, so should be 30 SECOND
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 30,
        unit: "SECOND",
      });
    });

    it("should handle boundary exactly at 24 hours", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 24 * HOUR);
      // Exactly 24 hours is NOT under 24 hours, so should be 1 HOUR
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 1,
        unit: "HOUR",
      });
    });

    it("should handle very small range (1 second)", () => {
      const { from, to } = makeRange(new Date("2024-01-01T00:00:00Z"), 1 * SECOND);
      expect(calculateTimeBucketInterval(from, to)).toEqual<TimeBucketInterval>({
        value: 5,
        unit: "SECOND",
      });
    });
  });
});
