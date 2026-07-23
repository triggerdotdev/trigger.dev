import { describe, it, expect } from "vitest";
import { computeMetrics, type DequeueEvent } from "../harness/metrics.js";

function ev(groupId: string, runId: string, wait: number): DequeueEvent {
  return { groupId, runId, enqueueAtMs: 0, dequeueAtMs: wait };
}

describe("computeMetrics", () => {
  it("computes share, shareOverWeight, and Jain index for a skewed split", () => {
    // Group A dequeued 8, group B dequeued 2, equal weight.
    const events: DequeueEvent[] = [
      ...Array.from({ length: 8 }, (_, i) => ev("a", `a${i}`, 10)),
      ...Array.from({ length: 2 }, (_, i) => ev("b", `b${i}`, 100)),
    ];
    const m = computeMetrics({ events, weights: { a: 1, b: 1 }, redisOps: 0, wallClockMs: 0 });

    const a = m.perGroup.find((g) => g.groupId === "a")!;
    const b = m.perGroup.find((g) => g.groupId === "b")!;
    expect(a.share).toBeCloseTo(0.8, 6);
    expect(b.share).toBeCloseTo(0.2, 6);
    // expected share is 0.5 each, so shareOverWeight = 1.6 and 0.4
    expect(a.shareOverWeight).toBeCloseTo(1.6, 6);
    expect(b.shareOverWeight).toBeCloseTo(0.4, 6);
    expect(m.worstShareOverWeight).toBeCloseTo(0.4, 6);
    // Jain over [1.6, 0.4] = 4 / (2 * 2.72) = 0.7353
    expect(m.jainIndex).toBeCloseTo(0.7353, 3);
    expect(m.totalDequeued).toBe(10);
  });

  it("reports p99 and max wait per group", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const events = waits.map((w, i) => ev("a", `a${i}`, w));
    const m = computeMetrics({ events, weights: { a: 1 }, redisOps: 0, wallClockMs: 0 });
    const a = m.perGroup[0];
    expect(a.waitMax).toBe(100);
    // nearest-rank p99 of 10 samples => last element
    expect(a.waitP99).toBe(100);
    expect(a.waitP50).toBe(5);
  });

  it("gives a perfect Jain index for an even split", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => ev("a", `a${i}`, 1)),
      ...Array.from({ length: 5 }, (_, i) => ev("b", `b${i}`, 1)),
    ];
    const m = computeMetrics({ events, weights: { a: 1, b: 1 }, redisOps: 0, wallClockMs: 0 });
    expect(m.jainIndex).toBeCloseTo(1, 6);
    expect(m.worstShareOverWeight).toBeCloseTo(1, 6);
  });
});
