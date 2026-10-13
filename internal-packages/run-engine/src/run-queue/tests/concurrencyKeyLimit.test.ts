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

const env = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

function createQueue(
  redisContainer: any,
  opts: { enabled?: boolean; vtime?: boolean; gates?: boolean } = {}
) {
  const redis = {
    keyPrefix: "runqueue:test:",
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    ...testOptions,
    concurrencyKeyLimitsEnabled: opts.enabled ?? true,
    gatesEnabled: opts.gates ?? false,
    ...(opts.vtime ? { ckVirtualTimeScheduling: { enabled: true } } : {}),
    queueSelectionStrategy: new FairQueueSelectionStrategy({ redis, keys: testOptions.keys }),
    redis,
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
    if (await condition()) return true;
    await setTimeout(250);
  }
  return condition();
}

async function enqueueKeyed(
  queue: RunQueue,
  runs: Array<{ runId: string; key: string; gates?: InputPayload["gates"] }>,
  targetEnv = env,
  opts: { fastPath?: boolean } = {}
) {
  const now = Date.now();
  for (const [i, r] of runs.entries()) {
    await queue.enqueueMessage({
      env: targetEnv,
      enableFastPath: opts.fastPath ?? false,
      message: makeMessage({
        runId: r.runId,
        concurrencyKey: r.key,
        gates: r.gates,
        timestamp: now - 1000 + i,
      }),
      workerQueue: "main",
    });
  }
}

async function runningForKey(queue: RunQueue, key: string, targetEnv = env) {
  return queue.currentConcurrencyOfQueue(targetEnv, "task/my-task", key);
}

/** The master consumers poll on an interval: wait a few cycles to prove a cap holds. */
async function settle(ms = 1500) {
  await setTimeout(ms);
}

vi.setConfig({ testTimeout: 60_000 });

for (const vtime of [false, true]) {
  describe(`RunQueue per-key override (vtime=${vtime})`, () => {
    redisTest("a raised override admits more runs of that key", async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { vtime });
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 1);
        await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 2, 60);
        await enqueueKeyed(queue, [
          { runId: "a1", key: "a" },
          { runId: "a2", key: "a" },
          { runId: "b1", key: "b" },
          { runId: "b2", key: "b" },
        ]);
        expect(await waitFor(async () => (await runningForKey(queue, "a")) === 2)).toBe(true);
        await settle();
        expect(await runningForKey(queue, "a")).toBe(2);
        expect(await runningForKey(queue, "b")).toBe(1);
      } finally {
        await queue.quit();
      }
    });

    redisTest("a lowered override admits fewer runs of that key", async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { vtime });
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 5);
        await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 1, 60);
        await enqueueKeyed(queue, [
          { runId: "a1", key: "a" },
          { runId: "a2", key: "a" },
          { runId: "a3", key: "a" },
        ]);
        expect(await waitFor(async () => (await runningForKey(queue, "a")) === 1)).toBe(true);
        await settle();
        expect(await runningForKey(queue, "a")).toBe(1);
        expect(await queue.lengthOfQueue(env, "task/my-task")).toBe(2);
      } finally {
        await queue.quit();
      }
    });

    redisTest("the override is clamped to the environment limit", async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { vtime });
      try {
        const smallEnv = { ...env, maximumConcurrencyLimit: 2 };
        await queue.updateEnvConcurrencyLimits(smallEnv);
        await queue.updateQueueConcurrencyLimits(smallEnv, "task/my-task", 1);
        await queue.updateQueueConcurrencyKeyLimit(smallEnv, "task/my-task", "a", 50, 60);
        await enqueueKeyed(
          queue,
          [
            { runId: "a1", key: "a" },
            { runId: "a2", key: "a" },
            { runId: "a3", key: "a" },
          ],
          smallEnv
        );
        expect(await waitFor(async () => (await runningForKey(queue, "a", smallEnv)) === 2)).toBe(
          true
        );
        await settle();
        expect(await runningForKey(queue, "a", smallEnv)).toBe(2);
      } finally {
        await queue.quit();
      }
    });
  });
}

