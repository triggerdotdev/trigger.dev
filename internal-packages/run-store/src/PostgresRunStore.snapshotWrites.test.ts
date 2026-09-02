// snapshotWrites: false is the redis-only dial position. Every run mutation still lands; no snapshot
// row is written and no completed-waitpoint join row is inserted. The default stays true, so nothing
// changes for any existing caller.
import { describe, expect } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  seedSnapshotWaitpoints,
  seedSnapshotWorker,
  setupSnapshotIdFixture,
} from "./testFixtures/snapshotIdFixture.js";

describe("PostgresRunStore snapshotWrites flag", () => {
  postgresTest("defaults to writing snapshots", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);

    await store.completeAttemptSuccess(
      run.id,
      {
        completedAt: new Date(),
        outputType: "application/json",
        usageDurationMs: 1,
        costInCents: 0,
        snapshot: {
          executionStatus: "FINISHED",
          description: "Run completed",
          runStatus: "COMPLETED_SUCCESSFULLY",
          attemptNumber: 1,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      },
      { select: { id: true } }
    );

    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(1);
  });

  postgresTest("writes the run mutation but no snapshot when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma);

    await store.completeAttemptSuccess(
      run.id,
      {
        completedAt: new Date(),
        outputType: "application/json",
        usageDurationMs: 1,
        costInCents: 0,
        snapshot: {
          executionStatus: "FINISHED",
          description: "Run completed",
          runStatus: "COMPLETED_SUCCESSFULLY",
          attemptNumber: 1,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      },
      { select: { id: true } }
    );

    const updated = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("COMPLETED_SUCCESSFULLY");
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  postgresTest("createRun writes the run but no snapshot when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const env = await seedSnapshotEnvironment(prisma);
    const runId = generateInternalId();

    await store.createRun({
      data: buildCreateRunData(runId, env),
      snapshot: {
        id: generateInternalId(),
        engine: "V2",
        executionStatus: "RUN_CREATED",
        description: "Run was created",
        runStatus: "PENDING",
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      },
    });

    expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
  });

  postgresTest("createCancelledRun writes the run but no snapshot when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const env = await seedSnapshotEnvironment(prisma);
    const runId = generateInternalId();

    await store.createCancelledRun({
      data: {
        ...buildCreateRunData(runId, env),
        status: "CANCELED",
        error: { type: "STRING_ERROR", raw: "cancelled" },
        completedAt: new Date(),
        updatedAt: new Date(),
        attemptNumber: 0,
      },
      snapshot: {
        id: generateInternalId(),
        engine: "V2",
        executionStatus: "FINISHED",
        description: "Run was cancelled",
        runStatus: "CANCELED",
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      },
    });

    expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
  });

  postgresTest("expireRun writes the run but no snapshot when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma);

    await store.expireRun(
      run.id,
      {
        error: { type: "STRING_ERROR", raw: "expired" },
        completedAt: new Date(),
        expiredAt: new Date(),
        snapshot: {
          engine: "V2",
          executionStatus: "FINISHED",
          description: "Run expired",
          runStatus: "EXPIRED",
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      },
      { select: { id: true } }
    );

    expect((await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).status).toBe(
      "EXPIRED"
    );
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  postgresTest("expireParkedRun writes the run but no snapshot when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma, { status: "PENDING_VERSION" });

    const result = await store.expireParkedRun(run.id, {
      error: { type: "STRING_ERROR", raw: "expired" },
      completedAt: new Date(),
      expiredAt: new Date(),
      statusReason: "VERSION_NEVER_ARRIVED",
      snapshot: {
        engine: "V2",
        executionStatus: "FINISHED",
        description: "Parked run expired",
        runStatus: "EXPIRED",
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      },
    });

    expect(result.count).toBe(1);
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  postgresTest("rescheduleRun writes the run but no snapshot when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma, { status: "DELAYED" });
    const delayUntil = new Date(Date.now() + 60_000);

    await store.rescheduleRun(run.id, {
      delayUntil,
      snapshot: {
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      },
    });

    const updated = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
    expect(updated.delayUntil?.toISOString()).toBe(delayUntil.toISOString());
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  postgresTest("lockRunToWorker writes the lock but no snapshot when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const { workerId, taskId } = await seedSnapshotWorker(prisma, env);

    await store.lockRunToWorker(run.id, {
      lockedAt: new Date(),
      lockedById: taskId,
      lockedToVersionId: workerId,
      lockedQueueId: undefined,
      startedAt: new Date(),
      baseCostInCents: 0,
      machinePreset: "small-1x",
      taskVersion: "1.0.0",
      snapshot: {
        id: generateInternalId(),
        previousSnapshotId: generateInternalId(),
        attemptNumber: 1,
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
        completedWaitpointIds: [],
        completedWaitpointOrder: [],
      },
    });

    expect((await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).status).toBe(
      "DEQUEUED"
    );
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  postgresTest("createExecutionSnapshot echoes the input when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();

    const echoed = await store.createExecutionSnapshot({
      id,
      run: { id: run.id, status: "EXECUTING", attemptNumber: 2 },
      snapshot: { executionStatus: "EXECUTING", description: "Run started" },
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    });

    expect(echoed.id).toBe(id);
    expect(echoed.runId).toBe(run.id);
    expect(echoed.executionStatus).toBe("EXECUTING");
    expect(echoed.attemptNumber).toBe(2);
    expect(echoed.isValid).toBe(true);
    expect(echoed.checkpoint).toBeNull();
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
  });

  postgresTest("the echoed row rewrites a DEQUEUED run status", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma);

    const echoed = await store.createExecutionSnapshot({
      id: generateInternalId(),
      run: { id: run.id, status: "DEQUEUED", attemptNumber: 1 },
      snapshot: { executionStatus: "PENDING_EXECUTING", description: "Run was dequeued" },
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    });

    expect(echoed.runStatus).toBe("PENDING");
  });

  postgresTest("the echoed row reports an errored snapshot as invalid", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma);

    const echoed = await store.createExecutionSnapshot({
      id: generateInternalId(),
      run: { id: run.id, status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "Stale write" },
      error: "snapshot is not the latest",
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    });

    expect(echoed.isValid).toBe(false);
    expect(echoed.error).toBe("snapshot is not the latest");
  });

  postgresTest("createExecutionSnapshot needs an id when off", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
    const { run, env } = await setupSnapshotIdFixture(prisma);

    await expect(
      store.createExecutionSnapshot({
        run: { id: run.id, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "Run started" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      })
    ).rejects.toThrow(/snapshotWrites is off/);
  });

  postgresTest(
    "a per-org predicate suppresses the snapshot only for the redis-only org",
    async ({ prisma }) => {
      const ro = await setupSnapshotIdFixture(prisma);
      const keep = await setupSnapshotIdFixture(prisma);
      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
        snapshotWrites: (org) => org !== ro.env.organizationId,
      });

      for (const fx of [ro, keep]) {
        await store.completeAttemptSuccess(
          fx.run.id,
          {
            completedAt: new Date(),
            outputType: "application/json",
            usageDurationMs: 1,
            costInCents: 0,
            snapshot: {
              executionStatus: "FINISHED",
              description: "Run completed",
              runStatus: "COMPLETED_SUCCESSFULLY",
              attemptNumber: 1,
              environmentId: fx.env.id,
              environmentType: fx.env.type,
              projectId: fx.env.projectId,
              organizationId: fx.env.organizationId,
            },
          },
          { select: { id: true } }
        );
      }

      expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: ro.run.id } })).toBe(0);
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: keep.run.id } })).toBe(
        1
      );
    }
  );

  postgresTest(
    "a per-org predicate suppresses the completed-waitpoint join rows for the redis-only org",
    async ({ prisma }) => {
      const ro = await setupSnapshotIdFixture(prisma);
      const keep = await setupSnapshotIdFixture(prisma);
      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
        snapshotWrites: (org) => org !== ro.env.organizationId,
      });

      for (const fx of [ro, keep]) {
        const { workerId, taskId } = await seedSnapshotWorker(prisma, fx.env);
        const waitpointIds = await seedSnapshotWaitpoints(prisma, fx.env, 2);
        const snapshotId = generateInternalId();
        await store.lockRunToWorker(fx.run.id, {
          lockedAt: new Date(),
          lockedById: taskId,
          lockedToVersionId: workerId,
          lockedQueueId: undefined,
          startedAt: new Date(),
          baseCostInCents: 0,
          machinePreset: "small-1x",
          taskVersion: "1.0.0",
          snapshot: {
            id: snapshotId,
            previousSnapshotId: generateInternalId(),
            attemptNumber: 1,
            environmentId: fx.env.id,
            environmentType: fx.env.type,
            projectId: fx.env.projectId,
            organizationId: fx.env.organizationId,
            completedWaitpointIds: waitpointIds,
            completedWaitpointOrder: waitpointIds,
          },
        });
      }

      // The redis-only org has no snapshot row, so no join rows link to it either.
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: ro.run.id } })).toBe(0);

      const keepSnapshot = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({
        where: { runId: keep.run.id },
        include: { completedWaitpoints: true },
      });
      expect(keepSnapshot.completedWaitpoints).toHaveLength(2);
    }
  );
});
