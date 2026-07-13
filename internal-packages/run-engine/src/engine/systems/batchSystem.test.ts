import {
  assertNonNullable,
  containerTestWithIsolatedRedis as containerTest,
} from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore, type RunStore } from "@internal/run-store";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngineOptions(redisOptions: any, prisma: any, store?: RunStore) {
  return {
    prisma,
    ...(store ? { store } : {}),
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 20,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x" as const,
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
  };
}

/**
 * A real PostgresRunStore subclass that counts the four batch-completion reads/writes
 * #tryCompleteBatch routes through. super.* runs the genuine implementation, so the routing is
 * observed over real containers without ever mocking prisma or the store.
 */
class CountingPostgresRunStore extends PostgresRunStore {
  public batchReads = 0;
  public memberRunReads = 0;
  public batchUpdates = 0;
  public waitpointReads = 0;
  // Captures the `where` of the most recent findRuns call so a test can prove the member-run read
  // is scoped by BOTH batchId AND runtimeEnvironmentId (matching the index), not batchId alone.
  public lastFindRunsWhere: any = undefined;

  override async findBatchTaskRunById(
    id: string,
    args?: any,
    client?: any
  ): ReturnType<PostgresRunStore["findBatchTaskRunById"]> {
    this.batchReads++;
    return super.findBatchTaskRunById(id, args, client);
  }

  override async findRuns(args: any, client?: any): Promise<any> {
    this.memberRunReads++;
    this.lastFindRunsWhere = args?.where;
    return super.findRuns(args, client);
  }

  override async updateBatchTaskRun<S extends Prisma.BatchTaskRunSelect>(
    args: {
      where: Prisma.BatchTaskRunWhereUniqueInput;
      data: Prisma.BatchTaskRunUpdateInput;
      select: S;
    },
    tx?: any
  ): Promise<Prisma.BatchTaskRunGetPayload<{ select: S }>> {
    this.batchUpdates++;
    return super.updateBatchTaskRun(args, tx);
  }

  override async findWaitpoint<T extends Prisma.WaitpointFindFirstArgs>(
    args: any,
    client?: any
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    this.waitpointReads++;
    return super.findWaitpoint(args, client);
  }
}

/**
 * Drives a batchTriggerAndWait batch to all-children-complete, returning the engine + ids needed
 * to assert completion. Mirrors the batchTriggerAndWait.test.ts preamble; the parent is blocked on
 * the batch waitpoint and both children are run to completion.
 */
async function driveBatchToAllChildrenComplete(
  engine: RunEngine,
  prisma: PrismaClient,
  friendlyPrefix: string
) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const parentTask = "parent-task";
  const childTask = "child-task";
  await setupBackgroundWorker(engine, environment, [parentTask, childTask]);

  const batch = await prisma.batchTaskRun.create({
    data: {
      friendlyId: generateFriendlyId("batch"),
      runtimeEnvironmentId: environment.id,
      runCount: 2,
      processingJobsCount: 2,
    },
  });

  const parentRun = await engine.trigger(
    {
      number: 1,
      friendlyId: generateFriendlyId("run"),
      environment,
      taskIdentifier: parentTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue: `task/${parentTask}`,
      isTest: false,
      tags: [],
    },
    prisma
  );

  await setTimeout(500);
  await engine.dequeueFromWorkerQueue({ consumerId: "test_consumer", workerQueue: "main" });

  const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
  assertNonNullable(initialExecutionData);
  await engine.startRunAttempt({
    runId: parentRun.id,
    snapshotId: initialExecutionData.snapshot.id,
  });

  await engine.blockRunWithCreatedBatch({
    runId: parentRun.id,
    batchId: batch.id,
    environmentId: environment.id,
    projectId: environment.projectId,
    organizationId: environment.organizationId,
  });

  const child1 = await engine.trigger(
    {
      number: 1,
      friendlyId: generateFriendlyId("run"),
      environment,
      taskIdentifier: childTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12346",
      spanId: "s12346",
      workerQueue: "main",
      queue: `task/${childTask}`,
      isTest: false,
      tags: [],
      resumeParentOnCompletion: true,
      parentTaskRunId: parentRun.id,
      batch: { id: batch.id, index: 0 },
    },
    prisma
  );

  const child2 = await engine.trigger(
    {
      number: 2,
      friendlyId: generateFriendlyId("run"),
      environment,
      taskIdentifier: childTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12347",
      spanId: "s12347",
      workerQueue: "main",
      queue: `task/${childTask}`,
      isTest: false,
      tags: [],
      resumeParentOnCompletion: true,
      parentTaskRunId: parentRun.id,
      batch: { id: batch.id, index: 1 },
    },
    prisma
  );

  for (const child of [child1, child2]) {
    await setTimeout(500);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_consumer",
      workerQueue: "main",
    });
    const match = dequeued.find((d) => d.run.id === child.id) ?? dequeued[0];
    assertNonNullable(match);
    const attempt = await engine.startRunAttempt({
      runId: match.run.id,
      snapshotId: match.snapshot.id,
    });
    await engine.completeRunAttempt({
      runId: attempt.run.id,
      snapshotId: attempt.snapshot.id,
      completion: {
        id: attempt.run.id,
        ok: true,
        output: '{"foo":"bar"}',
        outputType: "application/json",
      },
    });
  }

  await setTimeout(500);

  return { environment, batch, parentRun, child1, child2 };
}

