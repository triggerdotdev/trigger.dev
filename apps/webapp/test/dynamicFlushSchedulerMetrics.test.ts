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

  it("counts the items lost when a batch is abandoned", async () => {
    const metrics = createInMemoryMetrics();

    const scheduler = new DynamicFlushScheduler<Item>({
      name: "failing_events",
      batchSize: 3,
      flushInterval: 50,
      meter: metrics.meter,
      loadSheddingEnabled: false,
      callback: async () => {
        throw new Error("No such column attributes_input in table");
      },
    });
    cleanups.push(async () => {
      await scheduler.shutdown();
      await metrics.shutdown();
    });

    scheduler.addToBatch([{ id: 1 }, { id: 2 }, { id: 3 }]);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.flush.items_lost", { scheduler: "failing_events" })).toBe(3);
      },
      { timeout: 8000, interval: 100 }
    );

    // The success-only items counter must not move: it means "landed", and these did not.
    const rm = await latestMetrics(metrics);
    expect(metricSum(rm, "ingest.flush.items", { scheduler: "failing_events" })).toBe(0);
  });

  it("releases queue depth when a batch is abandoned", async () => {
    const metrics = createInMemoryMetrics();

    const scheduler = new DynamicFlushScheduler<Item>({
      name: "failing_events",
      batchSize: 2,
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

    scheduler.addToBatch([{ id: 1 }, { id: 2 }]);

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

    // Regression: depth used to be decremented only on success, so an abandoned batch left
    // the gauge permanently inflated and it read as backlog rather than as loss.
    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(gaugeValue(rm, "ingest.flush.queue_depth", { scheduler: "failing_events" })).toBe(0);
      },
      { timeout: 4000, interval: 100 }
    );
  });

  it("reports the age of the oldest batch still waiting to flush", async () => {
    const metrics = createInMemoryMetrics();

    const scheduler = new DynamicFlushScheduler<Item>({
      name: "test_events",
      batchSize: 10,
      // Long enough that only reaching batchSize flushes, so the first items sit and age.
      flushInterval: 60_000,
      meter: metrics.meter,
      loadSheddingEnabled: false,
      callback: async () => {},
    });
    cleanups.push(async () => {
      await scheduler.shutdown();
      await metrics.shutdown();
    });

    scheduler.addToBatch([{ id: 1 }, { id: 2 }]);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(
          gaugeValue(rm, "ingest.flush.oldest_pending_age", { scheduler: "test_events" })
        ).toBeGreaterThan(0);
      },
      { timeout: 4000, interval: 50 }
    );

    // Reaching batchSize drains everything, so nothing is pending and the age resets.
    scheduler.addToBatch([
      { id: 3 },
      { id: 4 },
      { id: 5 },
      { id: 6 },
      { id: 7 },
      { id: 8 },
      { id: 9 },
      { id: 10 },
    ]);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(
          gaugeValue(rm, "ingest.flush.oldest_pending_age", { scheduler: "test_events" })
        ).toBe(0);
      },
      { timeout: 4000, interval: 50 }
    );
  });

  it("keeps reporting an age while the only batch is in flight", async () => {
    const metrics = createInMemoryMetrics();

    let releaseFlush: (() => void) | undefined;
    const flushHung = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });

    const scheduler = new DynamicFlushScheduler<Item>({
      name: "hanging_events",
      // One item fills a batch, so it is dequeued at once and nothing is left queued behind it.
      batchSize: 1,
      flushInterval: 60_000,
      meter: metrics.meter,
      loadSheddingEnabled: false,
      callback: async () => {
        await flushHung;
      },
    });
    cleanups.push(async () => {
      releaseFlush?.();
      await scheduler.shutdown();
      await metrics.shutdown();
    });

    scheduler.addToBatch([{ id: 1 }]);

    // The batch is out of batchQueue and inside the flush, which is where the age used to be
    // dropped: the gauge read 0 while the item had not been stored and never would be.
    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(
          gaugeValue(rm, "ingest.flush.oldest_pending_age", { scheduler: "hanging_events" })
        ).toBeGreaterThan(0);
      },
      { timeout: 4000, interval: 50 }
    );

    releaseFlush?.();

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(
          gaugeValue(rm, "ingest.flush.oldest_pending_age", { scheduler: "hanging_events" })
        ).toBe(0);
      },
      { timeout: 4000, interval: 50 }
    );
  });

  it("reports the oldest of several waiting batches, not the newest", async () => {
    const metrics = createInMemoryMetrics();

    let releaseFlush: (() => void) | undefined;
    const flushHung = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });

    const scheduler = new DynamicFlushScheduler<Item>({
      name: "backlog_events",
      batchSize: 1,
      flushInterval: 60_000,
      maxConcurrency: 1,
      minConcurrency: 1,
      meter: metrics.meter,
      loadSheddingEnabled: false,
      callback: async () => {
        await flushHung;
      },
    });
    cleanups.push(async () => {
      releaseFlush?.();
      await scheduler.shutdown();
      await metrics.shutdown();
    });

    scheduler.addToBatch([{ id: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    scheduler.addToBatch([{ id: 2 }]);

    // Must track the first batch, not the second: the age of a backlog is the age of its head.
    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(
          gaugeValue(rm, "ingest.flush.oldest_pending_age", { scheduler: "backlog_events" })
        ).toBeGreaterThan(250);
      },
      { timeout: 4000, interval: 50 }
    );

    releaseFlush?.();
  });
});
