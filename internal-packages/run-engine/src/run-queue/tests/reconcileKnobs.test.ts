import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Decimal } from "@trigger.dev/database";
import { describe } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue, type RunQueueOptions } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

/**
 * Bounds and telemetry of the saturated-set reconcile. Every test drives the dequeue
 * script directly through the test-only master-queue entry point with the background
 * consumers off, so one call is exactly one script execution and the assertions are
 * about what that single execution did.
 */

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
  masterQueueConsumersDisabled: true,
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const SHARD_COUNT = 2;
const QUEUE = "task/my-task";

function createQueue(
  redisContainer: any,
  overrides: Pick<RunQueueOptions, "reconcile" | "gatesEnabled" | "meter"> = {}
) {
  return new RunQueue({
    ...testOptions,
    shardCount: SHARD_COUNT,
    totalConcurrencyEnabled: true,
    ...overrides,
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: {
        keyPrefix: "runqueue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      keys: testOptions.keys,
    }),
    redis: {
      keyPrefix: "runqueue:test:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    },
  });
}

function makeMessage(overrides: Partial<InputPayload> = {}): InputPayload {
  return {
    runId: "r1",
    taskIdentifier: QUEUE,
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "DEVELOPMENT",
    queue: QUEUE,
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  };
}

/** One dequeue script execution against every eligible queue of the environment. */
async function dequeueOnce(queue: RunQueue) {
  const shard = testOptions.keys.masterQueueShardForEnvironment(
    authenticatedEnvDev.id,
    SHARD_COUNT
  );
  return queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);
}

