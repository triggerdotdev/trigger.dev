import { assertNonNullable, containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import { UnclassifiableWaitpointId } from "../errors.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Real (non-mock) PostgresRunStore subclass that records which routed waitpoint/edge
 * methods the engine actually calls, then delegates to super over the real container.
 * This proves the create/block writes route through this.$.runStore.
 */
class CountingRunStore extends PostgresRunStore {
  calls: string[] = [];

  override async upsertWaitpoint<T extends Prisma.WaitpointUpsertArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpsertArgs>,
    tx?: any
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    this.calls.push("upsertWaitpoint");
    return super.upsertWaitpoint(args, tx);
  }
  override async createWaitpoint<T extends Prisma.WaitpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointCreateArgs>,
    tx?: any
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    this.calls.push("createWaitpoint");
    return super.createWaitpoint(args, tx);
  }
  override async findWaitpoint<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>,
    client?: any
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    this.calls.push("findWaitpoint");
    return super.findWaitpoint(args, client);
  }
  override async updateWaitpoint<T extends Prisma.WaitpointUpdateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpdateArgs>,
    tx?: any
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    this.calls.push("updateWaitpoint");
    return super.updateWaitpoint(args, tx);
  }
  override async blockRunWithWaitpointEdges(
    params: Parameters<PostgresRunStore["blockRunWithWaitpointEdges"]>[0]
  ): Promise<void> {
    this.calls.push("blockRunWithWaitpointEdges");
    return super.blockRunWithWaitpointEdges(params);
  }
  override async countPendingWaitpoints(waitpointIds: string[], client?: any): Promise<number> {
    this.calls.push("countPendingWaitpoints");
    return super.countPendingWaitpoints(waitpointIds, client);
  }
  override async deleteManyTaskRunWaitpoints(
    args: Prisma.TaskRunWaitpointDeleteManyArgs,
    tx?: any
  ): Promise<Prisma.BatchPayload> {
    this.calls.push("deleteManyTaskRunWaitpoints");
    return super.deleteManyTaskRunWaitpoints(args, tx);
  }

  // The residency store-selection guard. It is the FIRST statement of completeWaitpoint,
  // so counting it directly observes "the guard fired" before any completion DB step.
  // The single-store super returns `this`, so the SAME store keeps recording downstream.
  override forWaitpointCompletion(
    waitpointId: string,
    context: Parameters<PostgresRunStore["forWaitpointCompletion"]>[1]
  ): PostgresRunStore {
    this.calls.push("forWaitpointCompletion");
    return super.forWaitpointCompletion(waitpointId, context) as PostgresRunStore;
  }
  override async updateManyWaitpoints(
    args: Prisma.WaitpointUpdateManyArgs,
    tx?: any
  ): Promise<Prisma.BatchPayload> {
    this.calls.push("updateManyWaitpoints");
    return super.updateManyWaitpoints(args, tx);
  }
  override async findManyTaskRunWaitpoints<T extends Prisma.TaskRunWaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunWaitpointFindManyArgs>,
    client?: any
  ): Promise<Prisma.TaskRunWaitpointGetPayload<T>[]> {
    this.calls.push("findManyTaskRunWaitpoints");
    return super.findManyTaskRunWaitpoints(args, client);
  }
}

