import { describe, expect, onTestFinished, vi } from "vitest";

// Module singletons are replaced so the service runs against a real testcontainers
// Prisma client and RunEngine.
const engineRef = vi.hoisted(() => ({ engine: undefined as unknown }));
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return { Prisma, prisma: {}, $replica: {} };
});
vi.mock("~/v3/runEngine.server", () => ({
  get engine() {
    return engineRef.engine;
  },
}));

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { Redis } from "ioredis";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ConcurrencySystem } from "~/v3/services/concurrencySystem.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function buildEngine(prisma: PrismaClient, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function setup(prisma: PrismaClient, redisOptions: unknown) {
  const engine = buildEngine(prisma, redisOptions);
  engineRef.engine = engine;
  onTestFinished(() => engine.quit());
  const environment = (await setupAuthenticatedEnvironment(
    prisma,
    "PRODUCTION"
  )) as unknown as AuthenticatedEnvironment;
  const system = new ConcurrencySystem({ db: prisma, reader: prisma });
  return { engine, environment, system };
}

async function createQueue(
  prisma: PrismaClient,
  environment: AuthenticatedEnvironment,
  name: string,
  data: { concurrencyLimit: number | null; paused?: boolean; overriddenFrom?: number }
) {
  const { overriddenFrom, ...rest } = data;
  return prisma.taskQueue.create({
    data: {
      friendlyId: generateFriendlyId("queue"),
      name,
      orderableName: name,
      type: "NAMED",
      version: "V2",
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
      ...rest,
      ...(overriddenFrom === undefined
        ? {}
        : { concurrencyLimitBase: overriddenFrom, concurrencyLimitOverriddenAt: new Date() }),
    },
  });
}

/** Polls until a client's SET is held by CLIENT PAUSE, i.e. the reset has read its row. */
async function waitForHeldSet(admin: Redis) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const clients = (await admin.call("CLIENT", "LIST")) as string;
    if (/flags=b .* cmd=set /.test(clients)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The reset never reached the engine");
}

