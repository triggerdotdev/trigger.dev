import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { describe } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue, RunQueueConcurrencyKeyLimitExceededError } from "../index.js";
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

function createQueue(
  redisContainer: any,
  totalConcurrencyEnabled: boolean,
  maxOverrides?: number,
  dequeueCount?: number
) {
  return new RunQueue({
    ...testOptions,
    totalConcurrencyEnabled,
    maxConcurrencyKeyOverridesPerQueue: maxOverrides,
    masterQueueConsumerDequeueCount: dequeueCount,
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

describe("RunQueue per-concurrency-key limit overrides", () => {
  redisTest(
    "a lowered key is capped while other keys keep the queue limit",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, true);
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 2);
        await queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-a", 1);

        const now = Date.now();
        const messages = [
          ["ck-a", "a0"],
          ["ck-a", "a1"],
          ["ck-b", "b0"],
          ["ck-b", "b1"],
        ] as const;
        for (const [i, [ck, id]] of messages.entries()) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: id, concurrencyKey: ck, timestamp: now - 1000 + i }),
            workerQueue: "main",
          });
        }

        const settled = await waitFor(async () => {
          const a = await queue.currentConcurrencyOfQueue(
            authenticatedEnvDev,
            "task/my-task",
            "ck-a"
          );
          const b = await queue.currentConcurrencyOfQueue(
            authenticatedEnvDev,
            "task/my-task",
            "ck-b"
          );
          return a === 1 && b === 2;
        });
        expect(settled).toBe(true);

        await setTimeout(2000);
        expect(
          await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task", "ck-a")
        ).toBe(1);
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("a raised key admits past the queue limit", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 1);
      await queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-a", 3);

      const now = Date.now();
      for (const i of [0, 1, 2]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: `a${i}`,
            concurrencyKey: "ck-a",
            timestamp: now - 1000 + i,
          }),
          workerQueue: "main",
        });
      }
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "b0", concurrencyKey: "ck-b", timestamp: now - 500 }),
        workerQueue: "main",
      });
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "b1", concurrencyKey: "ck-b", timestamp: now - 499 }),
        workerQueue: "main",
      });

      const settled = await waitFor(async () => {
        const a = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          "task/my-task",
          "ck-a"
        );
        const b = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          "task/my-task",
          "ck-b"
        );
        return a === 3 && b === 1;
      });
      expect(settled).toBe(true);

      await setTimeout(2000);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("removing an override restores the queue limit", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 2);
      await queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-a", 1);
      expect(await queue.getQueueConcurrencyKeyLimits(authenticatedEnvDev, "task/my-task")).toEqual(
        { "ck-a": 1 }
      );

      await queue.removeQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-a");
      expect(await queue.getQueueConcurrencyKeyLimits(authenticatedEnvDev, "task/my-task")).toEqual(
        {}
      );

      const now = Date.now();
      for (const i of [0, 1]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: `a${i}`,
            concurrencyKey: "ck-a",
            timestamp: now - 1000 + i,
          }),
          workerQueue: "main",
        });
      }

      const settled = await waitFor(
        async () =>
          (await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task", "ck-a")) === 2
      );
      expect(settled).toBe(true);
    } finally {
      await queue.quit();
    }
  });

  redisTest("the per-queue override count is capped", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true, 2);
    try {
      await queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-a", 1);
      await queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-b", 1);

      await expect(
        queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-c", 1)
      ).rejects.toThrow(RunQueueConcurrencyKeyLimitExceededError);

      /** Updates to existing keys always succeed at the cap. */
      await queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-a", 4);
      expect(await queue.getQueueConcurrencyKeyLimits(authenticatedEnvDev, "task/my-task")).toEqual(
        { "ck-a": 4, "ck-b": 1 }
      );
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "blocked keys cannot pin the candidate window and starve later keys",
    async ({ redisContainer }) => {
      /** dequeueCount 2 makes the candidate window 6 variants wide. */
      const queue = createQueue(redisContainer, true, undefined, 2);
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);

        /**
         * Ten zero-limit keys with OLDER messages fill the window many times over;
         * without the blocked-key backoff the runnable key behind them would never
         * be examined.
         */
        const now = Date.now();
        for (let i = 0; i < 10; i++) {
          const ck = `blocked-${i}`;
          await queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", ck, 0);
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `b${i}`,
              concurrencyKey: ck,
              timestamp: now - 10_000 + i,
            }),
            workerQueue: "main",
          });
        }

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: "good-0",
            concurrencyKey: "ck-good",
            timestamp: now - 500,
          }),
          workerQueue: "main",
        });

        const goodAdmitted = await waitFor(
          async () =>
            (await queue.currentConcurrencyOfQueue(
              authenticatedEnvDev,
              "task/my-task",
              "ck-good"
            )) === 1,
          30_000
        );
        expect(goodAdmitted).toBe(true);
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(10);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("overrides are ignored when disabled", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, false);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 2);
      await queue.updateQueueConcurrencyKeyLimit(authenticatedEnvDev, "task/my-task", "ck-a", 1);

      const now = Date.now();
      for (const i of [0, 1]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: `a${i}`,
            concurrencyKey: "ck-a",
            timestamp: now - 1000 + i,
          }),
          workerQueue: "main",
        });
      }

      const settled = await waitFor(
        async () =>
          (await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "task/my-task", "ck-a")) === 2
      );
      expect(settled).toBe(true);
    } finally {
      await queue.quit();
    }
  });
});
