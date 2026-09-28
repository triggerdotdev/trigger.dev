import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OtlpWorkerPool, type ReapEvent } from "~/v3/otlpWorkerPool.server";
import { createInMemoryMetrics } from "./utils/tracing";
import { gaugeValue, histogramCount, latestMetrics, metricSum } from "./otlpMetrics.helpers";

const slowWorker = fileURLToPath(new URL("./fixtures/otlpSlowWorker.cjs", import.meta.url));
const hangWorker = fileURLToPath(new URL("./fixtures/otlpHangWorker.cjs", import.meta.url));

const config = { spanAttributeValueLengthLimit: 8192, defaultEventStore: "clickhouse" };
const payload = () => new Uint8Array([1, 2, 3, 4]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("OtlpWorkerPool task timeouts", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    delete process.env.OTLP_SLOW_WORKER_DELAY_MS;
    delete process.env.OTLP_SLOW_WORKER_HANG_AFTER;
  });

  it("keeps a healthy worker alive when queued tasks exceed their deadline under overload", async () => {
    const taskTimeoutMs = 500;
    const computeMs = 20;
    const arrivalIntervalMs = 10;
    const runMs = 3000;
    process.env.OTLP_SLOW_WORKER_DELAY_MS = String(computeMs);

    const metrics = createInMemoryMetrics();
    const pool = new OtlpWorkerPool(1, slowWorker, [], metrics.meter, {
      taskTimeoutMs,
      respawnBaseMs: 50,
      respawnMaxMs: 200,
    });
    cleanups.push(async () => {
      await pool.shutdown();
      await metrics.shutdown();
    });

    let resolved = 0;
    let rejected = 0;
    const pending: Promise<unknown>[] = [];
    const aliveSamples: Array<number | undefined> = [];
    const okSamples: number[] = [];

    const startedAt = Date.now();
    const enqueue = setInterval(() => {
      const p = pool
        .runTransform("traces", payload(), config)
        .then(() => resolved++)
        .catch(() => rejected++);
      pending.push(p);
    }, arrivalIntervalMs);

    let lastSampleAt = startedAt;
    while (Date.now() - startedAt < runMs) {
      await sleep(25);
      if (Date.now() - startedAt >= 1000 && Date.now() - lastSampleAt >= 200) {
        lastSampleAt = Date.now();
        const rm = await latestMetrics(metrics);
        aliveSamples.push(gaugeValue(rm, "ingest.worker_pool.workers", { state: "alive" }));
        okSamples.push(metricSum(rm, "ingest.worker_pool.tasks", { outcome: "ok" }));
      }
    }
    clearInterval(enqueue);
    await Promise.all(pending);

    const rm = await latestMetrics(metrics);
    const summary = {
      resolved,
      rejected,
      respawnsTimeout: metricSum(rm, "ingest.worker_pool.respawns", { reason: "timeout" }),
      respawnsError: metricSum(rm, "ingest.worker_pool.respawns", { reason: "error" }),
      respawnsExit: metricSum(rm, "ingest.worker_pool.respawns", { reason: "exit" }),
      crash: metricSum(rm, "ingest.worker_pool.tasks", { outcome: "crash" }),
      ok: metricSum(rm, "ingest.worker_pool.tasks", { outcome: "ok" }),
      timeout: metricSum(rm, "ingest.worker_pool.tasks", { outcome: "timeout" }),
      stale: metricSum(rm, "ingest.worker_pool.tasks", { outcome: "stale" }),
      aliveSamples,
      okSamples,
    };
    console.log("overload summary", JSON.stringify(summary));

    expect(summary.timeout + summary.stale).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);

    expect(summary.respawnsTimeout).toBe(0);
    expect(summary.respawnsError).toBe(0);
    expect(summary.respawnsExit).toBe(0);
    expect(summary.crash).toBe(0);
    expect(aliveSamples.length).toBeGreaterThan(0);
    expect(aliveSamples.every((alive) => alive === 1)).toBe(true);
    expect(summary.ok).toBeGreaterThanOrEqual(50);
    expect(summary.ok).toBeGreaterThan(okSamples[0]!);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "alive" })).toBe(1);
      },
      { timeout: 2000, interval: 50 }
    );
  }, 15_000);

  it("lets a healthy worker finish a task whose caller deadline passed and reuses it", async () => {
    process.env.OTLP_SLOW_WORKER_DELAY_MS = "200";
    const metrics = createInMemoryMetrics();
    const pool = new OtlpWorkerPool(1, slowWorker, [], metrics.meter, {
      taskTimeoutMs: 300,
      respawnBaseMs: 50,
      respawnMaxMs: 200,
    });
    cleanups.push(async () => {
      await pool.shutdown();
      await metrics.shutdown();
    });
    await pool.runTransform("traces", payload(), config);

    const results = await Promise.allSettled([
      pool.runTransform("traces", payload(), config),
      pool.runTransform("traces", payload(), config),
      pool.runTransform("traces", payload(), config),
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/timed out/);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "idle" })).toBe(1);
      },
      { timeout: 2000, interval: 20 }
    );
    await expect(pool.runTransform("traces", payload(), config)).resolves.toBeDefined();

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.worker_pool.respawns")).toBe(0);
        expect(metricSum(rm, "ingest.worker_pool.tasks", { outcome: "crash" })).toBe(0);
        expect(histogramCount(rm, "ingest.worker_pool.task.duration")).toBe(5);
        expect(histogramCount(rm, "ingest.worker_pool.compute.duration")).toBe(4);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "alive" })).toBe(1);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "idle" })).toBe(1);
      },
      { timeout: 3000, interval: 50 }
    );
  });

  it("reaps a worker that hangs only after a full compute budget, not at the caller deadline", async () => {
    const taskTimeoutMs = 300;
    process.env.OTLP_SLOW_WORKER_DELAY_MS = "100";
    process.env.OTLP_SLOW_WORKER_HANG_AFTER = "2";
    const reaps: ReapEvent[] = [];
    const metrics = createInMemoryMetrics();
    const pool = new OtlpWorkerPool(1, slowWorker, [], metrics.meter, {
      taskTimeoutMs,
      respawnBaseMs: 50,
      respawnMaxMs: 200,
      onReap: (event) => reaps.push(event),
    });
    cleanups.push(async () => {
      await pool.shutdown();
      await metrics.shutdown();
    });
    await pool.runTransform("traces", payload(), config);

    const first = pool.runTransform("traces", payload(), config);
    const second = pool.runTransform("traces", payload(), config);
    await expect(first).resolves.toBeDefined();
    await expect(second).rejects.toThrow(/timed out/);
    const rejectedAt = Date.now();

    await vi.waitFor(
      () => {
        expect(reaps.some((event) => event.reason === "timeout")).toBe(true);
      },
      { timeout: 2000, interval: 10 }
    );
    const reapedAt = Date.now();
    const reap = reaps.find((event) => event.reason === "timeout")!;
    expect(reap.sinceDispatchMs).toBeGreaterThanOrEqual(taskTimeoutMs);
    expect(reap.sinceDispatchMs).toBeLessThan(taskTimeoutMs + 150);
    expect(reap.taskAgeMs).toBeGreaterThan(reap.sinceDispatchMs!);
    expect(reapedAt - rejectedAt).toBeGreaterThanOrEqual(50);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.worker_pool.respawns", { reason: "timeout" })).toBe(1);
        expect(metricSum(rm, "ingest.worker_pool.respawns")).toBe(1);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "alive" })).toBe(1);
      },
      { timeout: 3000, interval: 50 }
    );
  });

  it("keeps reaping and respawning when the onReap observer throws", async () => {
    const metrics = createInMemoryMetrics();
    const pool = new OtlpWorkerPool(1, hangWorker, [], metrics.meter, {
      taskTimeoutMs: 200,
      respawnBaseMs: 50,
      respawnMaxMs: 200,
      onReap: () => {
        throw new Error("observer boom");
      },
    });
    cleanups.push(async () => {
      await pool.shutdown();
      await metrics.shutdown();
    });

    await expect(pool.runTransform("traces", payload(), config)).rejects.toThrow(/timed out/);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.worker_pool.respawns", { reason: "timeout" })).toBe(1);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "alive" })).toBe(1);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "idle" })).toBe(1);
      },
      { timeout: 3000, interval: 50 }
    );
  });

  it("keeps reaping and respawning when the onReap observer rejects asynchronously", async () => {
    const metrics = createInMemoryMetrics();
    const pool = new OtlpWorkerPool(1, hangWorker, [], metrics.meter, {
      taskTimeoutMs: 200,
      respawnBaseMs: 50,
      respawnMaxMs: 200,
      onReap: async () => {
        throw new Error("async observer boom");
      },
    });
    cleanups.push(async () => {
      await pool.shutdown();
      await metrics.shutdown();
    });

    await expect(pool.runTransform("traces", payload(), config)).rejects.toThrow(/timed out/);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.worker_pool.respawns", { reason: "timeout" })).toBe(1);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "alive" })).toBe(1);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "idle" })).toBe(1);
      },
      { timeout: 3000, interval: 50 }
    );
  });

  it("reaps and respawns a worker that never replies", async () => {
    const metrics = createInMemoryMetrics();
    const pool = new OtlpWorkerPool(1, hangWorker, [], metrics.meter, {
      taskTimeoutMs: 200,
      respawnBaseMs: 50,
      respawnMaxMs: 200,
    });
    cleanups.push(async () => {
      await pool.shutdown();
      await metrics.shutdown();
    });

    await expect(pool.runTransform("traces", payload(), config)).rejects.toThrow(/timed out/);

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(metricSum(rm, "ingest.worker_pool.respawns", { reason: "timeout" })).toBe(1);
        expect(metricSum(rm, "ingest.worker_pool.tasks", { outcome: "timeout" })).toBe(1);
        expect(metricSum(rm, "ingest.worker_pool.tasks", { outcome: "crash" })).toBe(0);
      },
      { timeout: 3000, interval: 50 }
    );

    await vi.waitFor(
      async () => {
        const rm = await latestMetrics(metrics);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "alive" })).toBe(1);
        expect(gaugeValue(rm, "ingest.worker_pool.workers", { state: "idle" })).toBe(1);
      },
      { timeout: 3000, interval: 50 }
    );
  });
});