describe("RunQueue per-key override semantics", () => {
  redisTest(
    "a paused queue stays paused whatever the override says",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 0);
        await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 3, 60);
        await enqueueKeyed(queue, [
          { runId: "a1", key: "a" },
          { runId: "a2", key: "a" },
        ]);
        await settle(2500);
        expect(await runningForKey(queue, "a")).toBe(0);
        expect(await queue.lengthOfQueue(env, "task/my-task")).toBe(2);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("the enqueue fast path honours a lowered override", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      await queue.updateQueueConcurrencyLimits(env, "task/my-task", 5);
      await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 1, 60);
      await enqueueKeyed(
        queue,
        [
          { runId: "a1", key: "a" },
          { runId: "a2", key: "a" },
          { runId: "a3", key: "a" },
        ],
        env,
        { fastPath: true }
      );
      expect(await waitFor(async () => (await runningForKey(queue, "a")) === 1)).toBe(true);
      await settle();
      expect(await runningForKey(queue, "a")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("the enqueue fast path honours an override of 0", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      await queue.updateQueueConcurrencyLimits(env, "task/my-task", 5);
      await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 0, 60);
      await enqueueKeyed(queue, [{ runId: "a1", key: "a" }], env, { fastPath: true });
      await settle(2500);
      expect(await runningForKey(queue, "a")).toBe(0);
      expect(await queue.lengthOfQueue(env, "task/my-task")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "an override stops applying once the queue's perKey is removed",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 5);
        await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 1, 60);
        await queue.removeQueueConcurrencyLimits(env, "task/my-task");
        await enqueueKeyed(queue, [
          { runId: "a1", key: "a" },
          { runId: "a2", key: "a" },
        ]);
        expect(await waitFor(async () => (await runningForKey(queue, "a")) === 2)).toBe(true);
        const stats = await queue.concurrencyKeyLiveStats(env, "task/my-task", ["a"]);
        expect(stats.get("a")?.limit).toBeNull();
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "a key whose value ends in :ckLimit keeps its own queue when another key is overridden",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 1);
        await enqueueKeyed(queue, [{ runId: "x1", key: "a:ckLimit" }]);
        await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 2, 60);
        expect(await waitFor(async () => (await runningForKey(queue, "a:ckLimit")) === 1)).toBe(
          true
        );
        const stats = await queue.concurrencyKeyLiveStats(env, "task/my-task", ["a", "a:ckLimit"]);
        expect(stats.get("a")?.limit).toBe(2);
        expect(stats.get("a:ckLimit")?.limit).toBeNull();
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("an override of 0 blocks the key", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      await queue.updateQueueConcurrencyLimits(env, "task/my-task", 5);
      await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 0, 60);
      await enqueueKeyed(queue, [
        { runId: "a1", key: "a" },
        { runId: "b1", key: "b" },
      ]);
      expect(await waitFor(async () => (await runningForKey(queue, "b")) === 1)).toBe(true);
      await settle();
      expect(await runningForKey(queue, "a")).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("the flag off ignores the override entirely", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { enabled: false });
    try {
      await queue.updateQueueConcurrencyLimits(env, "task/my-task", 1);
      await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 3, 60);
      await enqueueKeyed(queue, [
        { runId: "a1", key: "a" },
        { runId: "a2", key: "a" },
      ]);
      expect(await waitFor(async () => (await runningForKey(queue, "a")) === 1)).toBe(true);
      await settle();
      expect(await runningForKey(queue, "a")).toBe(1);
      const stats = await queue.concurrencyKeyLiveStats(env, "task/my-task", ["a"]);
      expect(stats.get("a")?.limit).toBeNull();
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "the override carries its TTL and can be read back and removed",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 1);
        await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 4, 120);
        const read = await queue.getQueueConcurrencyKeyLimit(env, "task/my-task", "a");
        expect(read?.concurrency).toBe(4);
        expect(read?.expiresAt).toBeInstanceOf(Date);
        expect(read!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(100_000);
        expect(read!.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(120_000);

        const stats = await queue.concurrencyKeyLiveStats(env, "task/my-task", ["a", "b"]);
        expect(stats.get("a")?.limit).toBe(4);
        expect(stats.get("a")?.limitExpiresAt).toBeInstanceOf(Date);
        expect(stats.get("b")?.limit).toBeNull();

        await queue.removeQueueConcurrencyKeyLimit(env, "task/my-task", "a");
        expect(await queue.getQueueConcurrencyKeyLimit(env, "task/my-task", "a")).toBeUndefined();
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("an expired override falls back to the queue's perKey", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      await queue.updateQueueConcurrencyLimits(env, "task/my-task", 1);
      await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 3, 1);
      await setTimeout(1500);
      expect(await queue.getQueueConcurrencyKeyLimit(env, "task/my-task", "a")).toBeUndefined();
      await enqueueKeyed(queue, [
        { runId: "a1", key: "a" },
        { runId: "a2", key: "a" },
      ]);
      expect(await waitFor(async () => (await runningForKey(queue, "a")) === 1)).toBe(true);
      await settle();
      expect(await runningForKey(queue, "a")).toBe(1);
    } finally {
      await queue.quit();
    }
  });
});