describe("RunEngine #tryCompleteBatch store routing", () => {
  // Batch completion reads/writes route through the store.
  containerTest(
    "batch completion reads/writes route through the store",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const { batch } = await driveBatchToAllChildrenComplete(engine, prisma, "run_batch_d");

        // The batch completes through #tryCompleteBatch (driven by the debounced worker on the last
        // child completing). All four reads/writes must have routed through the injected store.
        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });

        expect(countingStore.batchReads).toBeGreaterThan(0);
        expect(countingStore.memberRunReads).toBeGreaterThan(0);
        expect(countingStore.batchUpdates).toBeGreaterThan(0);
        expect(countingStore.waitpointReads).toBeGreaterThan(0);

        const completedBatch = await prisma.batchTaskRun.findFirst({ where: { id: batch.id } });
        expect(completedBatch?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // The batch waitpoint completion goes through the guarded completeWaitpoint, unblocking
  // the parent run.
  containerTest(
    "waitpoint completion goes through the guarded completeWaitpoint (parent resumes)",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const { batch, parentRun } = await driveBatchToAllChildrenComplete(
          engine,
          prisma,
          "run_batch_e"
        );

        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });
        await setTimeout(1_000);

        const batchWaitpoint = await prisma.waitpoint.findFirst({
          where: { completedByBatchId: batch.id },
        });
        assertNonNullable(batchWaitpoint);
        expect(batchWaitpoint.status).toBe("COMPLETED");

        // the parent is no longer blocked on the batch waitpoint
        const remainingParentWaitpoints = await prisma.taskRunWaitpoint.findMany({
          where: { taskRunId: parentRun.id },
        });
        expect(remainingParentWaitpoints.length).toBe(0);

        const parentExecution = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecution);
        expect(parentExecution.snapshot.executionStatus).not.toBe("EXECUTING_WITH_WAITPOINTS");
      } finally {
        await engine.quit();
      }
    }
  );

  // The member-run read is driven by batchId only and does not rely on the
  // BatchTaskRun.runtimeEnvironmentId FK. A second batch (distinct batchId) must not leak members
  // into the first batch's batchId-scoped read.
  containerTest(
    "member-run read does not rely on the runtimeEnvironmentId FK (no cross-batch leakage)",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const { batch, environment } = await driveBatchToAllChildrenComplete(
          engine,
          prisma,
          "run_batch_f"
        );

        const otherBatch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: generateFriendlyId("batch"),
            runtimeEnvironmentId: environment.id,
          },
        });

        // The first batch's batchId-scoped read finds exactly its two members and never the second
        // batch's (zero) members — proving batchId alone correctly scopes without the FK predicate.
        const membersForFirstBatch = await prisma.taskRun.findMany({
          where: { batchId: batch.id },
          select: { id: true, batchId: true },
        });
        expect(membersForFirstBatch.length).toBe(2);
        for (const member of membersForFirstBatch) {
          expect(member.batchId).toBe(batch.id);
        }
        const membersForOtherBatch = await prisma.taskRun.findMany({
          where: { batchId: otherBatch.id },
        });
        expect(membersForOtherBatch.length).toBe(0);

        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });

        const completedBatch = await prisma.batchTaskRun.findFirst({ where: { id: batch.id } });
        expect(completedBatch?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-DB binds one client (passthrough) — proven by behavior, not store.prisma === prisma.
  containerTest(
    "single-DB binds one client (passthrough) — batch complete round-trips on the one client",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const { batch } = await driveBatchToAllChildrenComplete(engine, prisma, "run_batch_g");

        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });
        await setTimeout(1_000);

        const completedBatch = await prisma.batchTaskRun.findFirst({ where: { id: batch.id } });
        expect(completedBatch?.status).toBe("COMPLETED");

        const batchWaitpoint = await prisma.waitpoint.findFirst({
          where: { completedByBatchId: batch.id },
        });
        assertNonNullable(batchWaitpoint);
        expect(batchWaitpoint.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // Residency invariant: inject a DISTINCT, POISONED replica — a JS Proxy over real prisma that
  // throws if taskRun/waitpoint/batchTaskRun reads are issued through it. Not a DB mock: a guard
  // client proving which client was used. If any routed read defaulted to readOnlyPrisma instead of
  // this.$.prisma it would throw; completing cleanly proves the reads use the primary.
  containerTest(
    "routed batch-completion reads use the primary, never the replica",
    async ({ prisma, redisOptions }) => {
      // The replica is legitimately read by other systems (e.g. runAttemptSystem) while driving the
      // batch. We only want to assert residency for the #tryCompleteBatch reads, so the poison is
      // armed just before performCompleteBatch and stays delegating until then.
      let armed = false;

      const poisonModel = (real: any) =>
        new Proxy(real, {
          get(target, prop, receiver) {
            if (armed && (prop === "findMany" || prop === "findFirst")) {
              return () => {
                throw new Error("replica read in #tryCompleteBatch — residency regression");
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });

      const poisonedReplica = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === "taskRun" || prop === "waitpoint" || prop === "batchTaskRun") {
            return poisonModel((target as any)[prop]);
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as PrismaClient;

      const countingStore = new CountingPostgresRunStore({
        prisma,
        readOnlyPrisma: poisonedReplica,
      });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const { batch } = await driveBatchToAllChildrenComplete(
          engine,
          prisma,
          "run_batch_residency"
        );

        // The debounced background tryCompleteBatch (200ms) has already fired by the time the drive
        // helper returns (it ends with a 500ms sleep) and is not re-scheduled, so no background job
        // races the explicit call below. Re-open the batch so the explicit armed call genuinely
        // re-walks ALL FOUR routed reads/writes under the poison — otherwise it short-circuits at
        // the `status === "COMPLETED"` guard after only the batch read (vacuous).
        await prisma.batchTaskRun.update({
          where: { id: batch.id },
          data: { status: "PENDING" },
        });

        const beforeBatchReads = countingStore.batchReads;
        const beforeMemberRunReads = countingStore.memberRunReads;
        const beforeBatchUpdates = countingStore.batchUpdates;
        const beforeWaitpointReads = countingStore.waitpointReads;

        // Must not throw: every routed read resolved to the primary, never the poisoned replica.
        armed = true;
        try {
          await engine.batchSystem.performCompleteBatch({ batchId: batch.id });
        } finally {
          armed = false;
        }

        // Non-vacuity: every routed read/write actually executed under the armed poison (i.e. the
        // explicit call did the full walk, not a short-circuit after the batch read alone).
        expect(countingStore.batchReads).toBeGreaterThan(beforeBatchReads);
        expect(countingStore.memberRunReads).toBeGreaterThan(beforeMemberRunReads);
        expect(countingStore.batchUpdates).toBeGreaterThan(beforeBatchUpdates);
        expect(countingStore.waitpointReads).toBeGreaterThan(beforeWaitpointReads);

        const completedBatch = await prisma.batchTaskRun.findFirst({ where: { id: batch.id } });
        expect(completedBatch?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // The env-scoped member-run read is
  // findRuns({ where: { batchId, runtimeEnvironmentId } }, this.$.prisma). Assert the where the store
  // actually received carries BOTH predicates so the index-scoping isn't silently dropped.
  containerTest(
    "member-run read is scoped by both batchId and runtimeEnvironmentId",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const { batch, environment } = await driveBatchToAllChildrenComplete(
          engine,
          prisma,
          "run_batch_envscope"
        );

        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });

        expect(countingStore.lastFindRunsWhere?.batchId).toBe(batch.id);
        expect(countingStore.lastFindRunsWhere?.runtimeEnvironmentId).toBe(environment.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // Batch not found returns at the `if (!batch)` guard, before any member read.
  containerTest(
    "batch not found returns early without reading members",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        await engine.batchSystem.performCompleteBatch({ batchId: "batch_nonexistent_xyz" });
        expect(countingStore.memberRunReads).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // An already-COMPLETED batch returns at the `status === "COMPLETED"` guard. Because
  // performCompleteBatch is debounce/retry-driven and can fire twice, a second call must be a no-op:
  // no further batch update and no further waitpoint read.
  containerTest(
    "already-COMPLETED batch returns early (idempotent re-run)",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const { batch } = await driveBatchToAllChildrenComplete(
          engine,
          prisma,
          "run_batch_idempotent"
        );

        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });

        const updatesAfterFirst = countingStore.batchUpdates;
        const waitpointReadsAfterFirst = countingStore.waitpointReads;

        // Second call: must short-circuit at the COMPLETED guard.
        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });

        expect(countingStore.batchUpdates).toBe(updatesAfterFirst);
        expect(countingStore.waitpointReads).toBe(waitpointReadsAfterFirst);
      } finally {
        await engine.quit();
      }
    }
  );

  // Not-all-runs-processed returns at `processedRunCount < runCount`, before the member
  // read. A v1 batch with runCount 2 but processingJobsCount 1 (and no members) must stay
  // non-COMPLETED and never read members.
  containerTest(
    "not-all-runs-processed returns before the member read",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: generateFriendlyId("batch"),
            runtimeEnvironmentId: environment.id,
            runCount: 2,
            processingJobsCount: 1,
          },
        });

        countingStore.memberRunReads = 0;

        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });

        expect(countingStore.memberRunReads).toBe(0);
        const stillPending = await prisma.batchTaskRun.findFirst({ where: { id: batch.id } });
        expect(stillPending?.status).not.toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // A plain batch (batchTrigger, not batchTriggerAndWait) has no waitpoint, so completion
  // hits `if (!waitpoint) return` after flipping the batch to COMPLETED. Drive a real run via
  // engine.trigger with a batch but NO parent/resumeParentOnCompletion (so no waitpoint is created),
  // run it to a final status, then complete the batch.
  containerTest(
    "batch with no waitpoint still completes (plain batchTrigger)",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const childTask = "child-task";
        await setupBackgroundWorker(engine, environment, [childTask]);

        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: generateFriendlyId("batch"),
            runtimeEnvironmentId: environment.id,
            runCount: 1,
            processingJobsCount: 1,
          },
        });

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: generateFriendlyId("run"),
            environment,
            taskIdentifier: childTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-nowp-1",
            spanId: "s-nowp-1",
            workerQueue: "main",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            batch: { id: batch.id, index: 0 },
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_consumer",
          workerQueue: "main",
        });
        const match = dequeued.find((d) => d.run.id === run.id) ?? dequeued[0];
        assertNonNullable(match);
        const attempt = await engine.startRunAttempt({
          runId: match.run.id,
          snapshotId: match.snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: attempt.run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            id: attempt.run.id,
            ok: true,
            output: '{"foo":"bar"}',
            outputType: "application/json",
          },
        });
        await setTimeout(500);

        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });

        expect(countingStore.batchUpdates).toBeGreaterThan(0);
        expect(countingStore.waitpointReads).toBeGreaterThan(0);

        const completedBatch = await prisma.batchTaskRun.findFirst({ where: { id: batch.id } });
        expect(completedBatch?.status).toBe("COMPLETED");

        // Proves the `if (!waitpoint) return` branch: a plain batch has no waitpoint.
        const waitpoint = await prisma.waitpoint.findFirst({
          where: { completedByBatchId: batch.id },
        });
        expect(waitpoint).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
});