describe("resetting a queue's concurrency override", () => {
  containerTest(
    "a failed engine write keeps the override so a retry converges",
    async ({ prisma, redisOptions }) => {
      const { engine, environment, system } = await setup(prisma, redisOptions);
      const queue = await createQueue(prisma, environment, "flaky", {
        concurrencyLimit: 1,
        overriddenFrom: 5,
      });
      await engine.runQueue.updateQueueConcurrencyLimits(environment, "flaky", 1);

      // Make the engine's SET fail for real until allowed again.
      const admin = new Redis(redisOptions);
      const allowSet = () => admin.call("ACL", "SETUSER", "default", "+set");
      onTestFinished(async () => {
        await allowSet();
        await admin.quit();
      });
      await admin.call("ACL", "SETUSER", "default", "-set");

      const failed = await system.queues.resetConcurrencyLimit(environment, queue.friendlyId);

      expect(failed.isErr() && failed.error.type).toBe("sync_queue_concurrency_to_engine_failed");
      const kept = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(kept.concurrencyLimitOverriddenAt).not.toBeNull();
      expect(kept.concurrencyLimit).toBe(1);

      await allowSet();
      const retried = await system.queues.resetConcurrencyLimit(environment, queue.friendlyId);

      expect(retried.isOk()).toBe(true);
      const reset = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(reset.concurrencyLimitOverriddenAt).toBeNull();
      expect(reset.concurrencyLimit).toBe(5);
      expect(await engine.runQueue.getQueueConcurrencyLimit(environment, "flaky")).toBe(5);
    }
  );

  containerTest(
    "a failed row write puts the engine back to the stored override",
    async ({ prisma, redisOptions }) => {
      const { engine, environment, system } = await setup(prisma, redisOptions);
      const queue = await createQueue(prisma, environment, "blocked", {
        concurrencyLimit: 0,
        overriddenFrom: 5,
      });
      await engine.runQueue.updateQueueConcurrencyLimits(environment, "blocked", 0);

      // Make clearing the override fail in Postgres for a reason other than a conflict.
      // Each test gets its own database, so the trigger goes away with it.
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION reject_reset() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'reset rejected'; END $$ LANGUAGE plpgsql`
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER reject_reset BEFORE UPDATE ON "TaskQueue" FOR EACH ROW WHEN (NEW."concurrencyLimitOverriddenAt" IS NULL) EXECUTE FUNCTION reject_reset()`
      );

      const result = await system.queues.resetConcurrencyLimit(environment, queue.friendlyId);

      expect(result.isErr() && result.error.type).toBe("queue_update_failed");
      expect(await engine.runQueue.getQueueConcurrencyLimit(environment, "blocked")).toBe(0);
    }
  );

  containerTest(
    "resetting a paused queue enforces the pause even if its own engine write was lost",
    async ({ prisma, redisOptions }) => {
      const { engine, environment, system } = await setup(prisma, redisOptions);
      const queue = await createQueue(prisma, environment, "paused-stale", {
        concurrencyLimit: 1,
        overriddenFrom: 5,
        paused: true,
      });
      // The pause was saved but its engine write failed, so the old limit is still enforced.
      await engine.runQueue.updateQueueConcurrencyLimits(environment, "paused-stale", 2);

      const result = await system.queues.resetConcurrencyLimit(environment, queue.friendlyId);

      expect(result.isOk()).toBe(true);
      expect(await engine.runQueue.getQueueConcurrencyLimit(environment, "paused-stale")).toBe(0);
    }
  );

  containerTest(
    "a failing total-limit key does not fail a completed per-key reset",
    async ({ prisma, redisOptions }) => {
      const { engine, environment, system } = await setup(prisma, redisOptions);
      const queue = await createQueue(prisma, environment, "no-total", {
        concurrencyLimit: 1,
        overriddenFrom: 5,
      });
      await engine.runQueue.updateQueueConcurrencyLimits(environment, "no-total", 1);

      // The per-key reset writes with SET; removing the absent total key would use DEL.
      const admin = new Redis(redisOptions);
      onTestFinished(async () => {
        await admin.call("ACL", "SETUSER", "default", "+del");
        await admin.quit();
      });
      await admin.call("ACL", "SETUSER", "default", "-del");

      const result = await system.queues.resetConcurrencyLimit(environment, queue.friendlyId);

      expect(result.isOk()).toBe(true);
      expect(await engine.runQueue.getQueueConcurrencyLimit(environment, "no-total")).toBe(5);
    }
  );

  containerTest(
    "does not touch the engine for a queue that is not overridden",
    async ({ prisma, redisOptions }) => {
      const { engine, environment, system } = await setup(prisma, redisOptions);
      const queue = await createQueue(prisma, environment, "plain", { concurrencyLimit: 5 });
      // Differs from the row, so any engine write would show.
      await engine.runQueue.updateQueueConcurrencyLimits(environment, "plain", 3);

      const result = await system.queues.resetConcurrencyLimit(environment, queue.friendlyId);

      expect(result.isErr() && result.error.type).toBe("queue_not_overridden");
      expect(await engine.runQueue.getQueueConcurrencyLimit(environment, "plain")).toBe(3);
    }
  );

  containerTest(
    "a pause committed while the reset's engine write is held still wins",
    async ({ prisma, redisOptions }) => {
      const { engine, environment, system } = await setup(prisma, redisOptions);
      const queue = await createQueue(prisma, environment, "racing", {
        concurrencyLimit: 1,
        overriddenFrom: 5,
      });
      await engine.runQueue.updateQueueConcurrencyLimits(environment, "racing", 1);

      // Hold every Redis write so a pause commits after the reset read its row.
      const admin = new Redis(redisOptions);
      onTestFinished(() => admin.quit());
      await admin.call("CLIENT", "PAUSE", "30000", "WRITE");
      const reset = system.queues.resetConcurrencyLimit(environment, queue.friendlyId);
      await waitForHeldSet(admin);
      await prisma.taskQueue.update({ where: { id: queue.id }, data: { paused: true } });
      await admin.call("CLIENT", "UNPAUSE");

      const result = await reset;

      expect(result.isOk()).toBe(true);
      expect(await engine.runQueue.getQueueConcurrencyLimit(environment, "racing")).toBe(0);
    }
  );
});
