import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Registry } from "prom-client";
import { BackpressureMonitor, type BackpressureSignalSource } from "./backpressureMonitor.js";
import { BackpressureMetrics } from "./backpressureMetrics.js";

function countingSource(verdict: { engaged: boolean } | null): {
  source: BackpressureSignalSource;
  reads: () => number;
} {
  let reads = 0;
  return {
    source: {
      read: async () => {
        reads++;
        return verdict;
      },
    },
    reads: () => reads,
  };
}

describe("BackpressureMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("when disabled, never skips dequeue and never reads the signal source", () => {
    // Even though the source would report "engaged", a disabled monitor must be
    // a complete no-op: this is the backwards-compatibility guarantee.
    const { source, reads } = countingSource({ engaged: true });
    const monitor = new BackpressureMonitor({ enabled: false, source });

    monitor.start();

    expect(monitor.shouldSkipDequeue()).toBe(false);
    expect(reads()).toBe(0);

    monitor.stop();
  });

  it("when enabled and the source reports engaged, skips dequeue after a refresh", async () => {
    const { source } = countingSource({ engaged: true });
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0); // flush the initial async read

    expect(monitor.shouldSkipDequeue()).toBe(true);

    monitor.stop();
  });

  it("when enabled and the source reports clear, does not skip dequeue", async () => {
    const { source } = countingSource({ engaged: false });
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.shouldSkipDequeue()).toBe(false);

    monitor.stop();
  });

  it("fails open (stops skipping) when the source throws", async () => {
    let call = 0;
    const source: BackpressureSignalSource = {
      read: async () => {
        call++;
        if (call === 1) {
          return { engaged: true };
        }
        throw new Error("signal source unreachable");
      },
    };
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.shouldSkipDequeue()).toBe(true); // engaged from the first read

    await vi.advanceTimersByTimeAsync(1000); // next refresh throws
    expect(monitor.shouldSkipDequeue()).toBe(false); // fail-open: a dead source must not pin the brake

    monitor.stop();
  });

  it("fails open when the source reports unknown (null)", async () => {
    const { source } = countingSource(null);
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.shouldSkipDequeue()).toBe(false);

    monitor.stop();
  });

  it("fails open when the cached verdict goes stale (older than max age)", async () => {
    // Source stops updating (e.g. hangs) after the first read; the verdict ages out.
    const source: BackpressureSignalSource = {
      read: async () => ({ engaged: true, ts: Date.now() }),
    };
    const monitor = new BackpressureMonitor({
      enabled: true,
      source,
      refreshIntervalMs: 1_000_000, // effectively only the initial read fires
      maxVerdictAgeMs: 15_000,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.shouldSkipDequeue()).toBe(true);

    await vi.advanceTimersByTimeAsync(15_001); // verdict now older than max age
    expect(monitor.shouldSkipDequeue()).toBe(false);

    monitor.stop();
  });

  it("does not read the source on the hot path (reads are driven by the refresh tick)", async () => {
    const { source, reads } = countingSource({ engaged: true });
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1); // just the initial refresh

    for (let i = 0; i < 1000; i++) {
      monitor.shouldSkipDequeue();
    }

    expect(reads()).toBe(1); // hot-path calls performed zero I/O

    monitor.stop();
  });

  it("does not start an overlapping refresh while one is in flight", async () => {
    let reads = 0;
    const source: BackpressureSignalSource = {
      // Never resolves - simulates a hung read.
      read: () => {
        reads++;
        return new Promise<{ engaged: boolean } | null>(() => {});
      },
    };
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(3000); // several intervals while the first read hangs

    expect(reads).toBe(1); // in-flight guard prevents stacking

    monitor.stop();
  });

  it("stops refreshing after stop()", async () => {
    const { source, reads } = countingSource({ engaged: true });
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    const readsAtStop = reads();

    monitor.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(reads()).toBe(readsAtStop);
  });

  it("isEngaged reflects the hard engaged state (the signal for freezing scale-up)", async () => {
    const { source } = countingSource({ engaged: true });
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.isEngaged()).toBe(true);

    monitor.stop();
  });

  it("isEngaged is false when clear and when stale", async () => {
    const source: BackpressureSignalSource = {
      read: async () => ({ engaged: true, ts: Date.now() }),
    };
    const monitor = new BackpressureMonitor({
      enabled: true,
      source,
      refreshIntervalMs: 1_000_000,
      maxVerdictAgeMs: 15_000,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isEngaged()).toBe(true);

    await vi.advanceTimersByTimeAsync(15_001); // stale → fail-open
    expect(monitor.isEngaged()).toBe(false);

    monitor.stop();
  });

  it("ramps the dequeue gate after release instead of resuming instantly", async () => {
    let engaged = true;
    let rnd = 0.5;
    const source: BackpressureSignalSource = { read: async () => ({ engaged }) };
    const monitor = new BackpressureMonitor({
      enabled: true,
      source,
      refreshIntervalMs: 1000,
      rampMs: 10_000,
      random: () => rnd,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.shouldSkipDequeue()).toBe(true); // hard engaged

    // Release: the next refresh observes the clear verdict and starts the ramp.
    engaged = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(monitor.isEngaged()).toBe(false);

    // Just after release (progress ~0): skip probability ~1, so skip regardless.
    rnd = 0.99;
    expect(monitor.shouldSkipDequeue()).toBe(true);

    // Halfway through the ramp (progress 0.5): skip probability 0.5.
    await vi.advanceTimersByTimeAsync(5000);
    rnd = 0.4;
    expect(monitor.shouldSkipDequeue()).toBe(true); // 0.4 < 0.5 → skip
    rnd = 0.6;
    expect(monitor.shouldSkipDequeue()).toBe(false); // 0.6 ≥ 0.5 → allow

    // Past the ramp window: never skip.
    await vi.advanceTimersByTimeAsync(5000);
    rnd = 0.0;
    expect(monitor.shouldSkipDequeue()).toBe(false);

    monitor.stop();
  });

  it("fails open on an engaged verdict with no timestamp when staleness is enforced", async () => {
    // A verdict claiming engaged but carrying no ts can't be checked for freshness;
    // when maxVerdictAgeMs is set we must not trust it (else a dead producer could
    // pin the brake forever).
    const { source } = countingSource({ engaged: true }); // no ts
    const monitor = new BackpressureMonitor({
      enabled: true,
      source,
      refreshIntervalMs: 1000,
      maxVerdictAgeMs: 15_000,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.computeEngaged()).toBe(false);
    expect(monitor.shouldSkipDequeue()).toBe(false);

    monitor.stop();
  });

  it("in dry-run, the gates are inert but computeEngaged still reflects the real signal", async () => {
    const { source } = countingSource({ engaged: true });
    const monitor = new BackpressureMonitor({
      enabled: true,
      source,
      refreshIntervalMs: 1000,
      dryRun: true,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.computeEngaged()).toBe(true); // real signal, for observability/metrics
    expect(monitor.isEngaged()).toBe(false); // inert: no scale-up freeze
    expect(monitor.shouldSkipDequeue()).toBe(false); // inert: no dequeue skip

    monitor.stop();
  });

  it("logs on verdict transitions", async () => {
    let engaged = true;
    const source: BackpressureSignalSource = { read: async () => ({ engaged }) };
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
    };
    const monitor = new BackpressureMonitor({
      enabled: true,
      source,
      refreshIntervalMs: 1000,
      logger,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.some((l) => l.meta?.engaged === true)).toBe(true);

    engaged = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(logs.some((l) => l.meta?.engaged === false)).toBe(true);

    monitor.stop();
  });

  it("records prometheus metrics", async () => {
    const { source } = countingSource({ engaged: true });
    const register = new Registry();
    const metrics = new BackpressureMetrics({ register });
    const monitor = new BackpressureMonitor({
      enabled: true,
      source,
      refreshIntervalMs: 1000,
      metrics,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(await register.metrics()).toContain("supervisor_backpressure_engaged 1");

    monitor.shouldSkipDequeue();
    expect(await register.metrics()).toMatch(
      /supervisor_backpressure_skipped_dequeues_total\{dry_run="false"\} [1-9]/
    );

    monitor.stop();
  });

  it("resumes instantly when no ramp is configured", async () => {
    let engaged = true;
    const source: BackpressureSignalSource = { read: async () => ({ engaged }) };
    const monitor = new BackpressureMonitor({ enabled: true, source, refreshIntervalMs: 1000 });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.shouldSkipDequeue()).toBe(true);

    engaged = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(monitor.shouldSkipDequeue()).toBe(false); // no ramp → instant resume

    monitor.stop();
  });
});
