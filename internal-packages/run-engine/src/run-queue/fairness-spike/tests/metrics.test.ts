import { describe, it, expect } from "vitest";
import { computeMetrics, type DequeueEvent } from "../harness/metrics.js";

function ev(groupId: string, runId: string, dequeueAt: number, enqueueAt = 0): DequeueEvent {
  return { groupId, runId, enqueueAtMs: enqueueAt, dequeueAtMs: dequeueAt };
}

describe("computeMetrics", () => {
  it("flags a starved competitor as contention share ~0", () => {
    // a is served for all 4 of its runs before b gets any; both had 4 to do.
    const events: DequeueEvent[] = [
      ...Array.from({ length: 4 }, (_, i) => ev("a", `a${i}`, i + 1)),
      ...Array.from({ length: 4 }, (_, i) => ev("b", `b${i}`, 100 + i)),
    ];
    const m = computeMetrics({
      events,
      weights: { a: 1, b: 1 },
      totals: { a: 4, b: 4 },
      redisOps: 0,
      wallClockMs: 0,
    });
    // during the window (while both had work) a took everything, b took nothing
    expect(m.contentionWorstShareOverWeight).toBeCloseTo(0, 6);
    const a = m.perGroup.find((g) => g.groupId === "a")!;
    expect(a.contentionShareOverWeight).toBeGreaterThan(1.5);
  });

  it("scores an even interleave as fair", () => {
    const events: DequeueEvent[] = [];
    for (let i = 0; i < 4; i++) {
      events.push(ev("a", `a${i}`, i * 2 + 1));
      events.push(ev("b", `b${i}`, i * 2 + 2));
    }
    const m = computeMetrics({
      events,
      weights: { a: 1, b: 1 },
      totals: { a: 4, b: 4 },
      redisOps: 0,
      wallClockMs: 0,
    });
    expect(m.contentionWorstShareOverWeight).toBeGreaterThan(0.8);
    expect(m.contentionJain).toBeGreaterThan(0.95);
  });

  it("reports per-group wait percentiles and the worst tail", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const events = waits.map((w, i) => ev("a", `a${i}`, w));
    const m = computeMetrics({
      events,
      weights: { a: 1 },
      totals: { a: 10 },
      redisOps: 0,
      wallClockMs: 0,
    });
    const a = m.perGroup[0];
    expect(a.waitP50).toBe(5);
    expect(a.waitP99).toBe(100);
    expect(a.waitMax).toBe(100);
    expect(m.worstWaitP99).toBe(100);
  });
});
