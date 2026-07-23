import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicFlushScheduler } from "~/v3/dynamicFlushScheduler.server";
import { createInMemoryMetrics } from "./utils/tracing";
import { gaugeValue, latestMetrics, metricSum } from "./otlpMetrics.helpers";

type Item = { id: number };

describe("DynamicFlushScheduler self-observability", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it("records flush counters, histograms and gauges on a successful flush", async () => {
    const metrics = createInMemoryMetrics();
    const flushed: number[] = [];

    const scheduler = new DynamicFlushScheduler<Item>({
      name: "test_events",
      batchSize: 5,
      flushInterval: 50,
      meter: metrics.meter,
      loadSheddingEnabled: false,
      callback: async (_flushId, batch) => {
        flushed.push(batch.length);
      },
    });
    cleanups.push(async () => {
      await scheduler.shutdown();
      await metrics.shutdown();
    });

    // Reaching batchSize triggers an immediate flush.
    scheduler.addToBatch([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.flush.items", { scheduler: "test_events" })).toBe(5);
      },
      { timeout: 4000, interval: 50 }
    );

    expect(flushed).toEqual([5]);

    const rm = await latestMetrics(metrics);
    expect(metricSum(rm, "ingest.flush.batches", { scheduler: "test_events", outcome: "ok" })).toBe(
      1
    );
    expect(metricSum(rm, "ingest.flush.batch_size", { scheduler: "test_events" })).toBe(5);
    // Gauges are pull-based; the export we just collected observed the current state.
    expect(gaugeValue(rm, "ingest.flush.queue_depth", { scheduler: "test_events" })).toBeDefined();
    expect(
      gaugeValue(rm, "ingest.flush.concurrency", { scheduler: "test_events" })
    ).toBeGreaterThanOrEqual(1);
  });

  it("labels each scheduler instance separately", async () => {
    const metrics = createInMemoryMetrics();

    const makeScheduler = (name: string) => {
      const s = new DynamicFlushScheduler<Item>({
        name,
        batchSize: 2,
        flushInterval: 50,
        meter: metrics.meter,
        loadSheddingEnabled: false,
        callback: async () => {},
      });
      cleanups.push(async () => s.shutdown());
      return s;
    };

    const a = makeScheduler("task_events_v2");
    const b = makeScheduler("llm_metrics");
    cleanups.push(async () => metrics.shutdown());

    a.addToBatch([{ id: 1 }, { id: 2 }]);
    b.addToBatch([{ id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.flush.items", { scheduler: "task_events_v2" })).toBe(2);
        expect(metricSum(rm, "ingest.flush.items", { scheduler: "llm_metrics" })).toBe(4);
      },
      { timeout: 4000, interval: 50 }
    );
  });

  it("counts a permanently failing flush as a failed batch", async () => {
    const metrics = createInMemoryMetrics();

    const scheduler = new DynamicFlushScheduler<Item>({
      name: "failing_events",
      batchSize: 1,
      flushInterval: 50,
      meter: metrics.meter,
      loadSheddingEnabled: false,
      callback: async () => {
        throw new Error("insert failed");
      },
    });
    cleanups.push(async () => {
      await scheduler.shutdown();
      await metrics.shutdown();
    });

    scheduler.addToBatch([{ id: 1 }]);

    // The scheduler retries 3x with a 500ms backoff before giving up, so allow ~2s.
    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(
          metricSum(rm, "ingest.flush.batches", {
            scheduler: "failing_events",
            outcome: "failed",
          })
        ).toBeGreaterThanOrEqual(1);
      },
      { timeout: 8000, interval: 100 }
    );

    const rm = await latestMetrics(metrics);
    expect(
      metricSum(rm, "ingest.flush.batches", { scheduler: "failing_events", outcome: "ok" })
    ).toBe(0);
  });
});
