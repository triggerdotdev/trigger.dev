import { assertNonNullable, containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { trace } from "@internal/tracing";
import { CheckpointId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { getLatestExecutionSnapshot } from "../systems/executionSnapshotSystem.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngineOptions(redisOptions: any, prisma: any, store?: PostgresRunStore) {
  return {
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
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

/**
 * A real PostgresRunStore subclass that counts the checkpoint + snapshot write methods this unit
 * routes through, so the routing can be observed over real containers without ever mocking prisma.
 * super.* runs the genuine store implementation.
 */
class CountingPostgresRunStore extends PostgresRunStore {
  public checkpointCreates = 0;
  public snapshotCreates = 0;
  public latestReads = 0;

  override async createTaskRunCheckpoint<T extends Prisma.TaskRunCheckpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunCheckpointCreateArgs>,
    tx?: any
  ): Promise<Prisma.TaskRunCheckpointGetPayload<T>> {
    this.checkpointCreates++;
    return super.createTaskRunCheckpoint(args, tx);
  }

  override async createExecutionSnapshot(
    input: any,
    tx?: any
  ): ReturnType<PostgresRunStore["createExecutionSnapshot"]> {
    this.snapshotCreates++;
    return super.createExecutionSnapshot(input, tx);
  }

  override async findLatestExecutionSnapshot(
    runId: string,
    client?: any
  ): ReturnType<PostgresRunStore["findLatestExecutionSnapshot"]> {
    this.latestReads++;
    return super.findLatestExecutionSnapshot(runId, client);
  }
}

/**
 * Drives a freshly triggered run to a checkpointable (EXECUTING_WITH_WAITPOINTS) state, returning
 * the run + the blocking snapshot id + the waitpoint id. Mirrors the existing checkpoints.test.ts
 * "Create checkpoint and continue execution" preamble.
 */
async function driveToCheckpointable(engine: RunEngine, prisma: PrismaClient, friendlyId: string) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const taskIdentifier = "test-task";
  await setupBackgroundWorker(engine, environment, taskIdentifier);

  const run = await engine.trigger(
    {
      number: 1,
      friendlyId,
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );

  await setTimeout(500);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  expect(dequeued.length).toBe(1);
  assertNonNullable(dequeued[0]);

  await engine.startRunAttempt({
    runId: dequeued[0].run.id,
    snapshotId: dequeued[0].snapshot.id,
  });

  const waitpointResult = await engine.createManualWaitpoint({
    environmentId: environment.id,
    projectId: environment.projectId,
  });

  const blockedResult = await engine.blockRunWithWaitpoint({
    runId: run.id,
    waitpoints: waitpointResult.waitpoint.id,
    projectId: environment.projectId,
    organizationId: environment.organizationId,
  });

  return {
    environment,
    run,
    blockingSnapshotId: blockedResult.id,
    waitpointId: waitpointResult.waitpoint.id,
  };
}

describe("CheckpointSystem store routing (single-DB passthrough)", () => {
  // createCheckpoint routes the TaskRunCheckpoint write + the SUSPENDED snapshot write
  // through the store, both resolved by owning run id.
  containerTest(
    "checkpoint create routes the TaskRunCheckpoint write + SUSPENDED snapshot through the store",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const { run, blockingSnapshotId } = await driveToCheckpointable(
          engine,
          prisma,
          "run_cpcreate1"
        );

        const checkpointsBefore = countingStore.checkpointCreates;
        const snapshotsBefore = countingStore.snapshotCreates;

        const checkpointResult = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: blockingSnapshotId,
          checkpoint: {
            type: "DOCKER",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });

        expect(checkpointResult.ok).toBe(true);

        // (1) a TaskRunCheckpoint row exists for the run (joined via the SUSPENDED snapshot).
        const persistedCheckpoint = await prisma.taskRunCheckpoint.findFirst({
          where: { executionSnapshot: { some: { runId: run.id } } },
        });
        expect(persistedCheckpoint).not.toBeNull();
        expect(persistedCheckpoint?.type).toBe("DOCKER");
        expect(persistedCheckpoint?.reason).toBe("TEST_CHECKPOINT");

        // (2) the latest snapshot is SUSPENDED with checkpointId set to that row.
        const latest = await prisma.taskRunExecutionSnapshot.findFirst({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "desc" },
        });
        expect(latest?.executionStatus).toBe("SUSPENDED");
        expect(latest?.checkpointId).toBe(persistedCheckpoint!.id);

        // (3) the checkpoint create + the snapshot create went through the store.
        expect(countingStore.checkpointCreates).toBeGreaterThan(checkpointsBefore);
        expect(countingStore.snapshotCreates).toBeGreaterThan(snapshotsBefore);
      } finally {
        await engine.quit();
      }
    }
  );

  // A full checkpoint create + restore round-trip through continueRunExecution; the latest
  // snapshot becomes EXECUTING and the read through the store returns it.
  containerTest(
    "restore round-trip via continueRunExecution reads + writes through the store",
    async ({ prisma, redisOptions }) => {
      const countingStore = new CountingPostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma, countingStore));

      try {
        const { run, blockingSnapshotId, waitpointId } = await driveToCheckpointable(
          engine,
          prisma,
          "run_cprestore1"
        );

        // Suspend (create checkpoint).
        const checkpointResult = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: blockingSnapshotId,
          checkpoint: {
            type: "DOCKER",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });
        expect(checkpointResult.ok).toBe(true);

        // Unblock + re-dequeue to reach a QUEUED_WITH_CHECKPOINT/pending-executing state.
        await engine.completeWaitpoint({ id: waitpointId });
        await setTimeout(500);

        const dequeuedAgain = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeuedAgain.length).toBe(1);
        assertNonNullable(dequeuedAgain[0]);

        const continueResult = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: dequeuedAgain[0].snapshot.id,
        });

        // The latest snapshot becomes EXECUTING.
        expect(continueResult.snapshot.executionStatus).toBe("EXECUTING");
        expect(continueResult.run.status).toBe("EXECUTING");

        // The store read returns exactly that EXECUTING snapshot, routed by run id.
        const latest = await getLatestExecutionSnapshot(prisma, run.id, countingStore);
        expect(latest.runId).toBe(run.id);
        expect(latest.executionStatus).toBe("EXECUTING");
        expect(latest.id).toBe(continueResult.snapshot.id);
        // friendlyId is a valid SnapshotId derived from the cuid (route by owning run id).
        expect(latest.friendlyId).toMatch(/^snapshot_/);
        expect(SnapshotId.fromFriendlyId(latest.friendlyId)).toBe(latest.id);
        expect(countingStore.latestReads).toBeGreaterThan(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // Single-DB binds one client (passthrough) — proven by behavior, not by reaching into a
  // private prisma member. The default-store engine round-trips create+restore on the one client.
  containerTest(
    "single-DB binds one client (passthrough) — create + restore round-trip on one client",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const { run, blockingSnapshotId, waitpointId } = await driveToCheckpointable(
          engine,
          prisma,
          "run_cppassthru"
        );

        const checkpointResult = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: blockingSnapshotId,
          checkpoint: {
            type: "DOCKER",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });
        expect(checkpointResult.ok).toBe(true);

        // The SUSPENDED snapshot just written is exactly what the store reads back on one client.
        const suspended = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        const persistedSuspended = await prisma.taskRunExecutionSnapshot.findFirst({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "desc" },
        });
        expect(suspended.executionStatus).toBe("SUSPENDED");
        expect(suspended.id).toBe(persistedSuspended!.id);

        await engine.completeWaitpoint({ id: waitpointId });
        await setTimeout(500);

        const dequeuedAgain = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        assertNonNullable(dequeuedAgain[0]);

        const continueResult = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: dequeuedAgain[0].snapshot.id,
        });
        expect(continueResult.snapshot.executionStatus).toBe("EXECUTING");

        // The EXECUTING snapshot read resolves on the same single client to exactly the row written.
        const executing = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        expect(executing.id).toBe(continueResult.snapshot.id);
        expect(executing.runId).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );
});

