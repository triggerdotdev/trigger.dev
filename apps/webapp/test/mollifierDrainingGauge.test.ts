import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Same defensive mocks as mollifierDrainerWorker.test.ts: importing
// the gauge module transitively loads telemetry → meter → OTel
// initialisation, plus the buffer singleton's runtime resolution.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const reportDrainingCount = vi.fn();
vi.mock("~/v3/mollifier/mollifierTelemetry.server", () => ({
  reportDrainingCount: (count: number) => reportDrainingCount(count),
}));

import {
  startMollifierDrainingGauge,
  stopMollifierDrainingGauge,
} from "~/v3/mollifier/mollifierDrainingGauge.server";

// The gauge poller reads `mollifier:draining` cardinality on a cadence
// and forwards it to `reportDrainingCount`. These tests pin the
// observable contract: the gauge value is the buffer's count, transient
// errors keep the last value, and the loop never blocks the main thread
// (unref'd interval — verified implicitly because Vitest exits cleanly).
describe("startMollifierDrainingGauge", () => {
  beforeEach(() => {
    reportDrainingCount.mockReset();
    stopMollifierDrainingGauge();
  });

  afterEach(() => {
    stopMollifierDrainingGauge();
  });

  it("fires an immediate poll on start so the gauge populates before the first scrape", async () => {
    const buffer = { getDrainingCount: vi.fn().mockResolvedValue(7) } as any;
    startMollifierDrainingGauge({
      intervalMs: 100_000, // long — we're checking the immediate fire, not the interval
      getBuffer: () => buffer,
    });

    // Wait one microtask tick so the eager poll resolves.
    await new Promise((r) => setImmediate(r));
    expect(reportDrainingCount).toHaveBeenCalledWith(7);
    expect(buffer.getDrainingCount).toHaveBeenCalledTimes(1);
  });

  it("polls on the configured cadence", async () => {
    const buffer = { getDrainingCount: vi.fn().mockResolvedValue(3) } as any;
    startMollifierDrainingGauge({
      intervalMs: 20,
      getBuffer: () => buffer,
    });

    // Eager tick + at least one interval tick.
    await new Promise((r) => setTimeout(r, 80));
    expect(buffer.getDrainingCount.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(reportDrainingCount).toHaveBeenCalledWith(3);
  });

  it("no-ops when the buffer singleton returns null (mollifier disabled)", async () => {
    startMollifierDrainingGauge({
      intervalMs: 20,
      getBuffer: () => null,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(reportDrainingCount).not.toHaveBeenCalled();
  });

  it("swallows a transient ZCARD failure so the loop keeps running", async () => {
    let calls = 0;
    const buffer = {
      getDrainingCount: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient redis blip");
        return 4;
      }),
    } as any;
    startMollifierDrainingGauge({
      intervalMs: 20,
      getBuffer: () => buffer,
    });

    await new Promise((r) => setTimeout(r, 80));
    // First call threw → no report. Second call succeeded → reported.
    // The gauge keeps its previous value (stale-but-non-zero) between
    // the failed poll and the next successful one — better than
    // crashing the loop and going silent forever.
    expect(reportDrainingCount).toHaveBeenCalledWith(4);
    expect(buffer.getDrainingCount.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent: a second start does not spawn a parallel loop", async () => {
    const buffer = { getDrainingCount: vi.fn().mockResolvedValue(1) } as any;
    startMollifierDrainingGauge({ intervalMs: 25, getBuffer: () => buffer });
    startMollifierDrainingGauge({ intervalMs: 25, getBuffer: () => buffer });

    await new Promise((r) => setTimeout(r, 90));
    // One eager + a small number of interval ticks. Doubled-loop would
    // produce ~2× the calls in the same window. Upper bound is generous
    // for CI jitter; the property is "single loop", not exact count.
    expect(buffer.getDrainingCount.mock.calls.length).toBeLessThan(8);
  });

  it("stop halts the polling loop", async () => {
    const buffer = { getDrainingCount: vi.fn().mockResolvedValue(2) } as any;
    startMollifierDrainingGauge({ intervalMs: 20, getBuffer: () => buffer });
    await new Promise((r) => setTimeout(r, 50));
    const callsAtStop = buffer.getDrainingCount.mock.calls.length;
    stopMollifierDrainingGauge();

    await new Promise((r) => setTimeout(r, 80));
    expect(buffer.getDrainingCount.mock.calls.length).toBe(callsAtStop);
  });
});
