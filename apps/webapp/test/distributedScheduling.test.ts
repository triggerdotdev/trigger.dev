import { describe, test, expect } from "vitest";
import { calculateDistributedExecutionTime } from "../app/v3/utils/distributedScheduling.server";

describe("calculateDistributedExecutionTime", () => {
  const distributionWindow = 30; // 30 seconds

  test("should return a time before the exact schedule time", () => {
    const exactScheduleTime = new Date("2024-01-01T12:00:00.000Z");
    const distributedTime = calculateDistributedExecutionTime(
      exactScheduleTime,
      distributionWindow
    );

    expect(distributedTime.getTime()).toBeLessThanOrEqual(exactScheduleTime.getTime());
  });

  test("should return a time within the distribution window", () => {
    const exactScheduleTime = new Date("2024-01-01T12:00:00.000Z");
    const distributedTime = calculateDistributedExecutionTime(
      exactScheduleTime,
      distributionWindow
    );

    const maxOffset = distributionWindow * 1000; // Convert to milliseconds
    const actualOffset = exactScheduleTime.getTime() - distributedTime.getTime();

    expect(actualOffset).toBeGreaterThanOrEqual(0);
    expect(actualOffset).toBeLessThanOrEqual(maxOffset);
  });

  test("should be deterministic for the same schedule time", () => {
    const exactScheduleTime = new Date("2024-01-01T12:00:00.000Z");

    const distributedTime1 = calculateDistributedExecutionTime(
      exactScheduleTime,
      distributionWindow
    );
    const distributedTime2 = calculateDistributedExecutionTime(
      exactScheduleTime,
      distributionWindow
    );

    expect(distributedTime1.getTime()).toBe(distributedTime2.getTime());
  });

  test("should produce different distribution times for different schedule times", () => {
    const scheduleTime1 = new Date("2024-01-01T12:00:00.000Z");
    const scheduleTime2 = new Date("2024-01-01T12:01:00.000Z");

    const distributedTime1 = calculateDistributedExecutionTime(scheduleTime1, distributionWindow);
    const distributedTime2 = calculateDistributedExecutionTime(scheduleTime2, distributionWindow);

    // They should be different (with very high probability)
    expect(distributedTime1.getTime()).not.toBe(distributedTime2.getTime());
  });

  test("should distribute work evenly across the time window", () => {
    // Test with many different schedule times to ensure distribution
    const distributionCounts = new Array(distributionWindow).fill(0);
    const testCount = 1000;

    for (let i = 0; i < testCount; i++) {
      // Create valid times by varying the seconds instead of minutes
      const seconds = i % 60;
      const minutes = Math.floor(i / 60) % 60;
      const hours = Math.floor(i / 3600) % 24;
      const exactScheduleTime = new Date(
        `2024-01-01T${hours.toString().padStart(2, "0")}:${minutes
          .toString()
          .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.000Z`
      );
      const distributedTime = calculateDistributedExecutionTime(
        exactScheduleTime,
        distributionWindow
      );

      const offsetMs = exactScheduleTime.getTime() - distributedTime.getTime();
      const bucket = Math.floor(offsetMs / 1000); // Convert to second bucket

      if (bucket >= 0 && bucket < distributionWindow) {
        distributionCounts[bucket]++;
      }
    }

    // Check that distribution is reasonably spread (most buckets should have some items)
    const bucketsWithItems = distributionCounts.filter((count) => count > 0).length;
    expect(bucketsWithItems).toBeGreaterThan(distributionWindow * 0.8); // At least 80% of buckets should have items
  });

  test("should handle edge cases gracefully", () => {
    // Test with various dates and times
    const testCases = [
      new Date("2024-01-01T00:00:00.000Z"), // Midnight
      new Date("2024-12-31T23:59:59.999Z"), // End of year
      new Date("2024-02-29T12:00:00.000Z"), // Leap year
      new Date("1970-01-01T00:00:00.001Z"), // Near epoch
      new Date("2099-12-31T23:59:59.999Z"), // Far future
    ];

    for (const exactScheduleTime of testCases) {
      const distributedTime = calculateDistributedExecutionTime(
        exactScheduleTime,
        distributionWindow
      );

      expect(distributedTime).toBeInstanceOf(Date);
      expect(distributedTime.getTime()).not.toBeNaN();
      expect(distributedTime.getTime()).toBeLessThanOrEqual(exactScheduleTime.getTime());

      const offset = exactScheduleTime.getTime() - distributedTime.getTime();
      expect(offset).toBeLessThanOrEqual(distributionWindow * 1000);
    }
  });

  test("should work with different distribution window sizes", () => {
    const exactScheduleTime = new Date("2024-01-01T12:00:00.000Z");

    // Test with a 10-second window
    const distributedTime10 = calculateDistributedExecutionTime(exactScheduleTime, 10);
    const offset10 = exactScheduleTime.getTime() - distributedTime10.getTime();
    expect(offset10).toBeLessThanOrEqual(10 * 1000);

    // Test with a 60-second window
    const distributedTime60 = calculateDistributedExecutionTime(exactScheduleTime, 60);
    const offset60 = exactScheduleTime.getTime() - distributedTime60.getTime();
    expect(offset60).toBeLessThanOrEqual(60 * 1000);
  });

  test("should maintain consistent hash-based distribution", () => {
    // Test that the hash function produces consistent results
    const scheduleTime = new Date("2024-01-01T12:00:00.000Z");

    // Call multiple times to ensure consistency
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(calculateDistributedExecutionTime(scheduleTime, distributionWindow));
    }

    // All results should be identical
    for (let i = 1; i < results.length; i++) {
      expect(results[i].getTime()).toBe(results[0].getTime());
    }
  });
});
