import type { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { postgresAndRedisTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { setTimeout } from "node:timers/promises";
import { buildGroundingTestEngine } from "./helpers/dashboardAgentQueueGroundingTestHelpers";

// The counters come from a real RunQueue on a real Redis; only the module seams are stubbed.

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  engine: undefined as unknown as RunEngine,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

vi.mock("~/v3/runEngine.server", () => ({
  get engine() {
    return ctx.engine;
  },
}));

process.env.SESSION_SECRET = "test-session-secret-for-queue-grounding";

const { readQueueGrounding } = await import("~/services/dashboardAgentQueueGrounding.server");

vi.setConfig({ testTimeout: 60_000 });

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

/** Each case gets its own engine on the container's Redis, plus one authenticated environment. */
function groundingTest(
  name: string,
  fn: (ctx: { prisma: PrismaClient; engine: RunEngine; environment: Env }) => Promise<void>,
  engineVersion: "V1" | "V2" = "V2"
) {
  postgresAndRedisTest(name, async ({ prisma, redisOptions }) => {
    ctx.prisma = prisma;
    const engine = buildGroundingTestEngine(prisma, redisOptions);
    ctx.engine = engine;

    try {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION", engineVersion);
      await fn({ prisma, engine, environment });
    } finally {
      // A case may already have quit the run queue itself, so this teardown can fail harmlessly.
      await engine.quit().catch(() => {});
    }
  });
}

async function createTaskQueue(
  prisma: PrismaClient,
  environment: Env,
  name: string,
  concurrencyLimit?: number,
  paused?: boolean
) {
  await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${name.replace(/\W/g, "_")}`,
      name,
      orderableName: name,
      type: "VIRTUAL",
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
      concurrencyLimit,
      paused,
    },
  });
}

function message(environment: Env, overrides: Record<string, unknown>) {
  return {
    runId: "r1",
    taskIdentifier: "my-task",
    orgId: environment.organization.id,
    projectId: environment.project.id,
    environmentId: environment.id,
    environmentType: environment.type,
    queue: "task/my-task",
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  } as any;
}

/** Wait for the async enqueue processing to admit `expected` messages into the worker queue. */
async function waitForAdmitted(
  engine: RunEngine,
  environment: Env,
  queue: string,
  expected: number,
  concurrencyKey?: string
) {
  for (let i = 0; i < 40; i++) {
    const admitted = await engine.runQueue.currentConcurrencyOfQueue(
      environment,
      queue,
      concurrencyKey
    );
    if (admitted >= expected) return admitted;
    await setTimeout(250);
  }
  return engine.runQueue.currentConcurrencyOfQueue(environment, queue, concurrencyKey);
}

/** Wait for the concurrency-key index to settle on `expected` backlogged keys. */
async function waitForBackloggedKeys(
  engine: RunEngine,
  environment: Env,
  queue: string,
  expected: number
) {
  for (let i = 0; i < 40; i++) {
    const { totalBackloggedKeys } = await engine.runQueue.concurrencyKeyBreakdown(
      environment,
      queue
    );
    if (totalBackloggedKeys === expected) return totalBackloggedKeys;
    await setTimeout(250);
  }
  return (await engine.runQueue.concurrencyKeyBreakdown(environment, queue)).totalBackloggedKeys;
}

describe("readQueueGrounding", () => {
  groundingTest(
    "separates admitted from displayed and reads the limit the gate enforces",
    async ({ prisma, engine, environment }) => {
      // The Postgres column deliberately disagrees with the Redis limit the gate enforces.
      await createTaskQueue(prisma, environment, "task/my-task", 99);
      await engine.runQueue.updateEnvConcurrencyLimits(environment);
      await engine.runQueue.updateQueueConcurrencyLimits(environment, "task/my-task", 2);

      for (const runId of ["r1", "r2", "r3"]) {
        await engine.runQueue.enqueueMessage({
          env: environment,
          message: message(environment, { runId }),
          workerQueue: environment.id,
        });
      }

      expect(await waitForAdmitted(engine, environment, "task/my-task", 2)).toBe(2);

      // Only one of the two admitted runs is taken off the worker queue, so the display
      // counter trails the gate counter.
      const started = await engine.runQueue.dequeueMessageFromWorkerQueue(
        "test_consumer",
        environment.id
      );
      expect(started).toBeDefined();

      const startedReadingAt = Date.now();
      const grounding = await readQueueGrounding({
        environment,
        queueName: "my-task",
        queueType: "task",
      });

      if ("status" in grounding) throw new Error(`unresolved: ${grounding.reason}`);

      expect(grounding.queue.admitted).toBe(2);
      expect(grounding.queue.displayed).toBe(1);
      expect(grounding.queue.limit).toBe(2);
      expect(grounding.queue.enforcedLimit).toBe(2);
      expect(grounding.queue.queued).toBe(1);
      expect(grounding.env.admitted).toBe(2);
      expect(grounding.env.displayed).toBe(1);
      // maximumConcurrencyLimit 10, un-bursted, is what caps the queue gate.
      expect(grounding.env.limit).toBe(10);
      // maximumConcurrencyLimit 10 × burstFactor 2.
      expect(grounding.env.effectiveLimit).toBe(20);
      expect(grounding.queue.keyed).toBe(false);
      expect(grounding.queue.paused).toBe(false);
      expect(Date.parse(grounding.asOf)).toBeGreaterThan(startedReadingAt);
      expect(grounding.oldestAvailableAtMs).toBeTypeOf("number");
      expect(grounding.holders).toEqual({ availability: "unavailable" });

      expect(Object.keys(grounding).sort()).toEqual([
        "asOf",
        "concurrencyKeys",
        "env",
        "holders",
        "oldestAvailableAtMs",
        "queue",
      ]);
      expect(Object.keys(grounding.queue).sort()).toEqual([
        "admitted",
        "displayed",
        "enforcedLimit",
        "keyed",
        "limit",
        "paused",
        "queued",
      ]);
      expect(Object.keys(grounding.env).sort()).toEqual([
        "admitted",
        "displayed",
        "effectiveLimit",
        "limit",
      ]);
      expect(Object.keys(grounding.concurrencyKeys).sort()).toEqual(["rows", "total", "truncated"]);
    }
  );

  groundingTest(
    "breaks a concurrency-keyed queue down per key and ages it from those keys",
    async ({ prisma, engine, environment }) => {
      await createTaskQueue(prisma, environment, "task/keyed");
      await engine.runQueue.updateEnvConcurrencyLimits(environment);
      await engine.runQueue.updateQueueConcurrencyLimits(environment, "task/keyed", 1);

      for (const concurrencyKey of ["a", "b", "c"]) {
        for (const attempt of [1, 2]) {
          await engine.runQueue.enqueueMessage({
            env: environment,
            message: message(environment, {
              runId: `r-${concurrencyKey}-${attempt}`,
              queue: "task/keyed",
              concurrencyKey,
            }),
            workerQueue: environment.id,
          });
        }
      }

      for (const concurrencyKey of ["a", "b", "c"]) {
        expect(await waitForAdmitted(engine, environment, "task/keyed", 1, concurrencyKey)).toBe(1);
      }

      const grounding = await readQueueGrounding({
        environment,
        queueName: "keyed",
        queueType: "task",
      });

      if ("status" in grounding) throw new Error(`unresolved: ${grounding.reason}`);

      // The base set is what the queue gate SCARDs, so it is still reported; `keyed` says the
      // per-key gates count too.
      expect(grounding.queue.admitted).toBe(
        await engine.runQueue.currentConcurrencyOfQueue(environment, "task/keyed")
      );
      expect(grounding.queue.keyed).toBe(true);
      expect(grounding.queue.enforcedLimit).toBe(1);
      expect(grounding.concurrencyKeys.total).toBe(3);
      expect(grounding.concurrencyKeys.truncated).toBe(false);
      expect(grounding.concurrencyKeys.rows).toHaveLength(3);
      expect(Object.keys(grounding.concurrencyKeys.rows[0]!).sort()).toEqual([
        "key",
        "oldestAvailableAt",
        "queued",
        "running",
      ]);
      for (const row of grounding.concurrencyKeys.rows) {
        expect(row.queued).toBe(1);
        expect(row.running).toBe(1);
        expect(row.oldestAvailableAt).toBeTypeOf("number");
      }

      // Nothing sits in the base zset, so the age has to come from the keys.
      expect(await engine.runQueue.oldestMessageInQueue(environment, "task/keyed")).toBeUndefined();
      expect(grounding.oldestAvailableAtMs).toBe(
        Math.min(...grounding.concurrencyKeys.rows.map((row) => row.oldestAvailableAt))
      );

      for (const _ of ["a", "b", "c"]) {
        expect(
          await engine.runQueue.dequeueMessageFromWorkerQueue("test_consumer", environment.id)
        ).toBeDefined();
      }
      for (const concurrencyKey of ["a", "b", "c"]) {
        await engine.runQueue.acknowledgeMessage(
          environment.organization.id,
          `r-${concurrencyKey}-2`
        );
      }
      expect(await waitForBackloggedKeys(engine, environment, "task/keyed", 0)).toBe(0);

      const drained = await readQueueGrounding({
        environment,
        queueName: "keyed",
        queueType: "task",
      });

      if ("status" in drained) throw new Error(`unresolved: ${drained.reason}`);

      expect(drained.concurrencyKeys.rows).toEqual([]);
      expect(drained.queue.displayed).toBe(3);
      expect(drained.queue.admitted).toBe(0);
      expect(drained.queue.keyed).toBe(true);
    }
  );

  groundingTest(
    "a paused queue says so, not just a zero limit",
    async ({ prisma, environment }) => {
      await createTaskQueue(prisma, environment, "task/stopped", 2, true);

      const grounding = await readQueueGrounding({
        environment,
        queueName: "stopped",
        queueType: "task",
      });

      if ("status" in grounding) throw new Error(`unresolved: ${grounding.reason}`);
      expect(grounding.queue.paused).toBe(true);
    }
  );

  groundingTest("an unknown queue is not zeros", async ({ prisma, environment }) => {
    expect(await readQueueGrounding({ environment, queueName: "nope", queueType: "task" })).toEqual(
      { status: "unresolved", reason: "queue_not_found" }
    );

    const otherEnvironment = await prisma.runtimeEnvironment.create({
      data: {
        type: "STAGING",
        slug: "other",
        projectId: environment.project.id,
        organizationId: environment.organization.id,
        apiKey: "other_api_key",
        pkApiKey: "other_pk_api_key",
        shortcode: "other_short_code",
      },
    });
    await createTaskQueue(prisma, { ...environment, id: otherEnvironment.id }, "task/elsewhere");

    expect(
      await readQueueGrounding({ environment, queueName: "elsewhere", queueType: "task" })
    ).toEqual({ status: "unresolved", reason: "queue_not_found" });
  });

  groundingTest(
    "a name holding a literal %2F is looked up verbatim",
    async ({ prisma, environment }) => {
      await createTaskQueue(prisma, environment, "task/we%2Fird", 3);

      const grounding = await readQueueGrounding({
        environment,
        queueName: "we%2Fird",
        queueType: "task",
      });

      if ("status" in grounding) throw new Error(`unresolved: ${grounding.reason}`);
      expect(grounding.queue.queued).toBe(0);
    }
  );

  groundingTest(
    "a V1 environment has no counters to report",
    async ({ prisma, environment }) => {
      await createTaskQueue(prisma, environment, "task/my-task", 2);

      expect(
        await readQueueGrounding({ environment, queueName: "my-task", queueType: "task" })
      ).toEqual({ status: "unresolved", reason: "scheduler_unavailable" });
    },
    "V1"
  );

  groundingTest(
    "an unreadable scheduler is unresolved, not a partial payload",
    async ({ prisma, engine, environment }) => {
      await createTaskQueue(prisma, environment, "task/my-task", 2);

      await engine.runQueue.quit();

      expect(
        await readQueueGrounding({ environment, queueName: "my-task", queueType: "task" })
      ).toEqual({ status: "unresolved", reason: "scheduler_unavailable" });
    }
  );
});
