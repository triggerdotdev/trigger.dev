// The entry is built from a write site's input while Postgres builds the row from the same input by
// a different code path. This suite is the only thing that keeps those two paths equal, so it covers
// every one of the ten physical snapshot-create sites in PostgresRunStore.
import { describe, expect } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { SnapshotEntryInput } from "./redisSnapshotStore.js";
import {
  entryFromCompletion,
  entryFromCreateExecutionSnapshot,
  entryFromCreateRun,
  entryFromExpire,
  entryFromLock,
  entryFromReschedule,
} from "./snapshotEntry.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  seedSnapshotWorker,
  setupSnapshotIdFixture,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

/**
 * Compares only what the entry claims. The Redis model carries no `updatedAt` and no join rows, and
 * it holds `createdAt` as an ISO string, so those are checked separately or not at all.
 */
function assertParity(entry: SnapshotEntryInput, row: Record<string, unknown>) {
  expect(row.id).toBe(entry.id);
  expect(row.runId).toBe(entry.runId);
  expect(row.engine).toBe(entry.engine);
  expect(row.executionStatus).toBe(entry.executionStatus);
  expect(row.description).toBe(entry.description);
  expect(row.runStatus).toBe(entry.runStatus);
  expect(row.environmentId).toBe(entry.environmentId);
  expect(row.environmentType).toBe(entry.environmentType);
  expect(row.projectId).toBe(entry.projectId);
  expect(row.organizationId).toBe(entry.organizationId);
  expect(row.attemptNumber ?? undefined).toBe(entry.attemptNumber ?? undefined);
  expect(row.previousSnapshotId ?? undefined).toBe(entry.previousSnapshotId ?? undefined);
  expect(row.batchId ?? undefined).toBe(entry.batchId ?? undefined);
  expect(row.checkpointId ?? undefined).toBe(entry.checkpointId ?? undefined);
  expect(row.workerId ?? undefined).toBe(entry.workerId ?? undefined);
  expect(row.runnerId ?? undefined).toBe(entry.runnerId ?? undefined);
  expect(row.isValid).toBe(entry.error === undefined);
  expect((row.createdAt as Date).toISOString()).toBe(entry.createdAt);
}