describe("RunQueue per-key override on gates", () => {
  redisTest(
    "an override on a gate caps the run's key under that gate",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { gates: true });
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 10);
        await queue.updateQueueConcurrencyLimits(env, "limit/tenant", 1);
        await queue.updateQueueConcurrencyKeyLimit(env, "limit/tenant", "a", 2, 60);
        await enqueueKeyed(queue, [
          { runId: "a1", key: "a", gates: [{ queue: "limit/tenant" }] },
          { runId: "a2", key: "a", gates: [{ queue: "limit/tenant" }] },
          { runId: "a3", key: "a", gates: [{ queue: "limit/tenant" }] },
        ]);
        expect(await waitFor(async () => (await runningForKey(queue, "a")) === 2)).toBe(true);
        await settle();
        expect(await runningForKey(queue, "a")).toBe(2);
        expect(await queue.currentConcurrencyOfQueue(env, "limit/tenant", "a")).toBe(2);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("an override on the home queue does not touch a gate", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { gates: true });
    try {
      await queue.updateQueueConcurrencyLimits(env, "task/my-task", 1);
      await queue.updateQueueConcurrencyLimits(env, "limit/tenant", 1);
      await queue.updateQueueConcurrencyKeyLimit(env, "task/my-task", "a", 5, 60);
      await enqueueKeyed(queue, [
        { runId: "a1", key: "a", gates: [{ queue: "limit/tenant" }] },
        { runId: "a2", key: "a", gates: [{ queue: "limit/tenant" }] },
      ]);
      expect(await waitFor(async () => (await runningForKey(queue, "a")) === 1)).toBe(true);
      await settle();
      expect(await runningForKey(queue, "a")).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("a paused gate stays paused whatever the override says", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { gates: true });
    try {
      await queue.updateQueueConcurrencyLimits(env, "task/my-task", 10);
      await queue.updateQueueConcurrencyLimits(env, "limit/tenant", 0);
      await queue.updateQueueConcurrencyKeyLimit(env, "limit/tenant", "a", 3, 60);
      await enqueueKeyed(queue, [{ runId: "a1", key: "a", gates: [{ queue: "limit/tenant" }] }]);
      await settle(2500);
      expect(await runningForKey(queue, "a")).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "the fast path of an un-keyed run honours a lowered override on a literal-key gate",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { gates: true });
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 10);
        await queue.updateQueueConcurrencyLimits(env, "limit/provider", 5);
        await queue.updateQueueConcurrencyKeyLimit(env, "limit/provider", "shared", 1, 60);
        const gates = [{ queue: "limit/provider", concurrencyKey: "shared" }];
        const now = Date.now();
        for (const i of [0, 1, 2]) {
          await queue.enqueueMessage({
            env,
            enableFastPath: true,
            message: makeMessage({ runId: `u${i}`, gates, timestamp: now - 1000 + i }),
            workerQueue: "main",
          });
        }
        expect(
          await waitFor(
            async () =>
              (await queue.currentConcurrencyOfQueue(env, "limit/provider", "shared")) === 1
          )
        ).toBe(true);
        await settle();
        expect(await queue.currentConcurrencyOfQueue(env, "limit/provider", "shared")).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "an un-keyed run holding a literal-key gate reads that key's override too",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { gates: true });
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 10);
        await queue.updateQueueConcurrencyLimits(env, "limit/provider", 1);
        await queue.updateQueueConcurrencyKeyLimit(env, "limit/provider", "shared", 2, 60);
        const gates = [{ queue: "limit/provider", concurrencyKey: "shared" }];
        const now = Date.now();
        for (const i of [0, 1, 2]) {
          await queue.enqueueMessage({
            env,
            message: makeMessage({ runId: `u${i}`, gates, timestamp: now - 1000 + i }),
            workerQueue: "main",
          });
        }
        expect(
          await waitFor(
            async () =>
              (await queue.currentConcurrencyOfQueue(env, "limit/provider", "shared")) === 2
          )
        ).toBe(true);
        await settle();
        expect(await queue.currentConcurrencyOfQueue(env, "limit/provider", "shared")).toBe(2);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "a gate pinned to a literal key reads an override on that literal key",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { gates: true });
      try {
        await queue.updateQueueConcurrencyLimits(env, "task/my-task", 10);
        await queue.updateQueueConcurrencyLimits(env, "limit/provider", 1);
        await queue.updateQueueConcurrencyKeyLimit(env, "limit/provider", "shared", 2, 60);
        const gates = [{ queue: "limit/provider", concurrencyKey: "shared" }];
        await enqueueKeyed(queue, [
          { runId: "a1", key: "a", gates },
          { runId: "b1", key: "b", gates },
          { runId: "c1", key: "c", gates },
        ]);
        expect(
          await waitFor(
            async () =>
              (await queue.currentConcurrencyOfQueue(env, "limit/provider", "shared")) === 2
          )
        ).toBe(true);
        await settle();
        expect(await queue.currentConcurrencyOfQueue(env, "limit/provider", "shared")).toBe(2);
      } finally {
        await queue.quit();
      }
    }
  );
});
