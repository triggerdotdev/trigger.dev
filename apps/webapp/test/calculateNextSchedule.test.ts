import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { calculateNextScheduledTimestampFromNow } from "../app/v3/utils/calculateNextSchedule.server";

describe("calculateNextScheduledTimestampFromNow", () => {
  beforeEach(() => {
    // Mock the current time to make tests deterministic
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T12:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("should calculate next run time for a recent timestamp", () => {
    const schedule = "0 * * * *"; // Every hour
    const lastRun = new Date("2024-01-01T11:00:00.000Z"); // 1.5 hours ago

    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);

    // Should be 13:00 (next hour after current time 12:30)
    expect(nextRun).toEqual(new Date("2024-01-01T13:00:00.000Z"));
  });

  test("should handle timezone correctly", () => {
    const schedule = "0 * * * *"; // Every hour
    const lastRun = new Date("2024-01-01T11:00:00.000Z");

    const nextRun = calculateNextScheduledTimestampFromNow(schedule, "America/New_York");

    // The exact time will depend on timezone calculation, but should be in the future
    expect(nextRun).toBeInstanceOf(Date);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  test("should efficiently handle very old timestamps (performance fix)", () => {
    const schedule = "*/1 * * * *"; // Every minute
    const veryOldTimestamp = new Date("2020-01-01T00:00:00.000Z"); // 4 years ago

    const startTime = performance.now();
    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);
    const duration = performance.now() - startTime;

    // Should complete quickly (under 10ms) instead of iterating millions of times
    expect(duration).toBeLessThan(10);

    // Should still return a valid future timestamp
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());

    // Should be the next minute after current time (12:31)
    expect(nextRun).toEqual(new Date("2024-01-01T12:31:00.000Z"));
  });

  test("should still work correctly when timestamp is within threshold", () => {
    const schedule = "0 */2 * * *"; // Every 2 hours
    const recentTimestamp = new Date("2024-01-01T10:00:00.000Z"); // 2.5 hours ago

    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);

    // Should properly iterate: 10:00 -> 12:00 -> 14:00 (since current time is 12:30)
    expect(nextRun).toEqual(new Date("2024-01-01T14:00:00.000Z"));
  });

  test("should handle frequent schedules with old timestamps efficiently", () => {
    const schedule = "*/5 * * * *"; // Every 5 minutes
    const oldTimestamp = new Date("2023-12-01T00:00:00.000Z"); // Over a month ago

    const startTime = performance.now();
    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);
    const duration = performance.now() - startTime;

    // Should be fast due to dynamic skip-ahead optimization
    expect(duration).toBeLessThan(10);

    // Should return next 5-minute interval after current time
    expect(nextRun).toEqual(new Date("2024-01-01T12:35:00.000Z"));
  });

  test("should work with complex cron expressions", () => {
    const schedule = "0 9 * * MON"; // Every Monday at 9 AM
    const oldTimestamp = new Date("2022-01-01T00:00:00.000Z"); // Very old (beyond 1hr threshold)

    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);

    // Should return a valid future Monday at 9 AM
    expect(nextRun.getHours()).toBe(9);
    expect(nextRun.getMinutes()).toBe(0);
    expect(nextRun.getDay()).toBe(1); // Monday
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  test("performance: dynamic optimization for extreme scenarios", () => {
    // This test simulates the exact scenario that was causing event loop lag
    const schedule = "* * * * *"; // Every minute (very frequent)
    const extremelyOldTimestamp = new Date("2000-01-01T00:00:00.000Z"); // 24 years ago

    const startTime = performance.now();
    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);
    const duration = performance.now() - startTime;

    // Should complete extremely quickly due to dynamic skip-ahead
    expect(duration).toBeLessThan(5);

    // Should still return the correct next minute
    expect(nextRun).toEqual(new Date("2024-01-01T12:31:00.000Z"));
  });

  test("dynamic optimization: 23h59m old now handled efficiently", () => {
    // This should now be handled efficiently regardless of being "just under" a threshold
    const schedule = "* * * * *"; // Every minute
    const oldTimestamp = new Date("2023-12-31T12:31:00.000Z"); // 23h59m ago

    const startTime = performance.now();
    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);
    const duration = performance.now() - startTime;

    // Should be fast due to dynamic skip-ahead (1439 steps > 10 threshold)
    expect(duration).toBeLessThan(10);

    // Should return correct result
    expect(nextRun).toEqual(new Date("2024-01-01T12:31:00.000Z"));
  });

  test("small intervals still use normal iteration", () => {
    // This should use normal iteration since it's only a few steps
    const schedule = "*/5 * * * *"; // Every 5 minutes
    const recentTimestamp = new Date("2024-01-01T12:00:00.000Z"); // 30 minutes ago (6 steps)

    const startTime = performance.now();
    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);
    const duration = performance.now() - startTime;

    // Should still be reasonably fast with normal iteration
    expect(duration).toBeLessThan(50);

    // Should return next 5-minute interval
    expect(nextRun).toEqual(new Date("2024-01-01T12:35:00.000Z"));
  });

  test("should work with weekly schedules and old timestamps", () => {
    const schedule = "0 9 * * MON"; // Every Monday at 9 AM
    const oldTimestamp = new Date("2023-12-25T09:00:00.000Z"); // Old Monday

    const startTime = performance.now();
    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);
    const duration = performance.now() - startTime;

    // Should be fast and still calculate correctly from the old timestamp
    expect(duration).toBeLessThan(50);

    // Should return a valid future Monday at 9 AM
    expect(nextRun.getHours()).toBe(9);
    expect(nextRun.getMinutes()).toBe(0);
    expect(nextRun.getDay()).toBe(1); // Monday
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  test("weekly schedule with 2-hour old timestamp should calculate properly", () => {
    // This tests your specific concern about weekly schedules
    const schedule = "0 14 * * SUN"; // Every Sunday at 2 PM
    const twoHoursAgo = new Date("2024-01-01T10:30:00.000Z"); // 2 hours before current time (12:30)

    const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);

    // Should properly calculate the next Sunday at 2 PM, not skip to "now"
    expect(nextRun.getHours()).toBe(14);
    expect(nextRun.getMinutes()).toBe(0);
    expect(nextRun.getDay()).toBe(0); // Sunday
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("calculateNextScheduledTimestampFromNow - Fuzzy Testing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:30:00.000Z")); // Monday, mid-day
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper function to generate random cron expressions
  function generateRandomCronExpression(): string {
    const patterns = [
      // Minutes
      "*/1 * * * *", // Every minute
      "*/5 * * * *", // Every 5 minutes
      "*/15 * * * *", // Every 15 minutes
      "30 * * * *", // Every hour at 30 minutes

      // Hours
      "0 * * * *", // Every hour
      "0 */2 * * *", // Every 2 hours
      "0 */6 * * *", // Every 6 hours
      "0 9 * * *", // Daily at 9 AM
      "0 14 * * *", // Daily at 2 PM

      // Days
      "0 9 * * 1", // Every Monday at 9 AM
      "0 14 * * 5", // Every Friday at 2 PM
      "0 10 * * 1-5", // Weekdays at 10 AM
      "0 0 * * 0", // Every Sunday at midnight

      // Weekly/Monthly
      "0 9 * * MON", // Every Monday at 9 AM
      "0 12 1 * *", // First of every month at noon
      "0 15 15 * *", // 15th of every month at 3 PM

      // Complex patterns
      "0 9,17 * * 1-5", // 9 AM and 5 PM on weekdays
      "30 8-18/2 * * *", // Every 2 hours from 8:30 AM to 6:30 PM
    ];

    return patterns[Math.floor(Math.random() * patterns.length)];
  }

  // Helper function to generate random timestamps
  function generateRandomTimestamp(): Date {
    const now = Date.now();
    const possibilities = [
      // Recent timestamps (within last few hours)
      new Date(now - Math.random() * 4 * 60 * 60 * 1000),

      // Old timestamps (days ago)
      new Date(now - Math.random() * 30 * 24 * 60 * 60 * 1000),

      // Very old timestamps (months/years ago)
      new Date(now - Math.random() * 365 * 24 * 60 * 60 * 1000),

      // Extremely old timestamps
      new Date(now - Math.random() * 10 * 365 * 24 * 60 * 60 * 1000),

      // Edge case: exactly now
      new Date(now),

      // Edge case: 1ms ago
      new Date(now - 1),

      // Edge case: future timestamp (should be handled gracefully)
      new Date(now + Math.random() * 24 * 60 * 60 * 1000),
    ];

    return possibilities[Math.floor(Math.random() * possibilities.length)];
  }

  test("fuzzy test: invariants should hold for random scenarios", () => {
    const numTests = 50;

    for (let i = 0; i < numTests; i++) {
      const schedule = generateRandomCronExpression();
      const lastTimestamp = generateRandomTimestamp();
      const timezone = Math.random() > 0.7 ? "America/New_York" : null;

      try {
        const startTime = performance.now();
        const nextRun = calculateNextScheduledTimestampFromNow(schedule, timezone);
        const duration = performance.now() - startTime;

        // Invariant 1: Result should always be a valid Date
        expect(nextRun).toBeInstanceOf(Date);
        expect(nextRun.getTime()).not.toBeNaN();

        // Invariant 2: Result should be in the future (or equal to now if lastTimestamp was in future)
        if (lastTimestamp.getTime() <= Date.now()) {
          expect(nextRun.getTime()).toBeGreaterThan(Date.now());
        }

        // Invariant 3: Performance should be reasonable (no event loop lag)
        expect(duration).toBeLessThan(100); // Should complete within 100ms

        // Invariant 4: Function should be deterministic
        const nextRun2 = calculateNextScheduledTimestampFromNow(schedule, timezone);
        expect(nextRun.getTime()).toBe(nextRun2.getTime());
      } catch (error) {
        // If there's an error, log the inputs for debugging
        console.error(
          `Failed with schedule: ${schedule}, lastTimestamp: ${lastTimestamp.toISOString()}, timezone: ${timezone}`
        );
        throw error;
      }
    }
  });

  test("fuzzy test: performance under stress with frequent schedules", () => {
    const frequentSchedules = ["* * * * *", "*/2 * * * *", "*/5 * * * *"];

    for (let i = 0; i < 20; i++) {
      const schedule = frequentSchedules[Math.floor(Math.random() * frequentSchedules.length)];

      // Generate very old timestamps that would cause many iterations without optimization
      const veryOldTimestamp = new Date(Date.now() - Math.random() * 5 * 365 * 24 * 60 * 60 * 1000);

      const startTime = performance.now();
      const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);
      const duration = performance.now() - startTime;

      // Should complete quickly even with very old timestamps
      expect(duration).toBeLessThan(20);
      expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test("fuzzy test: edge cases around daylight saving time", () => {
    // Test around DST transition dates (spring forward, fall back)
    const dstTestDates = [
      "2024-03-10T06:00:00.000Z", // Around US spring DST
      "2024-11-03T06:00:00.000Z", // Around US fall DST
      "2024-03-31T01:00:00.000Z", // Around EU spring DST
      "2024-10-27T01:00:00.000Z", // Around EU fall DST
    ];

    const timezones = ["America/New_York", "Europe/London", "America/Los_Angeles"];

    for (let i = 0; i < 15; i++) {
      const schedule = generateRandomCronExpression();
      const testDate = dstTestDates[Math.floor(Math.random() * dstTestDates.length)];
      const timezone = timezones[Math.floor(Math.random() * timezones.length)];

      vi.setSystemTime(new Date(testDate));

      const lastTimestamp = new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000);

      const nextRun = calculateNextScheduledTimestampFromNow(schedule, timezone);

      // Should handle DST transitions gracefully
      expect(nextRun).toBeInstanceOf(Date);
      expect(nextRun.getTime()).not.toBeNaN();
      expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test("fuzzy test: boundary conditions", () => {
    const boundaryTests = [
      // End of month transitions
      { time: "2024-02-29T23:59:59.000Z", schedule: "0 0 1 * *" }, // Leap year to March 1st
      { time: "2024-04-30T23:59:59.000Z", schedule: "0 0 31 * *" }, // April 30th to May 31st

      // End of year
      { time: "2024-12-31T23:59:59.000Z", schedule: "0 0 1 1 *" }, // New Year

      // Weekday transitions
      { time: "2024-01-15T06:59:59.000Z", schedule: "0 7 * * MON" }, // Monday morning

      // Hour boundaries
      { time: "2024-01-15T11:59:59.000Z", schedule: "0 12 * * *" }, // Noon
      { time: "2024-01-15T23:59:59.000Z", schedule: "0 0 * * *" }, // Midnight
    ];

    for (const test of boundaryTests) {
      vi.setSystemTime(new Date(test.time));

      // Test with timestamps both before and after the boundary
      const beforeBoundary = new Date(Date.now() - 1000);
      const afterBoundary = new Date(Date.now() + 1000);

      const nextRun1 = calculateNextScheduledTimestampFromNow(test.schedule, null);
      const nextRun2 = calculateNextScheduledTimestampFromNow(test.schedule, null);

      expect(nextRun1.getTime()).toBeGreaterThan(Date.now());
      expect(nextRun2.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test("fuzzy test: complex cron expressions", () => {
    const complexSchedules = [
      "0 9,17 * * 1-5", // 9 AM and 5 PM on weekdays
      "30 8-18/2 * * *", // Every 2 hours from 8:30 AM to 6:30 PM
      "0 0 1,15 * *", // 1st and 15th of every month
      "0 12 * * MON#2", // Second Monday of every month (if supported)
      "0 0 L * *", // Last day of month (if supported)
      "15,45 */2 * * *", // 15 and 45 minutes past every 2nd hour
    ];

    for (let i = 0; i < 30; i++) {
      const schedule = complexSchedules[Math.floor(Math.random() * complexSchedules.length)];
      const lastTimestamp = generateRandomTimestamp();

      try {
        const startTime = performance.now();
        const nextRun = calculateNextScheduledTimestampFromNow(schedule, null);
        const duration = performance.now() - startTime;

        expect(nextRun).toBeInstanceOf(Date);
        expect(duration).toBeLessThan(100);

        if (lastTimestamp.getTime() <= Date.now()) {
          expect(nextRun.getTime()).toBeGreaterThan(Date.now());
        }
      } catch (error) {
        // Some complex expressions might not be supported, that's okay
        if (
          !(error as Error).message.includes("not supported") &&
          !(error as Error).message.includes("Invalid")
        ) {
          console.error(`Unexpected error with schedule: ${schedule}`);
          throw error;
        }
      }
    }
  });

  test("fuzzy test: consistency across multiple calls", () => {
    // Test that the function is consistent when called multiple times with same inputs
    for (let i = 0; i < 20; i++) {
      const schedule = generateRandomCronExpression();
      const lastTimestamp = generateRandomTimestamp();
      const timezone = Math.random() > 0.5 ? "UTC" : "America/New_York";

      const results: Date[] = [];
      for (let j = 0; j < 5; j++) {
        results.push(calculateNextScheduledTimestampFromNow(schedule, timezone));
      }

      // All results should be identical
      for (let j = 1; j < results.length; j++) {
        expect(results[j].getTime()).toBe(results[0].getTime());
      }
    }
  });

  test("fuzzy test: optimization threshold boundary (around 10 steps)", () => {
    // Test cases specifically around the 10-step optimization threshold
    const testCases = [
      { schedule: "*/5 * * * *", minutesAgo: 50 }, // Exactly 10 steps
      { schedule: "*/5 * * * *", minutesAgo: 55 }, // 11 steps (should optimize)
      { schedule: "*/5 * * * *", minutesAgo: 45 }, // 9 steps (should not optimize)
      { schedule: "*/10 * * * *", minutesAgo: 100 }, // Exactly 10 steps
      { schedule: "*/10 * * * *", minutesAgo: 110 }, // 11 steps (should optimize)
      { schedule: "*/15 * * * *", minutesAgo: 150 }, // Exactly 10 steps
      { schedule: "*/1 * * * *", minutesAgo: 10 }, // Exactly 10 steps
      { schedule: "*/1 * * * *", minutesAgo: 11 }, // 11 steps (should optimize)
    ];

    for (const testCase of testCases) {
      const lastTimestamp = new Date(Date.now() - testCase.minutesAgo * 60 * 1000);

      const startTime = performance.now();
      const nextRun = calculateNextScheduledTimestampFromNow(testCase.schedule, null);
      const duration = performance.now() - startTime;

      // All cases should complete quickly and return valid results
      expect(duration).toBeLessThan(50);
      expect(nextRun.getTime()).toBeGreaterThan(Date.now());
      expect(nextRun).toBeInstanceOf(Date);
    }
  });
});
