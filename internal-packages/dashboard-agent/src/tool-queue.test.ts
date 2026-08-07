import { describe, expect, it } from "vitest";
import { queueMetricsAreEmpty } from "./tool-api";

/**
 * The metrics route answers an unknown queue with zeroes rather than a 404, so asking for
 * the wrong queue kind reads exactly like an idle queue. `get_queue` retries with the other
 * kind before believing that, which is what stops "no queue named email-sends exists" being
 * said about a queue holding thousands of runs.
 */
describe("queueMetricsAreEmpty", () => {
  const zeroes = {
    peakQueued: 0,
    startedCount: 0,
    throttledCount: 0,
    depthTrend: [],
    waitMs: { p50: null, p95: null },
  };

  it("treats an all-zero answer as no evidence the queue exists", () => {
    expect(queueMetricsAreEmpty(zeroes)).toBe(true);
    expect(queueMetricsAreEmpty(null)).toBe(true);
  });

  it("takes any single sign of life as evidence", () => {
    expect(queueMetricsAreEmpty({ ...zeroes, peakQueued: 4800 })).toBe(false);
    expect(queueMetricsAreEmpty({ ...zeroes, startedCount: 3 })).toBe(false);
    expect(queueMetricsAreEmpty({ ...zeroes, throttledCount: 1 })).toBe(false);
    expect(queueMetricsAreEmpty({ ...zeroes, depthTrend: [0, 0] })).toBe(false);
    expect(queueMetricsAreEmpty({ ...zeroes, waitMs: { p50: 0, p95: null } })).toBe(false);
  });
});