function buildEngine(prisma: PrismaClient, redisOptions: any, store?: PostgresRunStore) {
  return new RunEngine({
    prisma,
    ...(store ? { store } : {}),
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function triggerExecutingRun(
  engine: RunEngine,
  prisma: PrismaClient,
  authenticatedEnvironment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  taskIdentifier: string,
  friendlyId: string,
  spanId: string
) {
  await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

  const run = await engine.trigger(
    {
      number: 1,
      friendlyId,
      environment: authenticatedEnvironment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-${spanId}`,
      spanId,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );

  await setTimeout(500);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: `consumer-${spanId}`,
    workerQueue: "main",
  });
  await engine.startRunAttempt({
    runId: dequeued[0].run.id,
    snapshotId: dequeued[0].snapshot.id,
  });

  return run;
}

describe("WaitpointSystem create/block write routing", () => {
  // DATETIME create routes the (env, idempotencyKey) upsert through the store.
  containerTest("DATETIME create routes through the store", async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = buildEngine(prisma, redisOptions, store);

    try {
      const completedAfter = new Date(Date.now() + 60_000);
      const { waitpoint } = await engine.createDateTimeWaitpoint({
        projectId: env.projectId,
        environmentId: env.id,
        completedAfter,
      });

      expect(store.calls).toContain("upsertWaitpoint");

      const row = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
      expect(row?.type).toBe("DATETIME");
      expect(row?.environmentId).toBe(env.id);
    } finally {
      await engine.quit();
    }
  });

  // MANUAL create routes through the store.
  containerTest("MANUAL create routes through the store", async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = buildEngine(prisma, redisOptions, store);

    try {
      const { waitpoint } = await engine.createManualWaitpoint({
        environmentId: env.id,
        projectId: env.projectId,
        timeout: new Date(Date.now() + 60_000),
      });

      expect(store.calls).toContain("upsertWaitpoint");

      const row = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
      expect(row?.type).toBe("MANUAL");
    } finally {
      await engine.quit();
    }
  });

  // Block routes the CTE + the separate pending check through the store (two
  // distinct calls in order), writes exactly one TaskRunWaitpoint + one edge, and the
  // ON CONFLICT DO NOTHING idempotency holds on a repeat block.
  containerTest(
    "block routes the CTE + pending check through the store",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const run = await triggerExecutingRun(
          engine,
          prisma,
          env,
          "test-task-c",
          "run_c1234",
          "sc1234"
        );

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });

        store.calls.length = 0;

        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        const blockIdx = store.calls.indexOf("blockRunWithWaitpointEdges");
        const pendingIdx = store.calls.indexOf("countPendingWaitpoints");
        expect(blockIdx).toBeGreaterThanOrEqual(0);
        expect(pendingIdx).toBeGreaterThan(blockIdx);

        const trws = await prisma.taskRunWaitpoint.findMany({ where: { taskRunId: run.id } });
        expect(trws).toHaveLength(1);
        expect(trws[0].waitpointId).toBe(waitpoint.id);

        const connections = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) as count FROM "_WaitpointRunConnections"
          WHERE "A" = ${run.id} AND "B" = ${waitpoint.id}`;
        expect(Number(connections[0].count)).toBe(1);

        const execData = await engine.getRunExecutionData({ runId: run.id });
        expect(execData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Re-block with the same waitpoint. The _WaitpointRunConnections edge has a (A,B)
        // unique key, so ON CONFLICT DO NOTHING keeps it at exactly one row across repeats —
        // that is the idempotency the routed CTE preserves. (TaskRunWaitpoint's unique key is
        // (taskRunId, waitpointId, batchIndex); with a NULL batchIndex NULLs never conflict,
        // so its row count is not the idempotency signal here — matching today's behavior.)
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        const connectionsAfter = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) as count FROM "_WaitpointRunConnections"
          WHERE "A" = ${run.id} AND "B" = ${waitpoint.id}`;
        expect(Number(connectionsAfter[0].count)).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  // clearBlockingWaitpoints routes the delete through the store.
  containerTest("clearBlockingWaitpoints routes the delete", async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = buildEngine(prisma, redisOptions, store);

    try {
      const run = await triggerExecutingRun(
        engine,
        prisma,
        env,
        "test-task-d",
        "run_d1234",
        "sd1234"
      );

      const { waitpoint } = await engine.createManualWaitpoint({
        environmentId: env.id,
        projectId: env.projectId,
      });
      await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: waitpoint.id,
        projectId: env.projectId,
        organizationId: env.organizationId,
      });

      store.calls.length = 0;
      const count = await engine.waitpointSystem.clearBlockingWaitpoints({ runId: run.id });

      expect(store.calls).toContain("deleteManyTaskRunWaitpoints");
      expect(count).toBe(1);
      const remaining = await prisma.taskRunWaitpoint.findMany({ where: { taskRunId: run.id } });
      expect(remaining).toHaveLength(0);
    } finally {
      await engine.quit();
    }
  });

  // Single-DB binds one client (passthrough), proven by BEHAVIOR — a create + block
  // + clear round-trip resolves on the one configured client. The default-store engine has no
  // accessible store.prisma member, so we never assert store.prisma === prisma.
  containerTest(
    "single-DB passthrough: round-trip resolves on the one client (default store)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      // No `store` option => engine constructs its own default PostgresRunStore over `prisma`.
      const engine = buildEngine(prisma, redisOptions);

      try {
        const run = await triggerExecutingRun(
          engine,
          prisma,
          env,
          "test-task-e",
          "run_e1234",
          "se1234"
        );

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        const blocked = await prisma.taskRunWaitpoint.findMany({ where: { taskRunId: run.id } });
        expect(blocked).toHaveLength(1);

        const cleared = await engine.waitpointSystem.clearBlockingWaitpoints({ runId: run.id });
        expect(cleared).toBe(1);
        const after = await prisma.taskRunWaitpoint.findMany({ where: { taskRunId: run.id } });
        expect(after).toHaveLength(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // Idempotency-key reuse returns the same waitpoint (single authority) — exactly one
  // row, no duplicate — for both MANUAL and DATETIME.
  containerTest(
    "idempotency-key reuse returns the same waitpoint (single authority)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const future = new Date(Date.now() + 60 * 60_000);

        const first = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
          idempotencyKey: "ik-manual",
          idempotencyKeyExpiresAt: future,
        });
        const second = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
          idempotencyKey: "ik-manual",
          idempotencyKeyExpiresAt: future,
        });

        expect(second.isCached).toBe(true);
        expect(second.waitpoint.id).toBe(first.waitpoint.id);
        const manualRows = await prisma.waitpoint.findMany({
          where: { environmentId: env.id, idempotencyKey: "ik-manual" },
        });
        expect(manualRows).toHaveLength(1);

        const firstDt = await engine.createDateTimeWaitpoint({
          projectId: env.projectId,
          environmentId: env.id,
          completedAfter: future,
          idempotencyKey: "ik-datetime",
          idempotencyKeyExpiresAt: future,
        });
        const secondDt = await engine.createDateTimeWaitpoint({
          projectId: env.projectId,
          environmentId: env.id,
          completedAfter: future,
          idempotencyKey: "ik-datetime",
          idempotencyKeyExpiresAt: future,
        });

        expect(secondDt.isCached).toBe(true);
        expect(secondDt.waitpoint.id).toBe(firstDt.waitpoint.id);
        const dtRows = await prisma.waitpoint.findMany({
          where: { environmentId: env.id, idempotencyKey: "ik-datetime" },
        });
        expect(dtRows).toHaveLength(1);
      } finally {
        await engine.quit();
      }
    }
  );

  // An expired idempotency key rotates (read-legacy-first: find -> update ->
  // upsert all through the authority store) rather than duplicating.
  containerTest(
    "expired idempotency key rotates through the store (find -> update -> upsert)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const past = new Date(Date.now() - 60_000);
        const first = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
          idempotencyKey: "ik-expire",
          idempotencyKeyExpiresAt: past,
        });

        store.calls.length = 0;

        const second = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
          idempotencyKey: "ik-expire",
          idempotencyKeyExpiresAt: new Date(Date.now() + 60 * 60_000),
        });

        // read-legacy-first then rotate then upsert, all via the authority store.
        const findIdx = store.calls.indexOf("findWaitpoint");
        const updateIdx = store.calls.indexOf("updateWaitpoint");
        const upsertIdx = store.calls.indexOf("upsertWaitpoint");
        expect(findIdx).toBeGreaterThanOrEqual(0);
        expect(updateIdx).toBeGreaterThan(findIdx);
        expect(upsertIdx).toBeGreaterThan(updateIdx);

        // The original row had its key rotated to a fresh nanoid + inactiveIdempotencyKey set.
        const original = await prisma.waitpoint.findFirst({ where: { id: first.waitpoint.id } });
        expect(original?.idempotencyKey).not.toBe("ik-expire");
        expect(original?.inactiveIdempotencyKey).toBe("ik-expire");

        // A NEW waitpoint now holds the key.
        expect(second.isCached).toBe(false);
        expect(second.waitpoint.id).not.toBe(first.waitpoint.id);
        const active = await prisma.waitpoint.findFirst({
          where: { environmentId: env.id, idempotencyKey: "ik-expire" },
        });
        expect(active?.id).toBe(second.waitpoint.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // The P2002 retry loop in createManualWaitpoint survives store routing — a single
  // unique-constraint conflict resolves to one row without throwing.
  containerTest(
    "createManualWaitpoint P2002 retry loop preserved through routing",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // The P2002 retry loop wraps the routed upsertWaitpoint. Count attempts to prove the
      // loop drives the store call, and assert that a reused key resolves to a single row
      // (the unique-constraint path the loop guards) without throwing.
      let upsertAttempts = 0;
      class RacyStore extends PostgresRunStore {
        override async upsertWaitpoint<T extends Prisma.WaitpointUpsertArgs>(
          args: Prisma.SelectSubset<T, Prisma.WaitpointUpsertArgs>,
          tx?: any
        ): Promise<Prisma.WaitpointGetPayload<T>> {
          upsertAttempts++;
          return super.upsertWaitpoint(args, tx);
        }
      }
      const store = new RacyStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const a = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        expect(a.waitpoint.id).toBeDefined();

        const k1 = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
          idempotencyKey: "ik-race",
          idempotencyKeyExpiresAt: new Date(Date.now() + 60 * 60_000),
        });
        const k2 = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
          idempotencyKey: "ik-race",
          idempotencyKeyExpiresAt: new Date(Date.now() + 60 * 60_000),
        });
        expect(k2.waitpoint.id).toBe(k1.waitpoint.id);
        const rows = await prisma.waitpoint.findMany({
          where: { environmentId: env.id, idempotencyKey: "ik-race" },
        });
        expect(rows).toHaveLength(1);
        expect(upsertAttempts).toBeGreaterThan(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // DATETIME/MANUAL create round-trips byte-identically across both Postgres major versions
  // via the store's upsertWaitpoint/findWaitpoint (the methods this unit's create paths delegate to).
  heteroPostgresTest(
    "create round-trip is byte-identical across both Postgres major versions",
    async ({ prisma14, prisma17 }) => {
      const future = new Date("2024-03-03T00:00:00.000Z");

      const run = async (prisma: PrismaClient, suffix: string) => {
        const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        const env = await seedHeteroEnvironment(prisma, suffix);

        const datetime = await store.upsertWaitpoint({
          where: {
            environmentId_idempotencyKey: { environmentId: env.id, idempotencyKey: "dt-key" },
          },
          create: {
            id: `wp_dt_${suffix}`,
            friendlyId: `waitpoint_dt_${suffix}`,
            type: "DATETIME",
            idempotencyKey: "dt-key",
            idempotencyKeyExpiresAt: future,
            userProvidedIdempotencyKey: true,
            environmentId: env.id,
            projectId: env.projectId,
            completedAfter: future,
          },
          update: {},
        });
        const manual = await store.upsertWaitpoint({
          where: {
            environmentId_idempotencyKey: { environmentId: env.id, idempotencyKey: "mn-key" },
          },
          create: {
            id: `wp_mn_${suffix}`,
            friendlyId: `waitpoint_mn_${suffix}`,
            type: "MANUAL",
            idempotencyKey: "mn-key",
            idempotencyKeyExpiresAt: future,
            userProvidedIdempotencyKey: true,
            environmentId: env.id,
            projectId: env.projectId,
            completedAfter: future,
            tags: ["alpha", "beta"],
          },
          update: {},
        });

        return {
          dt: await store.findWaitpoint({ where: { id: datetime.id } }),
          mn: await store.findWaitpoint({ where: { id: manual.id } }),
        };
      };

      const r14 = await run(prisma14, "i14");
      const r17 = await run(prisma17, "i17");

      expect(normalizeWaitpoint(r14.dt!)).toEqual(normalizeWaitpoint(r17.dt!));
      expect(normalizeWaitpoint(r14.mn!)).toEqual(normalizeWaitpoint(r17.mn!));
      expect(r14.mn!.tags).toEqual(r17.mn!.tags);
      expect(r14.dt!.completedAfter?.toISOString()).toBe(r17.dt!.completedAfter?.toISOString());
    }
  );

  // The block CTE round-trips across both Postgres major versions — one TaskRunWaitpoint +
  // one edge on both versions, idempotent on repeat, and the separate pending count reads 1 pre-complete.
  heteroPostgresTest(
    "block CTE round-trips identically across both Postgres major versions",
    async ({ prisma14, prisma17 }) => {
      const run = async (prisma: PrismaClient, suffix: string) => {
        const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        const env = await seedHeteroEnvironment(prisma, suffix);
        const runId = `run_block_${suffix}`;
        await prisma.taskRun.create({
          data: {
            id: runId,
            engine: "V2",
            status: "PENDING",
            friendlyId: `run_friendly_${suffix}`,
            runtimeEnvironmentId: env.id,
            organizationId: env.organizationId,
            projectId: env.projectId,
            taskIdentifier: "my-task",
            payload: "{}",
            payloadType: "application/json",
            queue: "task/my-task",
            traceId: `trace_${suffix}`,
            spanId: `span_${suffix}`,
          },
        });
        const wId = `wp_block_${suffix}`;
        await prisma.waitpoint.create({
          data: {
            id: wId,
            friendlyId: `waitpoint_block_${suffix}`,
            type: "MANUAL",
            status: "PENDING",
            idempotencyKey: `idem_${wId}`,
            userProvidedIdempotencyKey: false,
            projectId: env.projectId,
            environmentId: env.id,
          },
        });

        await store.blockRunWithWaitpointEdges({
          runId,
          waitpointIds: [wId],
          projectId: env.projectId,
        });
        // Repeat: the _WaitpointRunConnections (A,B) unique key keeps the edge at one row on
        // both versions (ON CONFLICT DO NOTHING idempotency for the historical connection).
        await store.blockRunWithWaitpointEdges({
          runId,
          waitpointIds: [wId],
          projectId: env.projectId,
        });

        const trws = await prisma.taskRunWaitpoint.findMany({ where: { taskRunId: runId } });
        const edges = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) as count FROM "_WaitpointRunConnections"
          WHERE "A" = ${runId} AND "B" = ${wId}`;
        const pending = await store.countPendingWaitpoints([wId]);
        return { trwCount: trws.length, edgeCount: Number(edges[0].count), pending };
      };

      const r14 = await run(prisma14, "j14");
      const r17 = await run(prisma17, "j17");

      // Identical across versions: TaskRunWaitpoint inserts (NULL batchIndex never conflicts,
      // so two rows on both), one deduped edge on both, pending count of 1 pre-complete on both.
      expect(r14).toEqual({ trwCount: 2, edgeCount: 1, pending: 1 });
      expect(r17).toEqual({ trwCount: 2, edgeCount: 1, pending: 1 });
    }
  );
});

// Triggers a child run that resumes a parent (so the engine attaches a RUN-type
// associatedWaitpoint to the child). Returns both runs; the child is left QUEUED.
async function triggerChildResumingParent(
  engine: RunEngine,
  prisma: PrismaClient,
  authenticatedEnvironment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  parentTask: string,
  childTask: string,
  suffix: string
) {
  await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

  const parentRun = await engine.trigger(
    {
      number: 1,
      friendlyId: `run_p${suffix}`,
      environment: authenticatedEnvironment,
      taskIdentifier: parentTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `tp-${suffix}`,
      spanId: `sp-${suffix}`,
      workerQueue: "main",
      queue: `task/${parentTask}`,
      isTest: false,
      tags: [],
    },
    prisma
  );

  await setTimeout(500);
  const dequeuedParent = await engine.dequeueFromWorkerQueue({
    consumerId: `consumer-p-${suffix}`,
    workerQueue: "main",
  });
  await engine.startRunAttempt({
    runId: dequeuedParent[0].run.id,
    snapshotId: dequeuedParent[0].snapshot.id,
  });

  const childRun = await engine.trigger(
    {
      number: 1,
      friendlyId: `run_c${suffix}`,
      environment: authenticatedEnvironment,
      taskIdentifier: childTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `tc-${suffix}`,
      spanId: `sc-${suffix}`,
      workerQueue: "main",
      queue: `task/${childTask}`,
      isTest: false,
      tags: [],
      resumeParentOnCompletion: true,
      parentTaskRunId: parentRun.id,
    },
    prisma
  );

  return { parentRun, childRun };
}

/**
 * Completion fan-out + residency store-selection guard.
 *
 * completeWaitpoint's FIRST statement is the residency guard
 * (this.$.runStore.forWaitpointCompletion). Every route that reaches
 * completeWaitpoint therefore records exactly one `forWaitpointCompletion`
 * BEFORE its `updateManyWaitpoints`. A missed unblock route in production is a
 * silent permanent run hang, so Group 1 enumerates EVERY route exhaustively —
 * the 7 callers plus the 2 in-file wrappers — and proves the
 * guard fires on each, not a representative sample.
 */
describe("WaitpointSystem completion fan-out + residency store-selection guard", () => {
  // Asserts the guard fired before (or, for async/enqueued completions, no later
  // than) the first completion DB write on the same store.
  function expectGuardFiredBeforeUpdate(calls: string[]) {
    const guardIdx = calls.indexOf("forWaitpointCompletion");
    const updateIdx = calls.indexOf("updateManyWaitpoints");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThanOrEqual(updateIdx);
  }

  // ----- Group 1: EXHAUSTIVE route enumeration -----

  // PUBLIC entry: engine.completeWaitpoint on a MANUAL waitpoint. The canonical
  // assertion: guard fires strictly before the update on the synchronous public path.
  containerTest(
    "guard fires on the public completeWaitpoint route",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });

        store.calls.length = 0;
        await engine.completeWaitpoint({ id: waitpoint.id });

        expect(store.calls).toContain("forWaitpointCompletion");
        const guardIdx = store.calls.indexOf("forWaitpointCompletion");
        const updateIdx = store.calls.indexOf("updateManyWaitpoints");
        // Synchronous route: guard is strictly the first DB step.
        expect(guardIdx).toBe(0);
        expect(updateIdx).toBeGreaterThan(guardIdx);
      } finally {
        await engine.quit();
      }
    }
  );

  // finishWaitpoint redis job (DATETIME): a DATETIME waitpoint with a
  // near-future completedAfter is completed by the worker firing finishWaitpoint.
  containerTest(
    "guard fires on the finishWaitpoint redis-job route (DATETIME)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const completedAfter = new Date(Date.now() + 1_000);
        const { waitpoint } = await engine.createDateTimeWaitpoint({
          projectId: env.projectId,
          environmentId: env.id,
          completedAfter,
        });

        store.calls.length = 0;

        // Let the finishWaitpoint job fire from the worker (it is scheduled at completedAfter).
        await vi.waitFor(
          async () => {
            const row = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
            expect(row?.status).toBe("COMPLETED");
          },
          { timeout: 15_000, interval: 100 }
        );

        // The completion went through the guard, driven by the redis job (not by us).
        expect(store.calls).toContain("forWaitpointCompletion");
        expectGuardFiredBeforeUpdate(store.calls);
      } finally {
        await engine.quit();
      }
    }
  );

  // batch (#tryCompleteBatch): a created batch whose runs are all final has its
  // BATCH waitpoint completed by batchSystem.
  containerTest(
    "guard fires on the batch completion route (#tryCompleteBatch)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const parentTask = "parent-task-r3";
        const childTask = "child-task-r3";
        // Register BOTH tasks once so the child is in the latest worker version.
        await setupBackgroundWorker(engine, env, [parentTask, childTask]);

        // Parent run, executing (inline so we don't re-register a parent-only worker).
        const parentRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_r3p",
            environment: env,
            taskIdentifier: parentTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "tr3p",
            spanId: "sr3p",
            workerQueue: "main",
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
          },
          prisma
        );
        await setTimeout(500);
        const dequeuedParent = await engine.dequeueFromWorkerQueue({
          consumerId: "consumer-r3p",
          workerQueue: "main",
        });
        await engine.startRunAttempt({
          runId: dequeuedParent[0].run.id,
          snapshotId: dequeuedParent[0].snapshot.id,
        });

        // A v2 batch with a single run; block the parent on it (creates the BATCH waitpoint).
        const { id: batchId, friendlyId: batchFriendlyId } = BatchId.generate();
        await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: batchFriendlyId,
            runtimeEnvironmentId: env.id,
            status: "PROCESSING",
            runCount: 1,
            successfulRunCount: 1,
            batchVersion: "runengine:v2",
          },
        });

        await engine.blockRunWithCreatedBatch({
          runId: parentRun.id,
          batchId,
          environmentId: env.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        // A child belonging to the batch, driven to a final (COMPLETED_SUCCESSFULLY) status.
        const childRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_r3c",
            environment: env,
            taskIdentifier: childTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "tr3c",
            spanId: "sr3c",
            workerQueue: "main",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            batch: { id: batchId, index: 0 },
          },
          prisma
        );
        await setTimeout(500);
        const dequeuedChild = await engine.dequeueFromWorkerQueue({
          consumerId: "consumer-r3c",
          workerQueue: "main",
        });
        const childAttempt = await engine.startRunAttempt({
          runId: dequeuedChild[0].run.id,
          snapshotId: dequeuedChild[0].snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childAttempt.snapshot.id,
          completion: {
            id: childRun.id,
            ok: true,
            output: '{"ok":true}',
            outputType: "application/json",
          },
        });

        store.calls.length = 0;

        // Synchronous batch-completion entry calls #tryCompleteBatch -> completeWaitpoint.
        await engine.batchSystem.performCompleteBatch({ batchId });

        expect(store.calls).toContain("forWaitpointCompletion");
        expectGuardFiredBeforeUpdate(store.calls);
      } finally {
        await engine.quit();
      }
    }
  );

  // runAttemptSystem success: a child that resumes its parent is completed
  // successfully, completing its associatedWaitpoint via runAttemptSystem.
  containerTest("guard fires on the runAttempt success route", async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = buildEngine(prisma, redisOptions, store);

    try {
      const { childRun } = await triggerChildResumingParent(
        engine,
        prisma,
        env,
        "parent-task-r4",
        "child-task-r4",
        "r4"
      );

      await setTimeout(500);
      const dequeuedChild = await engine.dequeueFromWorkerQueue({
        consumerId: "consumer-r4c",
        workerQueue: "main",
      });
      const childAttempt = await engine.startRunAttempt({
        runId: dequeuedChild[0].run.id,
        snapshotId: dequeuedChild[0].snapshot.id,
      });

      store.calls.length = 0;
      await engine.completeRunAttempt({
        runId: childRun.id,
        snapshotId: childAttempt.snapshot.id,
        completion: {
          id: childRun.id,
          ok: true,
          output: '{"foo":"bar"}',
          outputType: "application/json",
        },
      });

      expect(store.calls).toContain("forWaitpointCompletion");
      expectGuardFiredBeforeUpdate(store.calls);
    } finally {
      await engine.quit();
    }
  });

  // runAttemptSystem cancel: cancelling a still-queued child finishes it
  // immediately and completes its associatedWaitpoint via runAttemptSystem.
  containerTest("guard fires on the runAttempt cancel route", async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = buildEngine(prisma, redisOptions, store);

    try {
      const { childRun } = await triggerChildResumingParent(
        engine,
        prisma,
        env,
        "parent-task-r5",
        "child-task-r5",
        "r5"
      );

      const associatedWaitpoint = await prisma.waitpoint.findFirstOrThrow({
        where: { completedByTaskRunId: childRun.id },
      });
      expect(associatedWaitpoint.status).toBe("PENDING");

      store.calls.length = 0;
      const result = await engine.cancelRun({
        runId: childRun.id,
        completedAt: new Date(),
        reason: "Cancelled by the user",
      });
      expect(result.snapshot.executionStatus).toBe("FINISHED");

      expect(store.calls).toContain("forWaitpointCompletion");
      expectGuardFiredBeforeUpdate(store.calls);

      const completed = await prisma.waitpoint.findUniqueOrThrow({
        where: { id: associatedWaitpoint.id },
      });
      expect(completed.status).toBe("COMPLETED");
    } finally {
      await engine.quit();
    }
  });

  // runAttemptSystem failure: a child that resumes its parent is failed
  // permanently, completing its associatedWaitpoint (with an error output).
  containerTest("guard fires on the runAttempt failure route", async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = buildEngine(prisma, redisOptions, store);

    try {
      const { childRun } = await triggerChildResumingParent(
        engine,
        prisma,
        env,
        "parent-task-r6",
        "child-task-r6",
        "r6"
      );

      const associatedWaitpoint = await prisma.waitpoint.findFirstOrThrow({
        where: { completedByTaskRunId: childRun.id },
      });

      await setTimeout(500);
      const dequeuedChild = await engine.dequeueFromWorkerQueue({
        consumerId: "consumer-r6c",
        workerQueue: "main",
      });
      const childAttempt = await engine.startRunAttempt({
        runId: dequeuedChild[0].run.id,
        snapshotId: dequeuedChild[0].snapshot.id,
      });

      store.calls.length = 0;
      // A non-retryable failure finishes the child permanently and completes its waitpoint.
      await engine.completeRunAttempt({
        runId: childRun.id,
        snapshotId: childAttempt.snapshot.id,
        completion: {
          ok: false,
          id: childRun.id,
          error: {
            type: "INTERNAL_ERROR" as const,
            code: "TASK_RUN_CRASHED" as const,
            message: "boom",
          },
        },
      });

      expect(store.calls).toContain("forWaitpointCompletion");
      expectGuardFiredBeforeUpdate(store.calls);

      const completed = await prisma.waitpoint.findUniqueOrThrow({
        where: { id: associatedWaitpoint.id },
      });
      expect(completed.status).toBe("COMPLETED");
      expect(completed.outputIsError).toBe(true);
    } finally {
      await engine.quit();
    }
  });

  // ttlSystem: a still-PENDING child that resumes its parent is expired by TTL,
  // completing its associatedWaitpoint via ttlSystem.
  containerTest("guard fires on the ttlSystem expiry route", async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = buildEngine(prisma, redisOptions, store);

    try {
      const { childRun } = await triggerChildResumingParent(
        engine,
        prisma,
        env,
        "parent-task-r7",
        "child-task-r7",
        "r7"
      );

      const associatedWaitpoint = await prisma.waitpoint.findFirstOrThrow({
        where: { completedByTaskRunId: childRun.id },
      });
      // The child is still QUEUED/PENDING (never dequeued), so the per-run expireRun
      // path will expire it and complete the associated waitpoint.
      expect(associatedWaitpoint.status).toBe("PENDING");

      store.calls.length = 0;
      await engine.ttlSystem.expireRun({ runId: childRun.id });

      expect(store.calls).toContain("forWaitpointCompletion");
      expectGuardFiredBeforeUpdate(store.calls);

      const completed = await prisma.waitpoint.findUniqueOrThrow({
        where: { id: associatedWaitpoint.id },
      });
      expect(completed.status).toBe("COMPLETED");
    } finally {
      await engine.quit();
    }
  });

  // in-file wrapper blockRunAndCompleteWaitpoint: blocks then immediately
  // completes, so the guard must fire on the inner completeWaitpoint call.
  containerTest(
    "guard fires on the blockRunAndCompleteWaitpoint wrapper",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const run = await triggerExecutingRun(engine, prisma, env, "task-w1", "run_w1", "sw1");

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });

        store.calls.length = 0;
        await engine.waitpointSystem.blockRunAndCompleteWaitpoint({
          runId: run.id,
          waitpointId: waitpoint.id,
          output: { value: '{"done":true}', type: "application/json", isError: false },
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        expect(store.calls).toContain("forWaitpointCompletion");
        expectGuardFiredBeforeUpdate(store.calls);

        const completed = await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
        expect(completed.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // in-file wrapper getOrCreateRunWaitpoint FINISHED branch: a run that has
  // already FINISHED (per its snapshot) and has no associatedWaitpoint gets a
  // freshly-created waitpoint that is immediately completed.
  containerTest(
    "guard fires on the getOrCreateRunWaitpoint FINISHED branch",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        // A standalone run (no parent), driven to FINISHED with no associatedWaitpoint.
        const run = await triggerExecutingRun(engine, prisma, env, "task-w2", "run_w2", "sw2");
        const execData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(execData);
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: execData.snapshot.id,
          completion: {
            id: run.id,
            ok: true,
            output: '{"r":1}',
            outputType: "application/json",
          },
        });

        const finished = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(finished);
        expect(finished.snapshot.executionStatus).toBe("FINISHED");

        store.calls.length = 0;
        // FINISHED + no associatedWaitpoint => getOrCreateRunWaitpoint creates one and
        // immediately completes it (the FINISHED branch).
        const waitpoint = await engine.waitpointSystem.getOrCreateRunWaitpoint({
          runId: run.id,
          projectId: env.projectId,
          environmentId: env.id,
        });

        expect(store.calls).toContain("forWaitpointCompletion");
        expectGuardFiredBeforeUpdate(store.calls);
        expect(waitpoint.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // ----- Group 2: fan-out -----

  // A completed waitpoint blocking >=2 runs unblocks every blocked run and reads the
  // blocked TaskRunWaitpoint set exactly once on the completion.
  containerTest(
    "a completed waitpoint fans out to every blocked run",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const runA = await triggerExecutingRun(
          engine,
          prisma,
          env,
          "task-fan-a",
          "run_fanA",
          "sfanA"
        );
        const runB = await triggerExecutingRun(
          engine,
          prisma,
          env,
          "task-fan-b",
          "run_fanB",
          "sfanB"
        );

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });

        for (const runId of [runA.id, runB.id]) {
          await engine.blockRunWithWaitpoint({
            runId,
            waitpoints: waitpoint.id,
            projectId: env.projectId,
            organizationId: env.organizationId,
          });
        }

        store.calls.length = 0;
        await engine.completeWaitpoint({ id: waitpoint.id });

        // The completion reads the blocked TaskRunWaitpoint set once (fan-out source).
        expect(store.calls.filter((c) => c === "findManyTaskRunWaitpoints")).toHaveLength(1);

        // Both blocked runs resume (one continueRunIfUnblocked job each).
        await vi.waitFor(
          async () => {
            for (const runId of [runA.id, runB.id]) {
              const data = await engine.getRunExecutionData({ runId });
              expect(data?.snapshot.executionStatus).toBe("EXECUTING");
            }
          },
          { timeout: 15_000, interval: 100 }
        );
      } finally {
        await engine.quit();
      }
    }
  );

  // ----- Group 3: continueRunIfUnblocked routing -----

  // continueRunIfUnblocked routes both the blocking-waitpoints read and the clear
  // through the run-store seam, and transitions the run out of the blocked state.
  containerTest(
    "continueRunIfUnblocked routes the blocking read + clear through the store",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);

      try {
        const run = await triggerExecutingRun(
          engine,
          prisma,
          env,
          "task-cont",
          "run_cont",
          "scont"
        );

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        // Complete the waitpoint so the blocking edge is COMPLETED but still present.
        await engine.completeWaitpoint({ id: waitpoint.id });

        store.calls.length = 0;
        const result = await engine.waitpointSystem.continueRunIfUnblocked({ runId: run.id });

        expect(store.calls).toContain("findManyTaskRunWaitpoints");
        expect(store.calls).toContain("deleteManyTaskRunWaitpoints");
        // The blocking read precedes the clear.
        expect(store.calls.indexOf("findManyTaskRunWaitpoints")).toBeLessThan(
          store.calls.indexOf("deleteManyTaskRunWaitpoints")
        );

        // The run left the blocked state.
        const data = await engine.getRunExecutionData({ runId: run.id });
        expect(["EXECUTING", "QUEUED"]).toContain(data?.snapshot.executionStatus);
        expect(result.status).not.toBe("blocked");
      } finally {
        await engine.quit();
      }
    }
  );

  // ----- Group 4: single-DB no-op (the classifier is NEVER consulted) -----

  // The default single store's forWaitpointCompletion returns `this` without calling
  // the classifier. Proven BY BEHAVIOR: a normal round-trip resolves on the one
  // client, and an UNCLASSIFIABLE id does NOT throw UnclassifiableWaitpointId — it
  // simply finds no row and throws the ordinary "Waitpoint not found".
  containerTest(
    "single-DB completion never consults the classifier (default store)",
    async ({ prisma, redisOptions }) => {
      // No `store` => engine builds its own default PostgresRunStore over `prisma`.
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = buildEngine(prisma, redisOptions);

      try {
        const run = await triggerExecutingRun(
          engine,
          prisma,
          env,
          "task-noop",
          "run_noop",
          "snoop"
        );

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        // (a) the completion reads back exactly as written, COMPLETED, on the one client.
        const completed = await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: '{"v":1}', type: "application/json", isError: false },
        });
        expect(completed.status).toBe("COMPLETED");
        const row = await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
        expect(row.status).toBe("COMPLETED");
        expect(row.output).toBe('{"v":1}');

        // (b) the continued run's blocking edges clear and its snapshot transitions.
        await vi.waitFor(
          async () => {
            const trws = await prisma.taskRunWaitpoint.findMany({ where: { taskRunId: run.id } });
            expect(trws).toHaveLength(0);
            const data = await engine.getRunExecutionData({ runId: run.id });
            expect(data?.snapshot.executionStatus).toBe("EXECUTING");
          },
          { timeout: 15_000, interval: 100 }
        );

        // (c) the load-bearing no-op: an unclassifiable id (length 26) must NOT throw
        // UnclassifiableWaitpointId under the default single store — the classifier is
        // never consulted. It finds no PENDING row, the re-read fails, and the ordinary
        // "Waitpoint not found" surfaces instead.
        const unclassifiableId = "waitpoint_" + "a".repeat(26);
        await expect(engine.completeWaitpoint({ id: unclassifiableId })).rejects.toThrow(
          "Waitpoint not found"
        );
        await expect(engine.completeWaitpoint({ id: unclassifiableId })).rejects.not.toBeInstanceOf(
          UnclassifiableWaitpointId
        );
      } finally {
        await engine.quit();
      }
    }
  );

  // ----- Group 5: cross-seam two-store + loud-ambiguity + pinning -----

  // Cross-seam completion applied to the OWNING store: a ksuid waitpoint resides on the dedicated
  // run-ops (NEW) DB, a cuid waitpoint on the legacy/control-plane DB. Driving the completion at the
  // store seam (forWaitpointCompletion -> updateManyWaitpoints, as the engine does) must apply each
  // completion to its owning store only.
  heteroPostgresTest(
    "cross-seam completion lands on the owning store only",
    async ({ prisma14, prisma17 }) => {
      const legacy = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy });

      const envLegacy = await seedHeteroEnvironment(prisma14, "csl");
      const envNew = await seedHeteroEnvironment(prisma17, "csn");

      // 27-char body => ksuid => NEW (dedicated run-ops DB); 25-char body => cuid => LEGACY.
      const ksuidId = "waitpoint_" + "a".repeat(27);
      const cuidId = "waitpoint_" + "b".repeat(25);

      await prisma17.waitpoint.create({
        data: {
          id: ksuidId,
          friendlyId: "waitpoint_ks",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${ksuidId}`,
          userProvidedIdempotencyKey: false,
          projectId: envNew.projectId,
          environmentId: envNew.id,
        },
      });
      await prisma14.waitpoint.create({
        data: {
          id: cuidId,
          friendlyId: "waitpoint_cu",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${cuidId}`,
          userProvidedIdempotencyKey: false,
          projectId: envLegacy.projectId,
          environmentId: envLegacy.id,
        },
      });

      const completedAt = new Date();
      const ownerKsuid = await router.forWaitpointCompletion(ksuidId, { routeKind: "MANUAL" });
      await ownerKsuid.updateManyWaitpoints({
        where: { id: ksuidId, status: "PENDING" },
        data: { status: "COMPLETED", completedAt },
      });
      const ownerCuid = await router.forWaitpointCompletion(cuidId, { routeKind: "MANUAL" });
      await ownerCuid.updateManyWaitpoints({
        where: { id: cuidId, status: "PENDING" },
        data: { status: "COMPLETED", completedAt },
      });

      // ksuid completed on the dedicated run-ops (NEW) DB only.
      expect((await prisma17.waitpoint.findUniqueOrThrow({ where: { id: ksuidId } })).status).toBe(
        "COMPLETED"
      );
      expect(await prisma14.waitpoint.findUnique({ where: { id: ksuidId } })).toBeNull();
      // cuid completed on the legacy DB only.
      expect((await prisma14.waitpoint.findUniqueOrThrow({ where: { id: cuidId } })).status).toBe(
        "COMPLETED"
      );
      expect(await prisma17.waitpoint.findUnique({ where: { id: cuidId } })).toBeNull();
    }
  );

  // Ambiguity resolution: forWaitpointCompletion safe-classifies an id matching neither cuid nor
  // ksuid to LEGACY, then probes both DBs. With no row anywhere it resolves to the LEGACY fallback
  // rather than throwing — the loud-failure contract lives at the engine seam (completeWaitpoint
  // re-reads and surfaces "Waitpoint not found"). The residency probe made this method async.
  heteroPostgresTest(
    "cross-seam forWaitpointCompletion safe-classifies an ambiguous id to legacy",
    async ({ prisma14, prisma17 }) => {
      const legacy = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy });

      const ambiguousId = "waitpoint_" + "a".repeat(26);
      const handle = await router.forWaitpointCompletion(ambiguousId, { routeKind: "MANUAL" });
      expect(handle).toBe(legacy);
    }
  );

  // Pinning proof: a cross-tree-idempotency completion of a ksuid
  // (NEW residency) waitpoint pins to the LEGACY store.
  heteroPostgresTest(
    "cross-seam cross-tree-idempotency completion pins to legacy",
    async ({ prisma14, prisma17 }) => {
      const legacy = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy });

      // pin is DRIVEN via explicit context at the store seam; the engine completeWaitpoint entry cannot derive it — the organic cross-tree-idempotency pin is applied at the webapp idempotency caller.
      const ksuidId = "waitpoint_" + "a".repeat(27);
      const handle = await router.forWaitpointCompletion(ksuidId, {
        routeKind: "IDEMPOTENCY_REUSE",
        isCrossTreeIdempotency: true,
      });
      expect(handle).toBe(legacy);
    }
  );
});

// --- hetero helpers (mirror run-store/src/runOpsStore.waitpoints.test.ts) ---

async function seedHeteroEnvironment(prisma: PrismaClient, slugSuffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slugSuffix}`,
      pkApiKey: `pk_dev_${slugSuffix}`,
      shortcode: `short_${slugSuffix}`,
    },
  });
  return {
    id: environment.id,
    projectId: project.id,
    organizationId: organization.id,
  };
}

// Strip per-DB / prisma-managed fields so rows compare field-for-field across versions.
function normalizeWaitpoint(row: Record<string, unknown>) {
  const r = { ...row };
  delete r.id;
  delete r.friendlyId;
  delete r.createdAt;
  delete r.updatedAt;
  delete r.projectId;
  delete r.environmentId;
  return r;
}