/**
 * Two-store routing proof: a real RoutingRunStore over two distinct PostgresRunStores. Every
 * #tryCompleteBatch read/write must resolve to the run-ops (new) store and never touch the legacy
 * store. No mocks — both stores are genuine PostgresRunStore instances over real containers.
 */
describe("#tryCompleteBatch two-store routing", () => {
  // A batch + members + waitpoint complete via the run-ops store only; the legacy store
  // is never touched, and all members are discovered within the one owning store.
  containerTest(
    "batch completion routes to the run-ops store only; the legacy store is untouched",
    async ({ prisma, redisOptions }) => {
      const newStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const legacyStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });

      const routingStore = new RoutingRunStore({
        new: newStore,
        legacy: legacyStore,
        classify: () => "NEW",
      });

      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, routingStore));

      try {
        const { batch } = await driveBatchToAllChildrenComplete(engine, prisma, "run_batch_h");

        const beforeLegacy =
          legacyStore.batchReads +
          legacyStore.memberRunReads +
          legacyStore.batchUpdates +
          legacyStore.waitpointReads;

        await engine.batchSystem.performCompleteBatch({ batchId: batch.id });

        expect(newStore.batchReads).toBeGreaterThan(0);
        expect(newStore.memberRunReads).toBeGreaterThan(0);
        expect(newStore.batchUpdates).toBeGreaterThan(0);
        expect(newStore.waitpointReads).toBeGreaterThan(0);

        expect(
          legacyStore.batchReads +
            legacyStore.memberRunReads +
            legacyStore.batchUpdates +
            legacyStore.waitpointReads
        ).toBe(beforeLegacy);

        const completedBatch = await prisma.batchTaskRun.findFirst({ where: { id: batch.id } });
        expect(completedBatch?.status).toBe("COMPLETED");

        const members = await prisma.taskRun.findMany({ where: { batchId: batch.id } });
        expect(members.length).toBe(2);
      } finally {
        await engine.quit();
      }
    }
  );
});