// --- Checkpoint-family FK-drop app-integrity (Tests D/E): FK retained (self-host) + FK dropped (cloud) ---

const CHECKPOINT_FAMILY_CROSS_SEAM_FKS = [
  ["TaskRunCheckpoint", "TaskRunCheckpoint_projectId_fkey"],
  ["TaskRunCheckpoint", "TaskRunCheckpoint_runtimeEnvironmentId_fkey"],
  ["Checkpoint", "Checkpoint_projectId_fkey"],
  ["Checkpoint", "Checkpoint_runtimeEnvironmentId_fkey"],
  ["CheckpointRestoreEvent", "CheckpointRestoreEvent_projectId_fkey"],
  ["CheckpointRestoreEvent", "CheckpointRestoreEvent_runtimeEnvironmentId_fkey"],
] as const;

/** Model the cloud-only physical drop of the checkpoint-family cross-seam Cascade FKs. */
async function dropCheckpointFamilyCrossSeamFks(prisma: PrismaClient) {
  for (const [table, constraint] of CHECKPOINT_FAMILY_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`
    );
  }
}

async function seedEnvironment(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

describe("CheckpointSystem checkpoint-family FK-drop app-integrity (both modes)", () => {
  // createTaskRunCheckpoint succeeds with the cross-seam FK retained (self-host) and
  // dropped (cloud). The fixture must provision BOTH versions (no silent single-DB no-op).
  heteroPostgresTest(
    "checkpoint create succeeds with the cross-seam FK retained (self-host) and dropped (cloud)",
    async ({ prisma14, prisma17, pinnedCollation }) => {
      // Assert the hetero fixture actually provisioned both clients on the pinned collation — a
      // hetero test that silently no-ops on a single DB would be a false green.
      expect(pinnedCollation).toBe("und-x-icu");
      const v14 = (
        await prisma14.$queryRawUnsafe<{ server_version: string }[]>(`SHOW server_version`)
      )[0]!.server_version;
      const v17 = (
        await prisma17.$queryRawUnsafe<{ server_version: string }[]>(`SHOW server_version`)
      )[0]!.server_version;
      expect(parseInt(v14, 10)).toBe(14);
      expect(parseInt(v17, 10)).toBe(17);

      // Cloud shape: drop the checkpoint-family cross-seam Cascade FKs on the cloud DB only.
      await dropCheckpointFamilyCrossSeamFks(prisma17 as unknown as PrismaClient);

      const store14 = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const store17 = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      // Self-host shape (FK retained): insert against present env/project rows succeeds.
      const env14 = await seedEnvironment(prisma14 as unknown as PrismaClient, "fkd_14");
      const cp14 = await store14.createTaskRunCheckpoint({
        data: {
          ...CheckpointId.generate(),
          type: "DOCKER",
          location: "loc-14",
          reason: "TEST",
          runtimeEnvironmentId: env14.environment.id,
          projectId: env14.project.id,
        },
      });
      const persisted14 = await prisma14.taskRunCheckpoint.findUnique({ where: { id: cp14.id } });
      expect(persisted14).not.toBeNull();

      // Cloud shape (FK dropped): insert succeeds with present env/project rows...
      const env17 = await seedEnvironment(prisma17 as unknown as PrismaClient, "fkd_17");
      const cp17 = await store17.createTaskRunCheckpoint({
        data: {
          ...CheckpointId.generate(),
          type: "DOCKER",
          location: "loc-17",
          reason: "TEST",
          runtimeEnvironmentId: env17.environment.id,
          projectId: env17.project.id,
        },
      });
      const persisted17 = await prisma17.taskRunCheckpoint.findUnique({ where: { id: cp17.id } });
      expect(persisted17).not.toBeNull();

      // ...and, because the constraint is gone on the cloud shape, also succeeds with no
      // control-plane row required at insert (the defining property of the dropped FK).
      const orphanId = CheckpointId.generate();
      const orphan = await store17.createTaskRunCheckpoint({
        data: {
          ...orphanId,
          type: "DOCKER",
          location: "loc-17-orphan",
          reason: "TEST",
          runtimeEnvironmentId: "env_does_not_exist",
          projectId: "proj_does_not_exist",
        },
      });
      const persistedOrphan = await prisma17.taskRunCheckpoint.findUnique({
        where: { id: orphan.id },
      });
      expect(persistedOrphan).not.toBeNull();
    }
  );

  // Env-delete parity on this unit's write surface (TaskRunCheckpoint, the only
  // checkpoint-family row the V2 engine creates — Checkpoint/CheckpointRestoreEvent are V1-residual
  // and require a full run+attempt graph, out of this unit's write scope). After deleting the owning
  // env, the TaskRunCheckpoint count is deep-equal across the self-host shape (the retained Cascade
  // FK fires) and the cloud shape (the app-level deleteMany-by-env cleanup contract fires). The webapp cleanup service
  // is not importable from a run-engine test, so we exercise the same deleteMany-by-env contract
  // over the real two clients (no mocks).
  heteroPostgresTest(
    "env-delete leaves no TaskRunCheckpoint orphan on the FK-dropped DB (parity with FK-retained)",
    async ({ prisma14, prisma17 }) => {
      await dropCheckpointFamilyCrossSeamFks(prisma17 as unknown as PrismaClient);

      async function seedCheckpoint(prisma: PrismaClient, suffix: string) {
        const { environment, project } = await seedEnvironment(prisma, suffix);
        const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        await store.createTaskRunCheckpoint({
          data: {
            ...CheckpointId.generate(),
            type: "DOCKER",
            location: "loc",
            reason: "TEST",
            runtimeEnvironmentId: environment.id,
            projectId: project.id,
          },
        });
        return { environment, project };
      }

      const seed14 = await seedCheckpoint(prisma14 as unknown as PrismaClient, "edel_14");
      const seed17 = await seedCheckpoint(prisma17 as unknown as PrismaClient, "edel_17");

      // Self-host shape: deleting the env fires the retained Cascade FK.
      await prisma14.runtimeEnvironment.delete({ where: { id: seed14.environment.id } });

      // Cloud shape: the FK is gone, so the app-level cleanup contract (delete checkpoint by env,
      // before deleting the env) must run.
      const envId17 = seed17.environment.id;
      await prisma17.taskRunCheckpoint.deleteMany({ where: { runtimeEnvironmentId: envId17 } });
      await prisma17.runtimeEnvironment.delete({ where: { id: envId17 } });

      const count14 = await prisma14.taskRunCheckpoint.count();
      const count17 = await prisma17.taskRunCheckpoint.count();

      // Parity: no orphan TaskRunCheckpoint left on either DB after the owning env is deleted.
      expect(count17).toEqual(count14);
      expect(count14).toBe(0);
    }
  );
});