/** A saturated total cap: `deadCount` members with no message key and a total limit of 1. */
async function saturateGroup(queue: RunQueue, deadCount: number) {
  const keys = testOptions.keys;
  const groupKey = keys.queueGroupConcurrencyKey(authenticatedEnvDev, QUEUE);
  await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 5);
  await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);
  const dead = Array.from({ length: deadCount }, (_, i) => `dead-${i}`);
  await queue.redis.sadd(groupKey, ...dead);
  await queue.enqueueMessage({
    env: authenticatedEnvDev,
    message: makeMessage({ runId: "r0", timestamp: Date.now() - 1000 }),
    workerQueue: "main",
  });
  return groupKey;
}

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue reconcile knobs", () => {
  redisTest(
    "disabled reconcile leaves a leaked member holding the set",
    async ({ redisContainer }) => {
      const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      });
      const provider = new MeterProvider({ readers: [reader] });
      const queue = createQueue(redisContainer, {
        reconcile: { enabled: false },
        meter: provider.getMeter("run-queue-test"),
      });
      try {
        const groupKey = await saturateGroup(queue, 1);

        expect(await dequeueOnce(queue)).toHaveLength(0);
        expect(await dequeueOnce(queue)).toHaveLength(0);

        expect(await queue.redis.scard(groupKey)).toBe(1);
        expect(await queue.redis.exists(`${groupKey}:reconcileLock`)).toBe(0);

        /** Self-heal is off, but the saturation it would have handled is still counted. */
        await reader.forceFlush();
        const skipped = exporter
          .getMetrics()
          .flatMap((r) => r.scopeMetrics)
          .flatMap((s) => s.metrics)
          .find((m) => m.descriptor.name === "runqueue.reconcile.skipped");
        expect(skipped?.dataPoints.map((p) => [p.attributes.reason, p.value])).toEqual([
          ["disabled", 2],
        ]);
      } finally {
        await queue.quit();
        await provider.shutdown();
      }
    }
  );

  redisTest("scanCount bounds the members one pass inspects", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { reconcile: { scanCount: 50 } });
    try {
      const groupKey = await saturateGroup(queue, 1200);

      expect(await dequeueOnce(queue)).toHaveLength(0);

      /**
       * SSCAN walks buckets until the page reaches COUNT, so one page of a
       * hashtable-encoded set is COUNT plus at most the last bucket's chain.
       * Anything in (0, 100] proves the pass ran and was bounded well below the
       * 1,200-member set.
       */
      const pruned = 1200 - (await queue.redis.scard(groupKey));
      expect(pruned).toBeGreaterThan(0);
      expect(pruned).toBeLessThanOrEqual(100);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "a scanCount above the set size drains the leak in one pass",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { reconcile: { scanCount: 5000 } });
      try {
        const groupKey = await saturateGroup(queue, 1200);

        /** The pass empties the set and the same script admits r0 into it. */
        const admitted = await dequeueOnce(queue);
        expect(admitted.map((m) => m.messageId)).toEqual(["r0"]);
        expect(await queue.redis.smembers(groupKey)).toEqual(["r0"]);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "lockTtlSeconds sets how long a set stays locked after a pass",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { reconcile: { lockTtlSeconds: 3 } });
      try {
        const groupKey = await saturateGroup(queue, 300);

        expect(await dequeueOnce(queue)).toHaveLength(0);

        const ttlMs = await queue.redis.pttl(`${groupKey}:reconcileLock`);
        expect(ttlMs).toBeGreaterThan(0);
        expect(ttlMs).toBeLessThanOrEqual(3_000);

        /** A second script while locked does no work: cardinality is unchanged. */
        const afterFirst = await queue.redis.scard(groupKey);
        expect(await dequeueOnce(queue)).toHaveLength(0);
        expect(await queue.redis.scard(groupKey)).toBe(afterFirst);
      } finally {
        await queue.quit();
      }
    }
  );

  /**
   * Two runs in one queue, each gated on a different saturated gate. The dequeue loop
   * visits both in one script, so the number of gate sets pruned is exactly the number
   * of passes the budget allowed.
   */
  async function saturateTwoGates(queue: RunQueue) {
    const keys = testOptions.keys;
    await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 5);
    await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "gate-a", 1);
    await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "gate-b", 1);
    const gateA = keys.queueCurrentConcurrencyKey(authenticatedEnvDev, "gate-a");
    const gateB = keys.queueCurrentConcurrencyKey(authenticatedEnvDev, "gate-b");
    await queue.redis.sadd(gateA, "dead-a");
    await queue.redis.sadd(gateB, "dead-b");
    await queue.enqueueMessage({
      env: authenticatedEnvDev,
      message: makeMessage({
        runId: "r0",
        timestamp: Date.now() - 2000,
        gates: [{ queue: "gate-a" }],
      }),
      workerQueue: "main",
    });
    await queue.enqueueMessage({
      env: authenticatedEnvDev,
      message: makeMessage({
        runId: "r1",
        timestamp: Date.now() - 1000,
        gates: [{ queue: "gate-b" }],
      }),
      workerQueue: "main",
    });
    return { gateA, gateB };
  }

  redisTest("maxPassesPerDequeue caps passes within one script", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, {
      gatesEnabled: true,
      reconcile: { maxPassesPerDequeue: 1 },
    });
    try {
      const { gateA, gateB } = await saturateTwoGates(queue);

      expect(await dequeueOnce(queue)).toHaveLength(0);

      expect(await queue.redis.scard(gateA)).toBe(0);
      expect(await queue.redis.scard(gateB)).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("a budget of two reconciles both gates in one script", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, {
      gatesEnabled: true,
      reconcile: { maxPassesPerDequeue: 2 },
    });
    try {
      const { gateA, gateB } = await saturateTwoGates(queue);

      expect(await dequeueOnce(queue)).toHaveLength(0);

      expect(await queue.redis.scard(gateA)).toBe(0);
      expect(await queue.redis.scard(gateB)).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("a budget of zero never prunes", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, {
      gatesEnabled: true,
      reconcile: { maxPassesPerDequeue: 0 },
    });
    try {
      const { gateA, gateB } = await saturateTwoGates(queue);

      expect(await dequeueOnce(queue)).toHaveLength(0);

      expect(await queue.redis.scard(gateA)).toBe(1);
      expect(await queue.redis.scard(gateB)).toBe(1);
      expect(await queue.redis.exists(`${gateA}:reconcileLock`)).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("reconcile work is metered on the run-queue meter", async ({ redisContainer }) => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const provider = new MeterProvider({ readers: [reader] });
    const queue = createQueue(redisContainer, {
      gatesEnabled: true,
      reconcile: { maxPassesPerDequeue: 1 },
      meter: provider.getMeter("run-queue-test"),
    });
    try {
      await saturateTwoGates(queue);
      expect(await dequeueOnce(queue)).toHaveLength(0);

      await reader.forceFlush();
      const metrics = exporter
        .getMetrics()
        .flatMap((r) => r.scopeMetrics)
        .flatMap((s) => s.metrics);
      const byName = (name: string) => metrics.find((m) => m.descriptor.name === name);

      const passes = byName("runqueue.reconcile.passes");
      expect(passes?.dataPoints.map((p) => [p.attributes.set_kind, p.value])).toEqual([
        ["gate", 1],
      ]);

      const skipped = byName("runqueue.reconcile.skipped");
      expect(skipped?.dataPoints.map((p) => [p.attributes.reason, p.value])).toEqual([
        ["budget", 1],
      ]);

      const pruned = byName("runqueue.reconcile.pruned");
      expect(pruned?.dataPoints.map((p) => [p.attributes.rule, p.value])).toEqual([["gone", 1]]);

      const scanned = byName("runqueue.reconcile.scanned");
      expect(scanned?.dataPoints[0]?.value).toBe(1);

      const unblocked = byName("runqueue.reconcile.unblocked");
      expect(unblocked?.dataPoints[0]?.value).toBe(1);

      const duration = byName("runqueue.dequeue.script.duration");
      const reconciledPoint = duration?.dataPoints.find((p) => p.attributes.reconciled === true);
      expect(reconciledPoint?.attributes.script).toBe("queue");
      expect(reconciledPoint?.value).toMatchObject({ count: 1 });
    } finally {
      await queue.quit();
      await provider.shutdown();
    }
  });

  redisTest(
    "a dequeue with nothing to reconcile records only the duration",
    async ({ redisContainer }) => {
      const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      });
      const provider = new MeterProvider({ readers: [reader] });
      const queue = createQueue(redisContainer, { meter: provider.getMeter("run-queue-test") });
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 5);
        await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, QUEUE, 3);
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "r0", timestamp: Date.now() - 1000 }),
          workerQueue: "main",
        });

        /** The enqueue fast path may already have admitted r0; either way the script ran once. */
        await dequeueOnce(queue);

        await reader.forceFlush();
        const metrics = exporter
          .getMetrics()
          .flatMap((r) => r.scopeMetrics)
          .flatMap((s) => s.metrics);
        const names = metrics.filter((m) => m.dataPoints.length > 0).map((m) => m.descriptor.name);

        expect(names).toContain("runqueue.dequeue.script.duration");
        expect(names).not.toContain("runqueue.reconcile.passes");
        expect(names).not.toContain("runqueue.reconcile.pruned");

        const duration = metrics.find(
          (m) => m.descriptor.name === "runqueue.dequeue.script.duration"
        );
        expect(duration?.dataPoints.every((p) => p.attributes.reconciled === false)).toBe(true);
      } finally {
        await queue.quit();
        await provider.shutdown();
      }
    }
  );
});
