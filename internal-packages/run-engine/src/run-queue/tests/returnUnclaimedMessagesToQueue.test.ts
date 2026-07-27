import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe } from "node:test";
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

const otherEnv = {
  id: "e5678",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const baseTimestamp = 1_745_000_000_000;

function messageFor(
  overrides: Partial<InputPayload> & Pick<InputPayload, "runId">,
  env = authenticatedEnvDev
): InputPayload {
  return {
    taskIdentifier: "task/my-task",
    orgId: env.organization.id,
    projectId: env.project.id,
    environmentId: env.id,
    environmentType: "DEVELOPMENT",
    queue: "task/my-task",
    timestamp: baseTimestamp,
    attempt: 0,
    ...overrides,
  };
}

function createRunQueue(redisContainer: { getHost(): string; getPort(): number }) {
  const redisOptions = {
    keyPrefix: "runqueue:test:",
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };

  return new RunQueue({
    ...testOptions,
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: redisOptions,
      keys: testOptions.keys,
    }),
    redis: redisOptions,
  });
}

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue.returnUnclaimedMessagesToQueue", () => {
  redisTest(
    "returns worker queue messages to the pending queue and releases their concurrency",
    async ({ redisContainer }) => {
      const queue = createRunQueue(redisContainer);

      try {
        for (const runId of ["r1", "r2", "r3"]) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: messageFor({ runId }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);

        expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(3);
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(0);
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(3);

        const result = await queue.returnUnclaimedMessagesToQueue({
          env: authenticatedEnvDev,
          queue: "task/my-task",
        });

        expect(result).toEqual({ returned: 3, skipped: 0 });

        expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(0);
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(3);
        expect(await queue.lengthOfEnvQueue(authenticatedEnvDev)).toBe(3);
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(0);
        expect(await queue.operationalCurrentConcurrencyOfEnvironment(authenticatedEnvDev)).toBe(0);
        expect(await queue.currentDequeuedOfQueue(authenticatedEnvDev, "task/my-task")).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "restores the original queue score so returned runs keep their place in line",
    async ({ redisContainer }) => {
      const queue = createRunQueue(redisContainer);

      try {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageFor({ runId: "r1", timestamp: baseTimestamp }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageFor({ runId: "r2", timestamp: baseTimestamp + 1_000 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageFor({ runId: "r3", timestamp: baseTimestamp + 2_000 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);

        await queue.returnUnclaimedMessagesToQueue({
          env: authenticatedEnvDev,
          queue: "task/my-task",
        });

        expect(await queue.oldestMessageInQueue(authenticatedEnvDev, "task/my-task")).toBe(
          baseTimestamp
        );

        await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);

        const first = await queue.dequeueMessageFromWorkerQueue("consumer", authenticatedEnvDev.id);
        const second = await queue.dequeueMessageFromWorkerQueue(
          "consumer",
          authenticatedEnvDev.id
        );
        const third = await queue.dequeueMessageFromWorkerQueue("consumer", authenticatedEnvDev.id);

        assertNonNullable(first);
        assertNonNullable(second);
        assertNonNullable(third);

        expect([first.messageId, second.messageId, third.messageId]).toEqual(["r1", "r2", "r3"]);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("does not return a run a worker has already claimed", async ({ redisContainer }) => {
    const queue = createRunQueue(redisContainer);

    try {
      for (const runId of ["r1", "r2"]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageFor({ runId }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);

      const claimed = await queue.dequeueMessageFromWorkerQueue("consumer", authenticatedEnvDev.id);
      assertNonNullable(claimed);
      expect(claimed.messageId).toBe("r1");

      const result = await queue.returnUnclaimedMessagesToQueue({
        env: authenticatedEnvDev,
        queue: "task/my-task",
      });

      expect(result.returned).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
      expect(await queue.oldestMessageInQueue(authenticatedEnvDev, "task/my-task")).toBe(
        baseTimestamp
      );

      expect(await queue.currentDequeuedOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
      expect(await queue.getCurrentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toEqual(
        ["r1"]
      );
    } finally {
      await queue.quit();
    }
  });

  redisTest("returns runs across every queue in the environment", async ({ redisContainer }) => {
    const queue = createRunQueue(redisContainer);

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageFor({ runId: "r1", queue: "task/queue-a" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageFor({ runId: "r2", queue: "task/queue-b" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);
      expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(2);

      const result = await queue.returnUnclaimedMessagesToQueue({ env: authenticatedEnvDev });

      expect(result.returned).toBe(2);
      expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(0);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/queue-a")).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/queue-b")).toBe(1);
      expect(await queue.operationalCurrentConcurrencyOfEnvironment(authenticatedEnvDev)).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("leaves other queues in the environment untouched", async ({ redisContainer }) => {
    const queue = createRunQueue(redisContainer);

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageFor({ runId: "r1", queue: "task/paused" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageFor({ runId: "r2", queue: "task/running" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);

      const result = await queue.returnUnclaimedMessagesToQueue({
        env: authenticatedEnvDev,
        queue: "task/paused",
      });

      expect(result.returned).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/paused")).toBe(1);
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/paused")).toBe(0);

      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/running")).toBe(0);
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/running")).toBe(1);
      expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("leaves other environments untouched", async ({ redisContainer }) => {
    const queue = createRunQueue(redisContainer);

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageFor({ runId: "r1" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      await queue.enqueueMessage({
        env: otherEnv,
        message: messageFor({ runId: "r2" }, otherEnv),
        workerQueue: otherEnv.id,
        skipDequeueProcessing: true,
      });

      await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);
      await queue.processMasterQueueForEnvironment(otherEnv.id, 10);

      await queue.returnUnclaimedMessagesToQueue({ env: authenticatedEnvDev });

      expect(await queue.operationalCurrentConcurrencyOfEnvironment(authenticatedEnvDev)).toBe(0);
      expect(await queue.operationalCurrentConcurrencyOfEnvironment(otherEnv)).toBe(1);
      expect(await queue.peekAllOnWorkerQueue(otherEnv.id)).toHaveLength(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "returns runs that skipped the pending queue via the fast path",
    async ({ redisContainer }) => {
      const queue = createRunQueue(redisContainer);

      try {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageFor({ runId: "r1" }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
          enableFastPath: true,
        });

        expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(1);
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(0);
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);

        const result = await queue.returnUnclaimedMessagesToQueue({
          env: authenticatedEnvDev,
          queue: "task/my-task",
        });

        expect(result.returned).toBe(1);
        expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(0);
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(0);
        expect(await queue.oldestMessageInQueue(authenticatedEnvDev, "task/my-task")).toBe(
          baseTimestamp
        );
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("returns runs on concurrency key queues", async ({ redisContainer }) => {
    const queue = createRunQueue(redisContainer);

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageFor({ runId: "r1", concurrencyKey: "ck-a" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageFor({ runId: "r2", concurrencyKey: "ck-b" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);
      expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(2);

      const result = await queue.returnUnclaimedMessagesToQueue({
        env: authenticatedEnvDev,
        queue: "task/my-task",
      });

      expect(result.returned).toBe(2);
      expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(0);

      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task", "ck-a")).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task", "ck-b")).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(2);

      expect(
        await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task", "ck-a")
      ).toBe(0);
      expect(
        await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task", "ck-b")
      ).toBe(0);
      expect(await queue.operationalCurrentConcurrencyOfEnvironment(authenticatedEnvDev)).toBe(0);

      await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);
      expect(await queue.peekAllOnWorkerQueue(authenticatedEnvDev.id)).toHaveLength(2);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "leaves runs that have not reached the worker queue alone",
    async ({ redisContainer }) => {
      const queue = createRunQueue(redisContainer);

      try {
        const empty = await queue.returnUnclaimedMessagesToQueue({ env: authenticatedEnvDev });
        expect(empty).toEqual({ returned: 0, skipped: 0 });

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageFor({ runId: "r1" }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const pendingOnly = await queue.returnUnclaimedMessagesToQueue({
          env: authenticatedEnvDev,
        });
        expect(pendingOnly).toEqual({ returned: 0, skipped: 0 });
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
        expect(await queue.oldestMessageInQueue(authenticatedEnvDev, "task/my-task")).toBe(
          baseTimestamp
        );
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("is idempotent when run twice", async ({ redisContainer }) => {
    const queue = createRunQueue(redisContainer);

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageFor({ runId: "r1" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      await queue.processMasterQueueForEnvironment(authenticatedEnvDev.id, 10);

      const first = await queue.returnUnclaimedMessagesToQueue({ env: authenticatedEnvDev });
      expect(first.returned).toBe(1);

      const second = await queue.returnUnclaimedMessagesToQueue({ env: authenticatedEnvDev });
      expect(second).toEqual({ returned: 0, skipped: 0 });

      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
      expect(await queue.lengthOfEnvQueue(authenticatedEnvDev)).toBe(1);
    } finally {
      await queue.quit();
    }
  });
});