function birthSnapshot(id: string, env: SnapshotFixtureEnv) {
  return {
    id,
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("entry to Postgres row parity", () => {
  postgresTest("createRun, legacy schema", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const env = await seedSnapshotEnvironment(prisma);
    const runId = generateInternalId();
    const id = generateInternalId();
    const snapshot = birthSnapshot(id, env);

    await store.createRun({ data: buildCreateRunData(runId, env), snapshot });

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromCreateRun({ id, runId, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("createRun with an associated waitpoint, legacy schema", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const env = await seedSnapshotEnvironment(prisma);
    const runId = generateInternalId();
    const id = generateInternalId();
    const snapshot = birthSnapshot(id, env);

    await store.createRun({
      data: buildCreateRunData(runId, env),
      snapshot,
      associatedWaitpoint: {
        id: generateInternalId(),
        friendlyId: `waitpoint_${runId.slice(-12)}`,
        type: "RUN",
        status: "PENDING",
        idempotencyKey: generateInternalId(),
        userProvidedIdempotencyKey: false,
        projectId: env.projectId,
        environmentId: env.id,
      },
    });

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromCreateRun({ id, runId, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("createRun carries the worker and runner ids", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const env = await seedSnapshotEnvironment(prisma);
    const { workerId } = await seedSnapshotWorker(prisma, env);
    const runId = generateInternalId();
    const id = generateInternalId();
    const snapshot = { ...birthSnapshot(id, env), workerId, runnerId: "runner_1" };

    await store.createRun({ data: buildCreateRunData(runId, env), snapshot });

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromCreateRun({ id, runId, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("createCancelledRun", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const env = await seedSnapshotEnvironment(prisma);
    const runId = generateInternalId();
    const id = generateInternalId();
    const snapshot = {
      ...birthSnapshot(id, env),
      executionStatus: "FINISHED" as const,
      description: "Run was cancelled",
      runStatus: "CANCELED" as const,
    };

    await store.createCancelledRun({
      data: {
        ...buildCreateRunData(runId, env),
        status: "CANCELED",
        error: { type: "STRING_ERROR", raw: "cancelled" },
        completedAt: new Date(),
        updatedAt: new Date(),
        attemptNumber: 0,
      },
      snapshot,
    });

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromCreateRun({ id, runId, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("completeAttemptSuccess", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();
    const snapshot = {
      id,
      executionStatus: "FINISHED" as const,
      description: "Run completed",
      runStatus: "COMPLETED_SUCCESSFULLY" as const,
      attemptNumber: 1,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    };

    await store.completeAttemptSuccess(
      run.id,
      {
        completedAt: new Date(),
        outputType: "application/json",
        usageDurationMs: 1,
        costInCents: 0,
        snapshot,
      },
      { select: { id: true } }
    );

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromCompletion({ id, runId: run.id, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("expireRun", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();
    const snapshot = {
      id,
      engine: "V2" as const,
      executionStatus: "FINISHED" as const,
      description: "Run expired",
      runStatus: "EXPIRED" as const,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    };

    await store.expireRun(
      run.id,
      {
        error: { type: "STRING_ERROR", raw: "expired" },
        completedAt: new Date(),
        expiredAt: new Date(),
        snapshot,
      },
      { select: { id: true } }
    );

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromExpire({ id, runId: run.id, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("expireParkedRun", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma, { status: "PENDING_VERSION" });
    const id = generateInternalId();
    const snapshot = {
      id,
      engine: "V2" as const,
      executionStatus: "FINISHED" as const,
      description: "Parked run expired",
      runStatus: "EXPIRED" as const,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    };

    const result = await store.expireParkedRun(run.id, {
      error: { type: "STRING_ERROR", raw: "expired" },
      completedAt: new Date(),
      expiredAt: new Date(),
      statusReason: "VERSION_NEVER_ARRIVED",
      snapshot,
    });

    expect(result.count).toBe(1);
    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromExpire({ id, runId: run.id, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("rescheduleRun with every default applied", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma, { status: "DELAYED" });
    const id = generateInternalId();
    const snapshot = {
      id,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    };

    await store.rescheduleRun(run.id, {
      delayUntil: new Date(Date.now() + 60_000),
      snapshot,
    });

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromReschedule({ id, runId: run.id, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("rescheduleRun with every value supplied", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma, { status: "DELAYED" });
    const id = generateInternalId();
    const snapshot = {
      id,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
      executionStatus: "QUEUED" as const,
      runStatus: "PENDING" as const,
      description: "custom reschedule",
    };

    await store.rescheduleRun(run.id, {
      delayUntil: new Date(Date.now() + 60_000),
      snapshot,
    });

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromReschedule({ id, runId: run.id, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("lockRunToWorker", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const { workerId, taskId } = await seedSnapshotWorker(prisma, env);
    const previous = await store.createExecutionSnapshot({
      run: { id: run.id, status: "PENDING", attemptNumber: null },
      snapshot: { executionStatus: "QUEUED", description: "Run was queued" },
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    });

    const id = generateInternalId();
    const snapshot = {
      id,
      previousSnapshotId: previous.id,
      attemptNumber: 1,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
      completedWaitpointIds: [],
      completedWaitpointOrder: [],
    };

    await store.lockRunToWorker(run.id, {
      lockedAt: new Date(),
      lockedById: taskId,
      lockedToVersionId: workerId,
      lockedQueueId: undefined,
      startedAt: new Date(),
      baseCostInCents: 0,
      machinePreset: "small-1x",
      taskVersion: "1.0.0",
      snapshot,
    });

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    assertParity(entryFromLock({ id, runId: run.id, createdAt: row.createdAt }, snapshot), row);
  });

  postgresTest("createExecutionSnapshot, the standalone site", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();
    const input = {
      id,
      run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 2 },
      snapshot: { executionStatus: "EXECUTING" as const, description: "Run started" },
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    };

    const created = await store.createExecutionSnapshot(input);

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    expect(created.id).toBe(id);
    assertParity(
      entryFromCreateExecutionSnapshot({ id, runId: run.id, createdAt: row.createdAt }, input),
      row
    );
  });

  postgresTest("createExecutionSnapshot rewrites a DEQUEUED run status", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();
    const input = {
      id,
      run: { id: run.id, status: "DEQUEUED" as const, attemptNumber: 1 },
      snapshot: { executionStatus: "PENDING_EXECUTING" as const, description: "Run was dequeued" },
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    };

    await store.createExecutionSnapshot(input);

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    expect(row.runStatus).toBe("PENDING");
    assertParity(
      entryFromCreateExecutionSnapshot({ id, runId: run.id, createdAt: row.createdAt }, input),
      row
    );
  });

  postgresTest("createExecutionSnapshot with an error is invalid in both", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { run, env } = await setupSnapshotIdFixture(prisma);
    const id = generateInternalId();
    const input = {
      id,
      run: { id: run.id, status: "EXECUTING" as const, attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING" as const, description: "Stale write" },
      error: "snapshot is not the latest",
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    };

    await store.createExecutionSnapshot(input);

    const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { id } });
    expect(row.isValid).toBe(false);
    assertParity(
      entryFromCreateExecutionSnapshot({ id, runId: run.id, createdAt: row.createdAt }, input),
      row
    );
  });
});
