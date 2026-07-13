import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OtlpWorkerPool } from "~/v3/otlpWorkerPool.server";
import { createInMemoryMetrics } from "./utils/tracing";
import { gaugeValue, histogramCount, latestMetrics, metricSum } from "./otlpMetrics.helpers";

const echoWorker = fileURLToPath(new URL("./fixtures/otlpEchoWorker.cjs", import.meta.url));
const errorWorker = fileURLToPath(new URL("./fixtures/otlpErrorWorker.cjs", import.meta.url));

const config = { spanAttributeValueLengthLimit: 8192, defaultEventStore: "clickhouse" };
const payload = () => new Uint8Array([1, 2, 3, 4]);

describe("OtlpWorkerPool self-observability", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it("records task/compute duration, outcome counts and gauges for successful tasks", async () => {
    const metrics = createInMemoryMetrics();
    const pool = new OtlpWorkerPool(2, echoWorker, [], metrics.meter);
    cleanups.push(async () => {
      await pool.shutdown();
      await metrics.shutdown();
    });

    await Promise.all([
      pool.runTransform("traces", payload(), config),
      pool.runTransform("logs", payload(), config),
      pool.runTransform("traces", payload(), config),
    ]);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.worker_pool.tasks", { kind: "traces", outcome: "ok" })).toBe(
          2
        );
        expect(metricSum(rm, "ingest.worker_pool.tasks", { kind: "logs", outcome: "ok" })).toBe(1);
      },
      { timeout: 5000, interval: 50 }
    );

    const rm = await latestMetrics(metrics);
    expect(histogramCount(rm, "ingest.worker_pool.task.duration")).toBeGreaterThanOrEqual(3);
    // The worker reports its own compute time; the pool records it on the main thread.
    expect(histogramCount(rm, "ingest.worker_pool.compute.duration")).toBeGreaterThanOrEqual(3);
    expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "alive" })).toBe(2);
    expect(gaugeValue(rm, "ingest.worker_pool.queue_depth")).toBeDefined();
  });

  it("records a failed-task outcome when the worker reports an error", async () => {
    const metrics = createInMemoryMetrics();
    const pool = new OtlpWorkerPool(1, errorWorker, [], metrics.meter);
    cleanups.push(async () => {
      await pool.shutdown();
      await metrics.shutdown();
    });

    await expect(pool.runTransform("metrics", payload(), config)).rejects.toThrow();

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(
          metricSum(rm, "ingest.worker_pool.tasks", { kind: "metrics", outcome: "error" })
        ).toBe(1);
      },
      { timeout: 5000, interval: 50 }
    );
  });

  it("rejects new work once shutdown has started", async () => {
    const pool = new OtlpWorkerPool(2, echoWorker, []);
    // A task before shutdown resolves normally.
    await expect(pool.runTransform("traces", payload(), config)).resolves.toBeDefined();

    await pool.shutdown();

    await expect(pool.runTransform("traces", payload(), config)).rejects.toThrow(/shutting down/);
    // Shutting down twice is a no-op.
    await expect(pool.shutdown()).resolves.toBeUndefined();
  });
});
