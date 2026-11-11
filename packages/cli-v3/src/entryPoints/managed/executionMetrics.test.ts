import { describe, expect, it } from "vitest";
import { measureExecutionMetrics } from "./executionMetrics.js";

describe("measureExecutionMetrics", () => {
  // Catches: the supervisor wait passed to the runner never reaching the start timeline.
  it("adds the supervisor wait to the start timeline", () => {
    const metrics = measureExecutionMetrics({
      attemptCreatedAt: Date.now(),
      supervisorWait: { startedAt: 1_762_860_000_123, durationMs: 328 },
    });

    expect(metrics).toContainEqual({
      name: "start",
      event: "supervisor_wait",
      timestamp: 1_762_860_000_123,
      duration: 328,
    });
  });
});
