import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { calculateNextScheduledTimestamp } from "../app/v3/utils/calculateNextSchedule.server";

describe("calculateNextScheduledTimestamp", () => {
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

    const nextRun = calculateNextScheduledTimestamp(schedule, null, lastRun);

    // Should be 13:00 (next hour after current time 12:30)
    expect(nextRun).toEqual(new Date("2024-01-01T13:00:00.000Z"));
  });

  test("should handle timezone correctly", () => {
    const schedule = "0 * * * *"; // Every hour
    const lastRun = new Date("2024-01-01T11:00:00.000Z");

    const nextRun = calculateNextScheduledTimestamp(schedule, "America/New_York", lastRun);

    // The exact time will depend on timezone calculation, but should be in the future
    expect(nextRun).toBeInstanceOf(Date);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  test("should efficiently handle very old timestamps (performance fix)", () => {
    const schedule = "*/1 * * * *"; // Every minute
    const veryOldTimestamp = new Date("2020-01-01T00:00:00.000Z"); // 4 years ago

    const startTime = performance.now();
    const nextRun = calculateNextScheduledTimestamp(schedule, null, veryOldTimestamp);
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

    const nextRun = calculateNextScheduledTimestamp(schedule, null, recentTimestamp);

    // Should properly iterate: 10:00 -> 12:00 -> 14:00 (since current time is 12:30)
    expect(nextRun).toEqual(new Date("2024-01-01T14:00:00.000Z"));
  });

  test("should handle frequent schedules with old timestamps efficiently", () => {
    const schedule = "*/5 * * * *"; // Every 5 minutes
    const oldTimestamp = new Date("2023-12-01T00:00:00.000Z"); // Over a month ago

    const startTime = performance.now();
    const nextRun = calculateNextScheduledTimestamp(schedule, null, oldTimestamp);
    const duration = performance.now() - startTime;

    // Should be fast due to dynamic skip-ahead optimization
    expect(duration).toBeLessThan(10);

    // Should return next 5-minute interval after current time
    expect(nextRun).toEqual(new Date("2024-01-01T12:35:00.000Z"));
  });

  test("should work with complex cron expressions", () => {
    const schedule = "0 9 * * MON"; // Every Monday at 9 AM
    const oldTimestamp = new Date("2022-01-01T00:00:00.000Z"); // Very old (beyond 1hr threshold)

    const nextRun = calculateNextScheduledTimestamp(schedule, null, oldTimestamp);

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
    const nextRun = calculateNextScheduledTimestamp(schedule, null, extremelyOldTimestamp);
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
    const nextRun = calculateNextScheduledTimestamp(schedule, null, oldTimestamp);
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
    const nextRun = calculateNextScheduledTimestamp(schedule, null, recentTimestamp);
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
    const nextRun = calculateNextScheduledTimestamp(schedule, null, oldTimestamp);
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

    const nextRun = calculateNextScheduledTimestamp(schedule, null, twoHoursAgo);

    // Should properly calculate the next Sunday at 2 PM, not skip to "now"
    expect(nextRun.getHours()).toBe(14);
    expect(nextRun.getMinutes()).toBe(0);
    expect(nextRun.getDay()).toBe(0); // Sunday
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });
});
