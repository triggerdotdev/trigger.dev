import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";
import { Decimal } from "@trigger.dev/database";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "warn"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const QUEUE = "task/my-task";
const WORKER_QUEUE = "main";

function createQueue(redisContainer: { getHost(): string; getPort(): number }) {
  return new RunQueue({
    ...testOptions,
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
    taskIdentifier: "task/my-task",
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "DEVELOPMENT",
    queue: QUEUE,
    timestamp: Date.now() - 1000,
    attempt: 0,
    ...overrides,
  };
}

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue.slotHoldersOfQueue", () => {
  redisTest("CK holder admitted, then dequeued", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      // r1 takes the fast path (never touches the variant zset); r2 goes slow so the
      // variant lands in ckIndex, which is what makes r1 enumerable.
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r1", concurrencyKey: "ck-a" }),
        workerQueue: WORKER_QUEUE,
        skipDequeueProcessing: true,
        enableFastPath: true,
      });
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r2", concurrencyKey: "ck-a" }),
        workerQueue: WORKER_QUEUE,
        skipDequeueProcessing: true,
      });

      const admitted = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE);
      expect(admitted.holders).toEqual([
        { runId: "r1", concurrencyKey: "ck-a", phase: "admitted" },
      ]);
      expect(admitted.admittedCount).toBe(1);
      expect(admitted.dequeuedCount).toBe(0);
      expect(admitted.runningReported).toBe(0);
      expect(admitted.truncated).toBe(false);
      expect(admitted.unlistedRunning).toBe(0);
      expect(admitted.consistency).toBe("consistent");

      const dequeued = await queue.dequeueMessageFromWorkerQueue("consumer_1", WORKER_QUEUE);
      expect(dequeued?.messageId).toBe("r1");

      const after = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE);
      expect(after.holders).toEqual([{ runId: "r1", concurrencyKey: "ck-a", phase: "dequeued" }]);
      expect(after.dequeuedCount).toBe(1);
      expect(after.runningReported).toBe(1);
      expect(after.unlistedRunning).toBe(0);
      expect(after.consistency).toBe("consistent");
    } finally {
      await queue.quit();
    }
  });

  redisTest("non-CK queue with one admitted and one dequeued", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      for (const runId of ["r1", "r2"]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId }),
          workerQueue: WORKER_QUEUE,
          skipDequeueProcessing: true,
          enableFastPath: true,
        });
      }

      const dequeued = await queue.dequeueMessageFromWorkerQueue("consumer_1", WORKER_QUEUE);
      expect(dequeued?.messageId).toBe("r1");

      const result = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE);
      expect(result.holders).toHaveLength(2);
      expect(result.holders.every((holder) => holder.concurrencyKey === null)).toBe(true);
      expect(result.holders.find((holder) => holder.runId === "r1")?.phase).toBe("dequeued");
      expect(result.holders.find((holder) => holder.runId === "r2")?.phase).toBe("admitted");
      expect(result.admittedCount).toBe(2);
      expect(result.dequeuedCount).toBe(1);
      expect(result.runningReported).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.unlistedRunning).toBe(0);
      expect(result.consistency).toBe("consistent");
    } finally {
      await queue.quit();
    }
  });

  redisTest("a wrong runningCounter is reported as a mismatch", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r1", concurrencyKey: "ck-a" }),
        workerQueue: WORKER_QUEUE,
        skipDequeueProcessing: true,
        enableFastPath: true,
      });
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r2", concurrencyKey: "ck-a" }),
        workerQueue: WORKER_QUEUE,
        skipDequeueProcessing: true,
      });

      const baseline = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE);
      expect(baseline.consistency).toBe("consistent");

      // Control break: the counter no longer matches the enumerated members.
      await queue.redis.set(
        testOptions.keys.queueRunningCounterKey(authenticatedEnvDev, QUEUE),
        "7"
      );

      const broken = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE);
      expect(broken.consistency).toBe("mismatch");
      expect(broken.holders).toEqual([{ runId: "r1", concurrencyKey: "ck-a", phase: "admitted" }]);
      expect(broken.runningReported).toBe(7);
      expect(broken.unlistedRunning).toBe(7);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "running-only CK variant outside ckIndex is reported as unlisted",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        // A CK variant whose messages have all been dequeued is not in ckIndex, so its
        // members can't be enumerated — the counter is the only evidence they exist.
        const variant = testOptions.keys.queueKey(authenticatedEnvDev, QUEUE, "ck-a");
        await queue.redis.sadd(`${variant}:currentConcurrency`, "r1");
        await queue.redis.sadd(`${variant}:currentDequeued`, "r1");
        await queue.redis.set(
          testOptions.keys.queueRunningCounterKey(authenticatedEnvDev, QUEUE),
          "1"
        );

        const result = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE);
        expect(result.holders).toEqual([]);
        expect(result.runningReported).toBe(1);
        expect(result.unlistedRunning).toBe(1);
        expect(result.consistency).toBe("mismatch");
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("a lone fast-path CK holder is simply not listed", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      // Nothing queued on the variant means no ckIndex entry, so this holder can't be
      // enumerated. No field claims otherwise — the payload just doesn't mention it.
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r1", concurrencyKey: "ck-a" }),
        workerQueue: WORKER_QUEUE,
        skipDequeueProcessing: true,
        enableFastPath: true,
      });

      const result = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE);
      expect(result).toEqual({
        holders: [],
        admittedCount: 0,
        dequeuedCount: 0,
        runningReported: 0,
        truncated: false,
        unlistedRunning: 0,
        consistency: "consistent",
      });
      expect(result).not.toHaveProperty("holderResolution");
    } finally {
      await queue.quit();
    }
  });

  redisTest("caps the holder list and reports it as truncated", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      for (let i = 0; i < 3; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `r${i}` }),
          workerQueue: WORKER_QUEUE,
          skipDequeueProcessing: true,
          enableFastPath: true,
        });
      }

      const result = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE, { limit: 2 });
      expect(result.holders).toHaveLength(2);
      expect(result.admittedCount).toBe(3);
      expect(result.truncated).toBe(true);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "caps the number of CK variants scanned and reports it as truncated",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        // Per variant: a fast-path holder plus a slow-path message, so the variant lands
        // in ckIndex (enumerable) and has one admitted holder.
        for (let i = 0; i < 3; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `r${i}a`, concurrencyKey: `ck-${i}` }),
            workerQueue: WORKER_QUEUE,
            skipDequeueProcessing: true,
            enableFastPath: true,
          });
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `r${i}b`, concurrencyKey: `ck-${i}` }),
            workerQueue: WORKER_QUEUE,
            skipDequeueProcessing: true,
          });
        }

        const capped = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE, {
          maxVariants: 2,
        });
        expect(capped.holders).toHaveLength(2);
        expect(capped.truncated).toBe(true);

        const uncapped = await queue.slotHoldersOfQueue(authenticatedEnvDev, QUEUE, {
          maxVariants: 10,
        });
        expect(uncapped.holders).toHaveLength(3);
        expect(uncapped.truncated).toBe(false);
      } finally {
        await queue.quit();
      }
    }
  );
});
