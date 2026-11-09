import { createRedisClient, type RedisOptions } from "@internal/redis";
import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import { WaitpointSystem, type WaitpointSystemOptions } from "../systems/waitpointSystem.js";
import {
  fanoutIndexKeys,
  fanoutPartition,
  organizationPendingSourceIndexKey,
  runResultKey,
  waitpointKeys,
} from "../waitpointCoordinator/keys.js";
import {
  WaitpointNotFoundError,
  WaitpointStoreCoordinator,
  type WaitpointCompletion,
} from "../waitpointCoordinator/storeCoordinator.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { setupAuthenticatedEnvironment } from "./setup.js";

const completion: WaitpointCompletion = {
  completedAt: "2026-10-25T00:00:00.000Z",
  outputType: "application/json",
  outputIsError: false,
  output: null,
};

function commandBarrier() {
  let remaining = 0;
  let entered = false;
  let release = () => {};
  let blocked = Promise.resolve();
  return {
    arm(commands: number) {
      remaining = commands;
      entered = false;
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    entered: () => entered,
    release: () => release(),
    // Pause actual Redis command dispatch; no response or service is replaced.
    beforeCommand: async () => {
      if (remaining > 0 && --remaining === 0) {
        entered = true;
        await blocked;
      }
    },
  };
}

async function harness(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  enabled = true,
  environment?: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>
) {
  const env = environment ?? (await setupAuthenticatedEnvironment(prisma, "PRODUCTION"));
  const organizationId = env.organizationId;
  const barrier = commandBarrier();
  let flagEvaluations = 0;
  let nativeCommands = 0;
  const store = new WaitpointStoreCoordinator({
    redisOptions,
    terminalRetentionMs: 100,
    beforeCommand: async () => {
      nativeCommands++;
      await barrier.beforeCommand();
    },
  });
  const probe = createRedisClient(redisOptions);
  const engine = new RunEngine({
    prisma,
    tracer: trace.getTracer("waitpoint-fanout-retirement"),
    logLevel: "error",
    worker: { redis: redisOptions, disabled: true, workers: 1, tasksPerWorker: 1 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      ttlSystem: { disabled: true },
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
      baseCostInCents: 0.0001,
    },
    waitpointStore: store,
    waitpointFanoutStore: store,
    waitpointStoreEnabled: () => {
      flagEvaluations++;
      return enabled;
    },
  });
  // The foundation exposes WaitpointSystem routing before RunEngine wires it in #852.
  // Inject that real supported component using the engine's real resources and subsystems.
  const existing = engine.waitpointSystem as unknown as { options: WaitpointSystemOptions };
  engine.waitpointSystem = new WaitpointSystem({
    ...existing.options,
    waitpointRouting: { store: new StoreWaitpointCoordinator({ store }) },
  });
  // Drive the real handler and queue with the exact item identity RedisWorker supplies.
  const worker = (
    engine as unknown as {
      worker: {
        enqueueOnce: (args: any) => Promise<boolean>;
        queue: {
          getJob: (id: string) => Promise<any>;
          ack: (id: string, identity?: string) => Promise<void>;
        };
        jobs: { deliverWaitpointFanout: (args: any) => Promise<void> };
      };
    }
  ).worker;
  const work: Promise<unknown>[] = [];
  const track = <T>(promise: Promise<T>) => {
    work.push(promise);
    return promise;
  };
  const jobId = (id: string) => `deliverWaitpointFanout:${id}`;
  const indexes = (id: string) => ({
    due: fanoutIndexKeys(fanoutPartition(id)).due,
    owned: organizationPendingSourceIndexKey(organizationId, fanoutPartition(id)),
  });
  const arm = (id: string) =>
    worker.enqueueOnce({
      id: jobId(id),
      job: "deliverWaitpointFanout",
      payload: { waitpointId: id, organizationId },
      availableAt: new Date(),
    });
  return {
    env,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    flagEvaluations: () => flagEvaluations,
    nativeCommands: () => nativeCommands,
    store,
    probe,
    engine,
    worker,
    barrier,
    jobId,
    indexes,
    arm,
    async create(
      id: string,
      type: "RUN" | "DATETIME",
      status: "PENDING" | "COMPLETED" = "PENDING"
    ) {
      const now = new Date().toISOString();
      await store.createIfAbsent({
        record: {
          id,
          friendlyId: `waitpoint_${id}`,
          type,
          environmentId: env.id,
          organizationId,
          projectId: env.projectId,
          createdAt: now,
          updatedAt: now,
          userProvidedIdempotencyKey: false,
          tags: [],
        },
        status,
        ...(status === "COMPLETED" ? { completion } : {}),
      });
    },
    complete: (id: string) =>
      track(engine.completeWaitpoint({ id, organizationId }).catch((error: unknown) => error)),
    // #747 adds this real queue arm inside the native admission. At this foundation it is
    // intentionally supplied by the fixture, following that actual downstream ordering.
    produce: (id: string) =>
      track(
        engine.waitpointSystem
          .withWaitpointCompletionLock(id, async () => {
            await arm(id);
            return engine.completeWaitpoint({ id, organizationId });
          })
          .catch((error: unknown) => error)
      ),
    deliver: (item: any) =>
      track(
        worker.jobs.deliverWaitpointFanout({
          id: item.id,
          payload: item.item,
          deduplicationKey: item.deduplicationKey,
          attempt: item.attempt,
          visibilityTimeoutMs: item.visibilityTimeoutMs,
        })
      ),
    async assertRetired(id: string) {
      const keys = indexes(id);
      expect(await probe.zscore(keys.due, id)).toBeNull();
      expect(await probe.zscore(keys.owned, id)).toBeNull();
      expect(await worker.queue.getJob(jobId(id))).toBeNull();
    },
    async close() {
      barrier.release();
      await Promise.allSettled(work);
      await engine.quit();
      await store.quit();
      probe.disconnect();
    },
  };
}

describe("durable DATETIME fanout retirement", () => {
  containerTestWithIsolatedRedis(
    "an expired source keeps its caller error and retires both indexes and its early job",
    async ({ prisma, redisOptions }) => {
      const h = await harness(prisma, redisOptions);
      const id = generateWaitpointId("DATETIME");
      try {
        await h.create(id, "DATETIME", "COMPLETED");
        await expect
          .poll(() => h.probe.exists(waitpointKeys(id).record), {
            timeout: 2_000,
            interval: 10,
            message: "terminal DATETIME never expired",
          })
          .toBe(0);
        h.barrier.arm(1); // Producer holds admission after arming the job, before its pre-flip hint.
        await h.arm(id);
        const producer = h.complete(id);
        await expect
          .poll(h.barrier.entered, {
            timeout: 2_000,
            message: "producer never reached pre-hint dispatch",
          })
          .toBe(true);
        const item = await h.worker.queue.getJob(h.jobId(id));
        expect(item).not.toBeNull();
        const delivery = h.deliver(item);
        // A short negative window proves the handler cannot acknowledge ahead of publication.
        await setTimeout(50);
        expect(await h.worker.queue.getJob(h.jobId(id))).not.toBeNull();
        expect(await h.probe.zscore(h.indexes(id).due, id)).toBeNull();
        h.barrier.release();
        expect(await producer).toBeInstanceOf(WaitpointNotFoundError);
        await delivery;
        await h.assertRetired(id);
      } finally {
        await h.close();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "a queued expired completion gets a fresh job after terminal acknowledgement",
    async ({ prisma, redisOptions }) => {
      const h = await harness(prisma, redisOptions);
      const id = generateWaitpointId("DATETIME");
      try {
        expect(await h.produce(id)).toBeInstanceOf(WaitpointNotFoundError);
        const first = await h.worker.queue.getJob(h.jobId(id));
        h.barrier.arm(3); // describe, claim, then the actual owned-index removal.
        const delivery = h.deliver(first);
        await expect
          .poll(h.barrier.entered, {
            timeout: 2_000,
            message: "delivery never reached hint removal",
          })
          .toBe(true);
        const producer = h.produce(id);
        h.barrier.release();
        await delivery;
        expect(await producer).toBeInstanceOf(WaitpointNotFoundError);
        const next = await h.worker.queue.getJob(h.jobId(id));
        expect(next).not.toBeNull();
        expect(next.deduplicationKey).not.toBe(first.deduplicationKey);
        // RedisWorker's outer acknowledgement arrives after the lock has been released.
        await h.worker.queue.ack(first.id, first.deduplicationKey);
        expect(await h.worker.queue.getJob(h.jobId(id))).not.toBeNull();
        await h.deliver(next);
        await h.assertRetired(id);
      } finally {
        await h.close();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "pending publication retains its hint and job, then valid completion delivers",
    async ({ prisma, redisOptions }) => {
      const h = await harness(prisma, redisOptions);
      const id = generateWaitpointId("DATETIME");
      let completing: Promise<unknown> | undefined;
      try {
        await h.create(id, "DATETIME");
        const edges = [
          { waitpointId: id, createdAt: completion.completedAt, type: "DATETIME" as const },
        ];
        const absorbed = await h.store.absorbBlockers({ runId: "parent", blockId: "block", edges });
        expect(absorbed.outcome).toBe("absorbed");
        if (absorbed.outcome !== "absorbed") throw new Error("parent absorption refused");
        await h.store.registerAndDeliver({
          runId: "parent",
          blockId: "block",
          edges,
          absorbed,
          organizationId: h.env.organizationId,
        });
        await h.arm(id);
        h.barrier.arm(2); // Foundation pre-hint is durable, completion flip has not run yet.
        completing = h.store.complete({
          waitpointId: id,
          completion,
          organizationId: h.env.organizationId,
        });
        await expect
          .poll(h.barrier.entered, {
            timeout: 2_000,
            message: "completion never reached the pre-flip window",
          })
          .toBe(true);
        const item = await h.worker.queue.getJob(h.jobId(id));
        await expect(h.deliver(item)).rejects.toThrow("Waitpoint completion has not committed");
        expect(await h.probe.zscore(h.indexes(id).due, id)).not.toBeNull();
        expect(await h.probe.zscore(h.indexes(id).owned, id)).not.toBeNull();
        expect(await h.worker.queue.getJob(h.jobId(id))).not.toBeNull();
        h.barrier.release();
        await completing;
        await h.deliver(item);
        expect(await h.probe.hget(runResultKey("parent"), id)).not.toBeNull();
        expect(await h.worker.queue.getJob("continueRunIfUnblocked:parent")).not.toBeNull();
        await h.assertRetired(id);
      } finally {
        h.barrier.release();
        await completing;
        await h.close();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "a real cleanup command failure retains the job until retry converges",
    async ({ prisma, redisOptions }) => {
      const h = await harness(prisma, redisOptions);
      const id = generateWaitpointId("DATETIME");
      const native = (h.store as unknown as { redis: ReturnType<typeof createRedisClient> }).redis;
      try {
        expect(await h.produce(id)).toBeInstanceOf(WaitpointNotFoundError);
        const item = await h.worker.queue.getJob(h.jobId(id));
        // Warm the real describe/claim scripts, then deny only EVAL on this dedicated client.
        // The handler's scripted reads succeed; its raw hint cleanup must fail with NOPERM.
        await h.store.describeWaitpoint(id);
        await h.store.claimFanoutPage({
          waitpointId: id,
          workerId: "warm",
          pageSize: 1,
          leaseMs: 1_000,
        });
        await h.probe.acl("SETUSER", "cleanup-fault", "on", ">test-only", "~*", "+@all", "-eval");
        await native.auth("cleanup-fault", "test-only");
        await expect(h.deliver(item)).rejects.toThrow(/NOPERM/);
        expect(await h.worker.queue.getJob(h.jobId(id))).not.toBeNull();
        expect(await h.probe.zscore(h.indexes(id).owned, id)).not.toBeNull();
        await native.auth("default", "");
        await h.deliver(item);
        await h.assertRetired(id);
      } finally {
        await native.auth("default", "");
        await h.close();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "disabled delivery issues zero native commands and missing RUN publication still retries",
    async ({ prisma, redisOptions }) => {
      const off = await harness(prisma, redisOptions, false);
      const id = generateWaitpointId("DATETIME");
      try {
        await off.arm(id);
        await off.deliver(await off.worker.queue.getJob(off.jobId(id)));
        // Native-shaped completion stays on its original disabled legacy/error path.
        expect(await off.complete(id)).toBeInstanceOf(Error);
        await off.probe.ping(); // Drain preceding server command observations.
        expect(off.nativeCommands()).toBe(0);
      } finally {
        await off.close();
      }
      const on = await harness(prisma, redisOptions, true, off.env);
      const runId = generateWaitpointId("RUN");
      try {
        await on.arm(runId);
        await expect(on.deliver(await on.worker.queue.getJob(on.jobId(runId)))).rejects.toThrow(
          "Waitpoint completion has not committed"
        );
        expect(await on.worker.queue.getJob(on.jobId(runId))).not.toBeNull();

        const dateTime = generateWaitpointId("DATETIME");
        await on.arm(dateTime);
        const item = await on.worker.queue.getJob(on.jobId(dateTime));
        let entered = false;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const holder = on.engine.waitpointSystem.withWaitpointCompletionLock(dateTime, async () => {
          entered = true;
          await blocked;
        });
        const nativeBefore = on.nativeCommands();
        let delivery: Promise<void> | undefined;
        try {
          await expect
            .poll(() => entered, {
              timeout: 2_000,
              message: "DATETIME admission lock was never held",
            })
            .toBe(true);
          const before = on.flagEvaluations();
          delivery = on.deliver(item);
          await expect
            .poll(on.flagEvaluations, {
              timeout: 2_000,
              message: "queued delivery never checked its enabled gate",
            })
            .toBeGreaterThan(before);
          on.setEnabled(false);
          release();
          await holder;
          await delivery;
          await on.probe.ping();
          expect(on.nativeCommands()).toBe(nativeBefore);
          await on.worker.queue.ack(item.id, item.deduplicationKey);
          expect(await on.worker.queue.getJob(on.jobId(dateTime))).toBeNull();
        } finally {
          release();
          await holder;
          await delivery;
        }
      } finally {
        await on.close();
      }
    }
  );
});
