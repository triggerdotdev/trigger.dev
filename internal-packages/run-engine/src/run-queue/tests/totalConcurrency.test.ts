import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
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

function createQueue(redisContainer: any, totalConcurrencyEnabled: boolean) {
  return new RunQueue({
    ...testOptions,
    totalConcurrencyEnabled,
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
    queue: "task/my-task",
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await setTimeout(250);
  }
  return condition();
}

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue total concurrency limit", () => {
  redisTest(
    "caps in-flight runs across concurrency keys at the total limit",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, true);
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
        await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, "task/my-task", 2);

        const now = Date.now();
        for (const [i, ck] of ["ck-a", "ck-a", "ck-b", "ck-b"].entries()) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r${i}`,
              concurrencyKey: ck,
              timestamp: now - 1000 + i,
            }),
            workerQueue: "main",
          });
        }

        const admittedTwo = await waitFor(
          async () =>
            (await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")) === 2
        );
        expect(admittedTwo).toBe(true);

        /**
         * The remaining two messages must stay queued: give the master consumers a
         * couple of extra polling cycles to prove the gate holds, not just that it
         * hadn't caught up yet.
         */
        await setTimeout(2000);
        expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(2);
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(2);

        const dequeued1 = await queue.dequeueMessageFromWorkerQueue("consumer-1", "main");
        assertNonNullable(dequeued1);
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("consumer-1", "main");
        assertNonNullable(dequeued2);

        await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, dequeued1.messageId);

        const thirdAdmitted = await waitFor(async () => {
          const total = await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task");
          const queued = await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task");
          return total === 2 && queued === 1;
        });
        expect(thirdAdmitted).toBe(true);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "still enforces the per-key limit under the total limit",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, true);
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 1);
        await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, "task/my-task", 10);

        const now = Date.now();
        for (const i of [0, 1]) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r${i}`,
              concurrencyKey: "ck-a",
              timestamp: now - 1000 + i,
            }),
            workerQueue: "main",
          });
        }

        const oneAdmitted = await waitFor(
          async () =>
            (await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")) === 1
        );
        expect(oneAdmitted).toBe(true);

        await setTimeout(2000);
        expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
        expect(
          await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task", "ck-a")
        ).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "ignores the stored total limit and maintains no group set when disabled",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, false);
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
        await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, "task/my-task", 1);

        const now = Date.now();
        for (const [i, ck] of ["ck-a", "ck-b", "ck-c"].entries()) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r${i}`,
              concurrencyKey: ck,
              timestamp: now - 1000 + i,
            }),
            workerQueue: "main",
          });
        }

        const allAdmitted = await waitFor(
          async () => (await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")) === 0
        );
        expect(allAdmitted).toBe(true);
        expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("enqueue fast path respects the total limit", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
      await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, "task/my-task", 1);

      const now = Date.now();
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r0", concurrencyKey: "ck-a", timestamp: now - 1000 }),
        workerQueue: "main",
        enableFastPath: true,
        skipDequeueProcessing: true,
      });

      /** The fast path admits synchronously, so the group slot is taken immediately. */
      expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(0);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r1", concurrencyKey: "ck-b", timestamp: now - 999 }),
        workerQueue: "main",
        enableFastPath: true,
        skipDequeueProcessing: true,
      });

      /** At the total limit the fast path must fall through to a normal enqueue. */
      expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("nacking releases the total slot", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
      await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, "task/my-task", 1);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r0", concurrencyKey: "ck-a", timestamp: Date.now() - 1000 }),
        workerQueue: "main",
      });

      const admitted = await waitFor(
        async () => (await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")) === 1
      );
      expect(admitted).toBe(true);

      /** A second run on another key waits behind the total limit of 1. */
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r1", concurrencyKey: "ck-b", timestamp: Date.now() - 500 }),
        workerQueue: "main",
      });

      await setTimeout(2000);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);

      const dequeued = await queue.dequeueMessageFromWorkerQueue("consumer-1", "main");
      assertNonNullable(dequeued);
      expect(dequeued.messageId).toBe("r0");

      /**
       * Nack r0 with a far-future retryAt so it cannot immediately reclaim the
       * slot. If the nack released r0's group slot, r1 is the only eligible run
       * and must be admitted; if the slot leaked, the queue stays blocked and r1
       * never surfaces.
       */
      await queue.nackMessage({
        orgId: authenticatedEnvDev.organization.id,
        messageId: "r0",
        retryAt: Date.now() + 120_000,
      });

      const r1Admitted = await waitFor(async () => {
        const next = await queue.dequeueMessageFromWorkerQueue("consumer-1", "main");
        return next?.messageId === "r1";
      });
      expect(r1Admitted).toBe(true);
      expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "reconciles a leaked group member instead of blocking the queue",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, true);
      try {
        const keys = testOptions.keys;
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
        await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, "task/my-task", 1);

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: "r0",
            concurrencyKey: "ck-a",
            timestamp: Date.now() - 1000,
          }),
          workerQueue: "main",
        });

        const admitted = await waitFor(
          async () =>
            (await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")) === 1
        );
        expect(admitted).toBe(true);

        const dequeued = await queue.dequeueMessageFromWorkerQueue("consumer-1", "main");
        assertNonNullable(dequeued);
        expect(dequeued.messageId).toBe("r0");

        /**
         * Simulate a terminal release from a build without the group mirror: the
         * message key is deleted and the per-key and env sets are cleared, but the
         * group member is left behind.
         */
        await queue.redis.del(keys.messageKey(authenticatedEnvDev.organization.id, "r0"));
        await queue.redis.srem(
          keys.queueCurrentConcurrencyKey(authenticatedEnvDev, "task/my-task", "ck-a"),
          "r0"
        );
        await queue.redis.srem(keys.envCurrentConcurrencyKey(authenticatedEnvDev), "r0");
        expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);

        /** The next run must still be admitted: the gate prunes the dead member. */
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: "r1",
            concurrencyKey: "ck-b",
            timestamp: Date.now() - 500,
          }),
          workerQueue: "main",
        });

        const r1Admitted = await waitFor(async () => {
          const next = await queue.dequeueMessageFromWorkerQueue("consumer-1", "main");
          return next?.messageId === "r1";
        });
        expect(r1Admitted).toBe(true);
        expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );
});
