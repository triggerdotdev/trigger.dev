import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  allStreamKeys,
  MetricsStreamEmitter,
  type MetricDefinition,
} from "@internal/metrics-pipeline";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { describe, expect } from "vitest";
import { FairQueueSelectionStrategy } from "./fairQueueSelectionStrategy.js";
import { RunQueue } from "./index.js";
import { RunQueueFullKeyProducer } from "./keyProducer.js";
import type { InputPayload } from "./types.js";

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(1.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

// A dead Redis leaves waitUntilReady() pending forever (the client retries
// indefinitely), which would burn the whole test timeout with no diagnostic.
// The abort releases the losing timer promptly so it cannot hold an event
// loop open for the remaining 15s after a fast ready.
async function emitterReady(emitter: MetricsStreamEmitter) {
  const abort = new AbortController();
  const timedOut = setTimeout(15_000, "timeout", { signal: abort.signal }).catch(() => "aborted");
  const winner = await Promise.race([emitter.waitUntilReady().then(() => "ready"), timedOut]);
  abort.abort();
  if (winner === "timeout") {
    await emitter.close().catch(() => {});
    throw new Error("metrics emitter Redis connection never became ready");
  }
}

async function readAllEntries(
  redisOptions: {
    host: string;
    port: number;
  },
  definition: MetricDefinition
) {
  const client = createRedisClient({ ...redisOptions, keyPrefix: undefined });
  const entries: Array<{ id: string; fields: Record<string, string> }> = [];
  for (const key of allStreamKeys(definition)) {
    const raw = (await client.xrange(key, "-", "+")) as Array<[string, string[]]>;
    for (const [id, flat] of raw) {
      const fields: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
      entries.push({ id, fields });
    }
  }
  await client.quit();
  return entries;
}

// Gauges now land via a fire-and-forget Node XADD after the script reply (not synchronously
// inside the Lua), so reads must poll until the expected entries appear.
async function waitForEntries(
  redisOptions: { host: string; port: number },
  definition: MetricDefinition,
  predicate: (entries: Array<{ id: string; fields: Record<string, string> }>) => boolean,
  timeoutMs = 5000
) {
  const start = Date.now();
  let entries = await readAllEntries(redisOptions, definition);
  while (!predicate(entries)) {
    if (Date.now() - start > timeoutMs) return entries;
    await setTimeout(50);
    entries = await readAllEntries(redisOptions, definition);
  }
  return entries;
}

describe("RunQueue queue-metrics emission", () => {
  redisTest("emits gauge + enqueue/started/ack events when enabled", async ({ redisContainer }) => {
    const redis = {
      keyPrefix: "runqueue:test:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    };
    const definition: MetricDefinition = {
      name: `qm_test_${Date.now()}`,
      shardCount: 2,
      consumerGroup: "cg",
      maxLen: 1000,
    };
    const emitter = new MetricsStreamEmitter({
      redis,
      definition,
      flag: { enabled: () => true },
    });
    await emitterReady(emitter);

    const queue = new RunQueue({
      name: "rq",
      tracer: trace.getTracer("rq"),
      defaultEnvConcurrency: 25,
      logger: new Logger("RunQueue", "error"),
      keys: new RunQueueFullKeyProducer(),
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        redis,
        keys: new RunQueueFullKeyProducer(),
      }),
      redis,
      queueMetrics: emitter,
    });

    const message: InputPayload = {
      runId: "r-metrics",
      taskIdentifier: "task/my-task",
      orgId: "o1234",
      projectId: "p1234",
      environmentId: authenticatedEnvDev.id,
      environmentType: "DEVELOPMENT",
      queue: "task/my-task",
      timestamp: Date.now(),
      eligibleAtMs: Date.now() - 500,
      attempt: 0,
    };

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message,
        workerQueue: authenticatedEnvDev.id,
      });
      await setTimeout(1000);
      const dequeued = await queue.dequeueMessageFromWorkerQueue("c1", authenticatedEnvDev.id);
      expect(dequeued?.messageId).toBe(message.runId);
      await queue.acknowledgeMessage(message.orgId, message.runId);
      await setTimeout(100);

      const entries = await waitForEntries(redis, definition, (es) => {
        const seen = es.map((e) => e.fields.op);
        if (!["enqueue", "gauge", "started", "ack"].every((o) => seen.includes(o))) return false;
        return es.some(
          (e) => e.fields.op === "gauge" && e.fields.cc === "1" && e.fields.ql === "0"
        );
      });
      const ops = entries.map((e) => e.fields.op);
      expect(ops).toContain("enqueue");
      expect(ops).toContain("gauge");
      expect(ops).toContain("started");
      expect(ops).toContain("ack");

      const gauge = entries.find((e) => e.fields.op === "gauge");
      assertGauge(gauge);
      expect(gauge!.fields.q).toContain("task/my-task");
      for (const f of ["ql", "cc", "lim", "eql", "ec", "elim", "thr"]) {
        expect(gauge!.fields[f]).toBeDefined();
      }
      // Non-CK scripts keep the 7-field gauge (no CK-health tail).
      expect(gauge!.fields.ckq).toBeUndefined();
      expect(gauge!.fields.ckw).toBeUndefined();

      // Pins the dequeue script's sample-at-return wrapper: only the dequeue emits the
      // post-admission reading (running 1, queued 0); the enqueue gauge sees the inverse.
      const dequeueGauge = entries.find(
        (e) => e.fields.op === "gauge" && e.fields.cc === "1" && e.fields.ql === "0"
      );
      assertGauge(dequeueGauge);
      expect(dequeueGauge!.fields.q).toContain("task/my-task");

      // The first counter emission also seeds a cum=0 baseline (no wait); the real reading
      // carries wait. Pick the reading (cum > 0).
      const started = entries.find((e) => e.fields.op === "started" && Number(e.fields.cum) > 0);
      expect(started!.fields.wait).toBeDefined();
      expect(Number(started!.fields.wait)).toBeGreaterThanOrEqual(0);
      expect(Number(started!.fields.cum)).toBeGreaterThan(0);
    } finally {
      await queue.quit();
      await emitter.close();
    }
  });

  redisTest(
    "emits a fast-path gauge reusing the admission-check locals",
    async ({ redisContainer }) => {
      const redis = {
        keyPrefix: "runqueue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      };
      const definition: MetricDefinition = {
        name: `qm_fp_${Date.now()}`,
        shardCount: 2,
        consumerGroup: "cg",
        maxLen: 1000,
      };
      const emitter = new MetricsStreamEmitter({
        redis,
        definition,
        flag: { enabled: () => true },
      });
      await emitterReady(emitter);
      const queue = new RunQueue({
        name: "rq",
        tracer: trace.getTracer("rq"),
        defaultEnvConcurrency: 25,
        logger: new Logger("RunQueue", "error"),
        keys: new RunQueueFullKeyProducer(),
        queueSelectionStrategy: new FairQueueSelectionStrategy({
          redis,
          keys: new RunQueueFullKeyProducer(),
        }),
        redis,
        queueMetrics: emitter,
      });

      const message: InputPayload = {
        runId: "r-fastpath",
        taskIdentifier: "task/my-task",
        orgId: "o1234",
        projectId: "p1234",
        environmentId: authenticatedEnvDev.id,
        environmentType: "DEVELOPMENT",
        queue: "task/my-task",
        timestamp: Date.now(),
        attempt: 0,
      };

      try {
        // enableFastPath + empty queue + zero concurrency => the Lua takes the fast path,
        // so the gauge runs the reuse snippet (queueCurrent/envCurrent/queueLimit/envLimit).
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message,
          workerQueue: authenticatedEnvDev.id,
          enableFastPath: true,
        });
        const dequeued = await queue.dequeueMessageFromWorkerQueue("c1", authenticatedEnvDev.id);
        expect(dequeued?.messageId).toBe(message.runId);

        const entries = await waitForEntries(
          redis,
          definition,
          (es) =>
            es.some((e) => e.fields.op === "gauge") && es.some((e) => e.fields.op === "enqueue")
        );
        const gauge = entries.find((e) => e.fields.op === "gauge");
        assertGauge(gauge);
        for (const f of ["ql", "cc", "lim", "eql", "ec", "elim", "thr"]) {
          expect(gauge!.fields[f]).toBeDefined();
        }
        // Fast path was taken => capacity was available => not throttled.
        expect(gauge!.fields.thr).toBe("0");
        expect(entries.some((e) => e.fields.op === "enqueue")).toBe(true);
      } finally {
        await queue.quit();
        await emitter.close();
      }
    }
  );

  redisTest("emits an aggregate gauge for CK queues at dequeue", async ({ redisContainer }) => {
    const redis = {
      keyPrefix: "runqueue:test:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    };
    const definition: MetricDefinition = {
      name: `qm_ck_${Date.now()}`,
      shardCount: 2,
      consumerGroup: "cg",
      maxLen: 1000,
    };
    const emitter = new MetricsStreamEmitter({ redis, definition, flag: { enabled: () => true } });
    await emitterReady(emitter);
    const queue = new RunQueue({
      name: "rq",
      tracer: trace.getTracer("rq"),
      defaultEnvConcurrency: 25,
      logger: new Logger("RunQueue", "error"),
      keys: new RunQueueFullKeyProducer(),
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        redis,
        keys: new RunQueueFullKeyProducer(),
      }),
      redis,
      queueMetrics: emitter,
    });

    const message: InputPayload = {
      runId: "r-ck",
      taskIdentifier: "task/my-task",
      orgId: "o1234",
      projectId: "p1234",
      environmentId: authenticatedEnvDev.id,
      environmentType: "DEVELOPMENT",
      queue: "task/my-task",
      concurrencyKey: "tenant-1",
      timestamp: Date.now(),
      eligibleAtMs: Date.now() - 300,
      attempt: 0,
    };

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message,
        workerQueue: authenticatedEnvDev.id,
      });
      await setTimeout(1000);
      const dequeued = await queue.dequeueMessageFromWorkerQueue("c1", authenticatedEnvDev.id);
      expect(dequeued?.messageId).toBe(message.runId);

      const entries = await waitForEntries(redis, definition, (es) =>
        es.some((e) => e.fields.op === "gauge" && e.fields.q.includes(":ck:*"))
      );
      const gauges = entries.filter((e) => e.fields.op === "gauge");
      expect(gauges.length).toBeGreaterThan(0);
      // The aggregate gauge targets the CK wildcard and only the CK dequeue script emits
      // it, so this pins that script's sample-at-return wrapper.
      const aggregate = gauges.find((e) => e.fields.q.includes(":ck:*"));
      assertGauge(aggregate);
      expect(Number(aggregate!.fields.ql)).toBeGreaterThanOrEqual(0);
      expect(Number(aggregate!.fields.cc)).toBeGreaterThanOrEqual(0);

      // Every CK-path gauge carries the CK-health tail; the enqueue-time reading (and the
      // pre-dequeue aggregate reading) sees the backlogged key.
      const ckGauges = gauges.filter((e) => e.fields.q.includes(":ck:"));
      for (const g of ckGauges) {
        expect(g.fields.ckq).toBeDefined();
        expect(g.fields.ckw).toBeDefined();
        expect(Number(g.fields.ckw)).toBeGreaterThanOrEqual(0);
      }
      expect(ckGauges.some((g) => Number(g.fields.ckq) >= 1)).toBe(true);

      // CK counter entries carry both odometers: the reading has cum + ck/ckcum, and each
      // odometer seeds its own baseline entry (cum-only vs ck+ckcum-only).
      const enqueues = entries.filter((e) => e.fields.op === "enqueue");
      const reading = enqueues.find((e) => e.fields.cum != null && e.fields.ckcum != null);
      expect(reading).toBeDefined();
      expect(reading!.fields.ck).toBe("tenant-1");
      expect(reading!.fields.q).not.toContain(":ck:");
      expect(Number(reading!.fields.cum)).toBe(1);
      expect(Number(reading!.fields.ckcum)).toBe(1);
      const baseBaseline = enqueues.find((e) => e.fields.cum === "0" && e.fields.ck == null);
      expect(baseBaseline).toBeDefined();
      const ckBaseline = enqueues.find((e) => e.fields.ckcum === "0" && e.fields.cum == null);
      expect(ckBaseline).toBeDefined();
      expect(ckBaseline!.fields.ck).toBe("tenant-1");
    } finally {
      await queue.quit();
      await emitter.close();
    }
  });

  redisTest("gauge sampling gates gauges but not counters", async ({ redisContainer }) => {
    const redis = {
      keyPrefix: "runqueue:test:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    };
    const definition: MetricDefinition = {
      name: `qm_sample_${Date.now()}`,
      shardCount: 2,
      consumerGroup: "cg",
      maxLen: 1000,
    };
    // gaugeSampleRate 0 => sampledSync() always false => Lua gauge never fires; counters still do.
    const emitter = new MetricsStreamEmitter({
      redis,
      definition,
      flag: { enabled: () => true },
      gaugeSampleRate: 0,
    });
    await emitterReady(emitter);
    const queue = new RunQueue({
      name: "rq",
      tracer: trace.getTracer("rq"),
      defaultEnvConcurrency: 25,
      logger: new Logger("RunQueue", "error"),
      keys: new RunQueueFullKeyProducer(),
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        redis,
        keys: new RunQueueFullKeyProducer(),
      }),
      redis,
      queueMetrics: emitter,
    });

    const message: InputPayload = {
      runId: "r-sample",
      taskIdentifier: "task/my-task",
      orgId: "o1234",
      projectId: "p1234",
      environmentId: authenticatedEnvDev.id,
      environmentType: "DEVELOPMENT",
      queue: "task/my-task",
      timestamp: Date.now(),
      attempt: 0,
    };

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message,
        workerQueue: authenticatedEnvDev.id,
      });
      await setTimeout(1000);
      await queue.dequeueMessageFromWorkerQueue("c1", authenticatedEnvDev.id);

      // Poll until the counter (enqueue) lands; by then a gauge would have too, if sampled in.
      const entries = await waitForEntries(redis, definition, (es) =>
        es.some((e) => e.fields.op === "enqueue")
      );
      expect(entries.some((e) => e.fields.op === "gauge")).toBe(false);
      expect(entries.some((e) => e.fields.op === "enqueue")).toBe(true);
    } finally {
      await queue.quit();
      await emitter.close();
    }
  });
});

function assertGauge(gauge: unknown): asserts gauge {
  if (!gauge) throw new Error("expected a gauge entry");
}
