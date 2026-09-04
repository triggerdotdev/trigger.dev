import { redisTest } from "@internal/testcontainers";
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

function createQueue(redisContainer: any, gatesEnabled: boolean) {
  return new RunQueue({
    ...testOptions,
    gatesEnabled,
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

async function popWorkerQueue(queue: RunQueue, expected: string): Promise<boolean> {
  const next = await queue.dequeueMessageFromWorkerQueue("consumer-1", "main", {
    blockingPop: false,
  });
  return next?.messageId === expected;
}

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue gates", () => {
  redisTest("an unkeyed gate caps runs across its holders", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "shared-gate", 1);

      const now = Date.now();
      for (const i of [0, 1]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: `r${i}`,
            timestamp: now - 1000 + i,
            gates: [{ queue: "shared-gate" }],
          }),
          workerQueue: "main",
        });
      }

      const oneAdmitted = await waitFor(
        async () =>
          (await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")) === 1
      );
      expect(oneAdmitted).toBe(true);

      /** The second run must stay queued while the gate is full. */
      await setTimeout(2000);
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);

      expect(await popWorkerQueue(queue, "r0")).toBe(true);
      await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, "r0");

      /** Acking r0 frees the gate slot and its home slot; r1 is admitted. */
      const r1Admitted = await waitFor(() => popWorkerQueue(queue, "r1"));
      expect(r1Admitted).toBe(true);
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "a keyed gate caps a tenant across home concurrency keys",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, true);
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "tenant", 1);

        const now = Date.now();
        for (const [i, ck] of ["ck-a", "ck-b"].entries()) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r${i}`,
              concurrencyKey: ck,
              timestamp: now - 1000 + i,
              gates: [{ queue: "tenant", concurrencyKey: "acme" }],
            }),
            workerQueue: "main",
          });
        }

        const oneAdmitted = await waitFor(
          async () =>
            (await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "tenant", "acme")) === 1
        );
        expect(oneAdmitted).toBe(true);

        await setTimeout(2000);
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "tenant", "acme")).toBe(
          1
        );
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
        expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "tenant")).toBe(1);

        expect(await popWorkerQueue(queue, "r0")).toBe(true);
        await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, "r0");

        const r1Admitted = await waitFor(() => popWorkerQueue(queue, "r1"));
        expect(r1Admitted).toBe(true);
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "tenant", "acme")).toBe(
          1
        );
        expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, "tenant")).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("ignores gates and holds no gate slots when disabled", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, false);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "shared-gate", 1);

      const now = Date.now();
      for (const i of [0, 1]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: `r${i}`,
            timestamp: now - 1000 + i,
            gates: [{ queue: "shared-gate" }],
          }),
          workerQueue: "main",
        });
      }

      const bothAdmitted = await waitFor(
        async () => (await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")) === 0
      );
      expect(bothAdmitted).toBe(true);
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("nacking releases the gate slot", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "shared-gate", 1);

      const now = Date.now();
      for (const i of [0, 1]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: `r${i}`,
            timestamp: now - 1000 + i,
            gates: [{ queue: "shared-gate" }],
          }),
          workerQueue: "main",
        });
      }

      const r0Admitted = await waitFor(async () => {
        if ((await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")) !== 1) {
          return false;
        }
        return popWorkerQueue(queue, "r0");
      });
      expect(r0Admitted).toBe(true);

      await queue.nackMessage({
        orgId: authenticatedEnvDev.organization.id,
        messageId: "r0",
        retryAt: Date.now() + 120_000,
      });

      /** r0's gate slot must be released so r1 (the only eligible run) is admitted. */
      const r1Admitted = await waitFor(() => popWorkerQueue(queue, "r1"));
      expect(r1Admitted).toBe(true);
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("reconciles a leaked gate member instead of blocking", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true);
    try {
      const keys = testOptions.keys;
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "shared-gate", 1);

      /** A dead member with no message key occupies the gate. */
      await queue.redis.sadd(
        keys.queueCurrentConcurrencyKey(authenticatedEnvDev, "shared-gate"),
        "dead-0"
      );

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({
          runId: "r0",
          timestamp: Date.now() - 1000,
          gates: [{ queue: "shared-gate" }],
        }),
        workerQueue: "main",
      });

      const r0Admitted = await waitFor(() => popWorkerQueue(queue, "r0"), 30_000);
      expect(r0Admitted).toBe(true);
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "a run already holding its own gate slot is never deadlocked by it",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, true);
      try {
        const keys = testOptions.keys;
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "shared-gate", 1);

        /**
         * An unmirrored release (an older build's nack) leaves the run's own
         * membership behind while the run goes back to waiting in its queue. The
         * gate is "full" with the run itself; admission must still let it through.
         */
        await queue.redis.sadd(
          keys.queueCurrentConcurrencyKey(authenticatedEnvDev, "shared-gate"),
          "r0"
        );

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: "r0",
            timestamp: Date.now() - 1000,
            gates: [{ queue: "shared-gate" }],
          }),
          workerQueue: "main",
        });

        const r0Admitted = await waitFor(() => popWorkerQueue(queue, "r0"), 30_000);
        expect(r0Admitted).toBe(true);
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "a gate without a key inherits the run's concurrency key",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, true);
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "tenant", 1);

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: "r0",
            concurrencyKey: "acme",
            timestamp: Date.now() - 1000,
            gates: [{ queue: "tenant" }],
          }),
          workerQueue: "main",
        });

        const admitted = await waitFor(
          async () =>
            (await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "tenant", "acme")) === 1
        );
        expect(admitted).toBe(true);
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "tenant")).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("enqueue fast path respects a full gate", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, true);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "task/my-task", 5);
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "shared-gate", 1);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({
          runId: "r0",
          timestamp: Date.now() - 1000,
          gates: [{ queue: "shared-gate" }],
        }),
        workerQueue: "main",
        enableFastPath: true,
        skipDequeueProcessing: true,
      });

      /** The fast path admits synchronously and takes the gate slot. */
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(0);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({
          runId: "r1",
          timestamp: Date.now() - 999,
          gates: [{ queue: "shared-gate" }],
        }),
        workerQueue: "main",
        enableFastPath: true,
        skipDequeueProcessing: true,
      });

      /** At the gate's limit the fast path must fall back to a normal enqueue. */
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvDev, "shared-gate")).toBe(1);
      expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(1);
    } finally {
      await queue.quit();
    }
  });
});
