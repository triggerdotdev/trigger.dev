import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateCancelledRunInput, CreateFailedRunInput, CreateRunInput } from "./types.js";

async function seedEnvironment(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: {
      title: "Test Organization",
      slug: "test-organization",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: "test-project",
      externalRef: "proj_1234",
      organizationId: organization.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "tr_dev_apikey",
      pkApiKey: "pk_dev_apikey",
      shortcode: "short_code",
    },
  });

  return { organization, project, environment };
}

function buildCreateRunInput(params: {
  runId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: "run_friendly_1",
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: "trace_1",
      spanId: "span_1",
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

describe("PostgresRunStore", () => {
  postgresTest("createRun creates the run with one snapshot and no waitpoint", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({
      prisma,
      // The read-only client just needs to be a PrismaClient for these tests.
      readOnlyPrisma: prisma,
    });

    const runId = "run_test_1";

    const run = await store.createRun(
      buildCreateRunInput({
        runId,
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
      })
    );

    expect(run.id).toBe(runId);
    expect(run.status).toBe("PENDING");
    expect(run.associatedWaitpoint).toBeNull();

    const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
      where: { runId },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.executionStatus).toBe("RUN_CREATED");
    expect(snapshots[0]?.runStatus).toBe("PENDING");
  });

  postgresTest(
    "createCancelledRun creates a CANCELED run with one FINISHED/CANCELED execution snapshot",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
      });

      const runId = "run_cancelled_1";
      const cancelledAt = new Date("2026-01-01T00:00:00.000Z");
      const error = { type: "STRING_ERROR", raw: "cancelled before dispatch" };

      const input: CreateCancelledRunInput = {
        data: {
          id: runId,
          engine: "V2",
          status: "CANCELED",
          friendlyId: "run_cancelled_friendly_1",
          runtimeEnvironmentId: environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: organization.id,
          projectId: project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: "trace_c1",
          spanId: "span_c1",
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
          error: error as unknown as import("@trigger.dev/database").Prisma.InputJsonValue,
          completedAt: cancelledAt,
          updatedAt: cancelledAt,
          attemptNumber: 0,
        },
        snapshot: {
          engine: "V2",
          executionStatus: "FINISHED",
          description: "Run cancelled before materialisation",
          runStatus: "CANCELED",
          environmentId: environment.id,
          environmentType: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
        },
      };

      const run = await store.createCancelledRun(input);

      expect(run.id).toBe(runId);
      expect(run.status).toBe("CANCELED");
      expect(run.attemptNumber).toBe(0);
      expect(run.completedAt).toEqual(cancelledAt);

      const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
        where: { runId },
      });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.executionStatus).toBe("FINISHED");
      expect(snapshots[0]?.runStatus).toBe("CANCELED");
    }
  );

  postgresTest(
    "createFailedRun creates a SYSTEM_FAILURE run with no execution snapshot and null associatedWaitpoint when not provided",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
      });

      const runId = "run_failed_1";
      const completedAt = new Date("2026-01-01T00:00:00.000Z");
      const error = { type: "STRING_ERROR", raw: "system failure" };

      const input: CreateFailedRunInput = {
        data: {
          id: runId,
          engine: "V2",
          status: "SYSTEM_FAILURE",
          friendlyId: "run_failed_friendly_1",
          runtimeEnvironmentId: environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: organization.id,
          projectId: project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "trace_f1",
          spanId: "span_f1",
          queue: "task/my-task",
          isTest: false,
          completedAt,
          error: error as unknown as import("@trigger.dev/database").Prisma.InputJsonObject,
          depth: 0,
          taskEventStore: "taskEvent",
        },
      };

      const run = await store.createFailedRun(input);

      expect(run.id).toBe(runId);
      expect(run.status).toBe("SYSTEM_FAILURE");
      expect(run.completedAt).toEqual(completedAt);
      expect(run.associatedWaitpoint).toBeNull();

      const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
        where: { runId },
      });

      expect(snapshots).toHaveLength(0);
    }
  );

  postgresTest("startAttempt sets status to EXECUTING and records attempt fields", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runId = "run_start_attempt_1";

    await store.createRun(
      buildCreateRunInput({
        runId,
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
      })
    );

    const executedAt = new Date("2026-03-01T10:00:00.000Z");

    const run = await store.startAttempt(
      runId,
      { attemptNumber: 1, executedAt, isWarmStart: true },
      { select: { id: true, status: true, attemptNumber: true, executedAt: true, isWarmStart: true } }
    );

    expect(run.id).toBe(runId);
    expect(run.status).toBe("EXECUTING");
    expect(run.attemptNumber).toBe(1);
    expect(run.executedAt).toEqual(executedAt);
    expect(run.isWarmStart).toBe(true);
  });

  postgresTest(
    "completeAttemptSuccess sets status to COMPLETED_SUCCESSFULLY and creates a FINISHED snapshot",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_complete_success_1";

      await store.createRun(
        buildCreateRunInput({
          runId,
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );

      const completedAt = new Date("2026-03-01T11:00:00.000Z");

      const run = await store.completeAttemptSuccess(
        runId,
        {
          completedAt,
          output: '{"result":"ok"}',
          outputType: "application/json",
          usageDurationMs: 500,
          costInCents: 10,
          snapshot: {
            executionStatus: "FINISHED",
            description: "Task completed successfully",
            runStatus: "COMPLETED_SUCCESSFULLY",
            attemptNumber: 1,
            environmentId: environment.id,
            environmentType: "DEVELOPMENT",
            projectId: project.id,
            organizationId: organization.id,
          },
        },
        {
          select: {
            id: true,
            status: true,
            completedAt: true,
            output: true,
            outputType: true,
            usageDurationMs: true,
            costInCents: true,
          },
        }
      );

      expect(run.id).toBe(runId);
      expect(run.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(run.completedAt).toEqual(completedAt);
      expect(run.output).toBe('{"result":"ok"}');
      expect(run.usageDurationMs).toBe(500);
      expect(run.costInCents).toBe(10);

      const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
        where: { runId, executionStatus: "FINISHED" },
      });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.runStatus).toBe("COMPLETED_SUCCESSFULLY");
    }
  );

  postgresTest("recordRetryOutcome updates machine/usage/cost but leaves status unchanged", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runId = "run_retry_outcome_1";

    await store.createRun(
      buildCreateRunInput({
        runId,
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
      })
    );

    // Set status to EXECUTING first so we know what to verify against
    await store.startAttempt(runId, { attemptNumber: 1, isWarmStart: false }, { select: { id: true } });

    const run = await store.recordRetryOutcome(
      runId,
      { machinePreset: "large-1x", usageDurationMs: 200, costInCents: 5 },
      { include: { runtimeEnvironment: true } }
    );

    // Status must be unchanged (EXECUTING — not PENDING, not CANCELED)
    expect(run.status).toBe("EXECUTING");
    expect(run.machinePreset).toBe("large-1x");
    expect(run.usageDurationMs).toBe(200);
    expect(run.costInCents).toBe(5);
  });

  postgresTest("requeueRun sets status to PENDING", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runId = "run_requeue_1";

    await store.createRun(
      buildCreateRunInput({
        runId,
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
      })
    );

    await store.startAttempt(runId, { attemptNumber: 1, isWarmStart: false }, { select: { id: true } });

    const run = await store.requeueRun(runId, { select: { id: true, status: true } });

    expect(run.id).toBe(runId);
    expect(run.status).toBe("PENDING");
  });

  postgresTest("recordBulkActionMembership appends bulkActionId to existing array", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runId = "run_bulk_action_1";

    // Seed a run with an existing bulk action id
    await prisma.taskRun.create({
      data: {
        id: runId,
        engine: "V2",
        status: "CANCELED",
        friendlyId: "run_bulk_action_friendly_1",
        runtimeEnvironmentId: environment.id,
        environmentType: "DEVELOPMENT",
        organizationId: organization.id,
        projectId: project.id,
        taskIdentifier: "my-task",
        payload: "{}",
        payloadType: "application/json",
        traceContext: {},
        traceId: "trace_b1",
        spanId: "span_b1",
        queue: "task/my-task",
        isTest: false,
        taskEventStore: "taskEvent",
        depth: 0,
        bulkActionGroupIds: ["existing-bulk-id"],
      },
    });

    await store.recordBulkActionMembership(runId, "new-bulk-id");

    const updated = await prisma.taskRun.findUnique({
      where: { id: runId },
      select: { bulkActionGroupIds: true },
    });

    expect(updated?.bulkActionGroupIds).toContain("existing-bulk-id");
    expect(updated?.bulkActionGroupIds).toContain("new-bulk-id");
    expect(updated?.bulkActionGroupIds).toHaveLength(2);
  });

  postgresTest(
    "cancelRun sets status to CANCELED; without bulkActionId/usage those fields are untouched",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_cancel_no_bulk_1";

      // Seed with a pre-existing bulk action id so we can verify it stays
      await prisma.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "PENDING",
          friendlyId: "run_cancel_no_bulk_friendly_1",
          runtimeEnvironmentId: environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: organization.id,
          projectId: project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: "trace_cn1",
          spanId: "span_cn1",
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
          bulkActionGroupIds: ["x"],
        },
      });

      const cancelledAt = new Date("2026-04-01T00:00:00.000Z");
      const error = { type: "STRING_ERROR" as const, raw: "Canceled by user" };

      const run = await store.cancelRun(
        runId,
        { completedAt: cancelledAt, error },
        { select: { id: true, status: true, completedAt: true, bulkActionGroupIds: true, usageDurationMs: true, costInCents: true } }
      );

      expect(run.id).toBe(runId);
      expect(run.status).toBe("CANCELED");
      expect(run.completedAt).toEqual(cancelledAt);
      // bulkActionGroupIds must be unchanged (still just ["x"])
      expect(run.bulkActionGroupIds).toEqual(["x"]);
      // usage fields were not passed — should remain at default (0)
      expect(run.usageDurationMs).toBe(0);
      expect(run.costInCents).toBe(0);
    }
  );

  postgresTest(
    "cancelRun with bulkActionId and usage applies all optional fields",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_cancel_with_bulk_1";

      await store.createRun(
        buildCreateRunInput({
          runId,
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );

      const cancelledAt = new Date("2026-04-01T01:00:00.000Z");
      const error = { type: "STRING_ERROR" as const, raw: "Canceled by user" };

      const run = await store.cancelRun(
        runId,
        { completedAt: cancelledAt, error, bulkActionId: "bulk-abc", usageDurationMs: 300, costInCents: 7 },
        { select: { id: true, status: true, bulkActionGroupIds: true, usageDurationMs: true, costInCents: true } }
      );

      expect(run.status).toBe("CANCELED");
      expect(run.bulkActionGroupIds).toContain("bulk-abc");
      expect(run.usageDurationMs).toBe(300);
      expect(run.costInCents).toBe(7);
    }
  );

  postgresTest("failRunPermanently sets the passed status with completedAt/error/usage/cost", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runId = "run_fail_permanently_1";

    await store.createRun(
      buildCreateRunInput({
        runId,
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
      })
    );

    const completedAt = new Date("2026-05-01T00:00:00.000Z");
    const error = { type: "STRING_ERROR" as const, raw: "permanent failure" };

    const run = await store.failRunPermanently(
      runId,
      { status: "SYSTEM_FAILURE", completedAt, error, usageDurationMs: 150, costInCents: 3 },
      {
        select: {
          id: true,
          status: true,
          completedAt: true,
          usageDurationMs: true,
          costInCents: true,
        },
      }
    );

    expect(run.id).toBe(runId);
    expect(run.status).toBe("SYSTEM_FAILURE");
    expect(run.completedAt).toEqual(completedAt);
    expect(run.usageDurationMs).toBe(150);
    expect(run.costInCents).toBe(3);
  });

  postgresTest(
    "expireRun sets status to EXPIRED with distinct completedAt/expiredAt, error set, and one FINISHED/EXPIRED snapshot",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_expire_1";

      await store.createRun(
        buildCreateRunInput({
          runId,
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );

      const completedAt = new Date("2026-06-01T10:00:00.000Z");
      const expiredAt = new Date("2026-06-01T10:00:01.000Z");
      const error = { type: "STRING_ERROR" as const, raw: "Run expired because the TTL was reached" };

      const run = await store.expireRun(
        runId,
        {
          error,
          completedAt,
          expiredAt,
          snapshot: {
            engine: "V2",
            executionStatus: "FINISHED",
            description: "Run was expired because the TTL was reached",
            runStatus: "EXPIRED",
            environmentId: environment.id,
            environmentType: "DEVELOPMENT",
            projectId: project.id,
            organizationId: organization.id,
          },
        },
        {
          select: {
            id: true,
            status: true,
            completedAt: true,
            expiredAt: true,
            error: true,
          },
        }
      );

      expect(run.id).toBe(runId);
      expect(run.status).toBe("EXPIRED");
      expect(run.completedAt).toEqual(completedAt);
      expect(run.expiredAt).toEqual(expiredAt);
      // completedAt and expiredAt are distinct
      expect(run.completedAt?.getTime()).not.toBe(run.expiredAt?.getTime());

      const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
        where: { runId, executionStatus: "FINISHED", runStatus: "EXPIRED" },
      });
      expect(snapshots).toHaveLength(1);
    }
  );

  postgresTest(
    "expireRunsBatch sets EXPIRED status with all four timestamps equal to now and error set; returns correct count",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      const runId1 = "run_expire_batch_1";
      const runId2 = "run_expire_batch_2";

      for (const id of [runId1, runId2]) {
        await prisma.taskRun.create({
          data: {
            id,
            engine: "V2",
            status: "PENDING",
            friendlyId: `run_expire_batch_friendly_${id}`,
            runtimeEnvironmentId: environment.id,
            environmentType: "DEVELOPMENT",
            organizationId: organization.id,
            projectId: project.id,
            taskIdentifier: "my-task",
            payload: "{}",
            payloadType: "application/json",
            traceContext: {},
            traceId: `trace_${id}`,
            spanId: `span_${id}`,
            queue: "task/my-task",
            isTest: false,
            taskEventStore: "taskEvent",
            depth: 0,
          },
        });
      }

      const now = new Date("2026-06-01T12:00:00.000Z");
      const error = { type: "STRING_ERROR" as const, raw: "Run expired because the TTL was reached" };

      const count = await store.expireRunsBatch([runId1, runId2], { error, now });

      expect(count).toBe(2);

      for (const id of [runId1, runId2]) {
        const row = await prisma.taskRun.findUniqueOrThrow({
          where: { id },
          select: { status: true, completedAt: true, expiredAt: true, updatedAt: true },
        });
        expect(row.status).toBe("EXPIRED");
        expect(row.completedAt).toEqual(now);
        expect(row.expiredAt).toEqual(now);
        expect(row.updatedAt).toEqual(now);
      }
    }
  );

  postgresTest(
    "expireRunsBatch returns 0 and writes nothing when runIds is empty",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      const runId = "run_expire_batch_empty";
      await prisma.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "PENDING",
          friendlyId: "run_expire_batch_empty_friendly",
          runtimeEnvironmentId: environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: organization.id,
          projectId: project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: "trace_empty",
          spanId: "span_empty",
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });

      const error = { type: "STRING_ERROR" as const, raw: "unused" };

      // Must not throw (Prisma.join([]) would build an invalid `IN ()` clause).
      const count = await store.expireRunsBatch([], { error, now: new Date() });

      expect(count).toBe(0);

      const row = await prisma.taskRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, expiredAt: true },
      });
      expect(row.status).toBe("PENDING");
      expect(row.expiredAt).toBeNull();
    }
  );

  postgresTest(
    "lockRunToWorker sets status to DEQUEUED with lock columns, includes runtimeEnvironment, and creates one PENDING_EXECUTING snapshot",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_lock_1";

      await store.createRun(
        buildCreateRunInput({
          runId,
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        })
      );

      // Seed a background worker task to use as lockedById
      const backgroundWorker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: "worker_friendly_1",
          version: "20260601.1",
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          contentHash: "abc123",
          sdkVersion: "3.0.0",
          cliVersion: "3.0.0",
          metadata: {},
        },
      });

      const workerTask = await prisma.backgroundWorkerTask.create({
        data: {
          friendlyId: "task_friendly_1",
          slug: "my-task",
          filePath: "src/my-task.ts",
          exportName: "myTask",
          workerId: backgroundWorker.id,
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
        },
      });

      const queue = await prisma.taskQueue.create({
        data: {
          friendlyId: "queue_friendly_1",
          name: "task/my-task",
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
        },
      });

      // Seed a prior snapshot to use as previousSnapshotId
      const priorSnapshot = await prisma.taskRunExecutionSnapshot.create({
        data: {
          engine: "V2",
          executionStatus: "RUN_CREATED",
          description: "prior",
          runStatus: "PENDING",
          environmentId: environment.id,
          environmentType: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          runId,
        },
      });

      const lockedAt = new Date("2026-06-01T13:00:00.000Z");
      const startedAt = new Date("2026-06-01T13:00:01.000Z");
      const snapshotId = "snap_lock_1";

      const locked = await store.lockRunToWorker(runId, {
        lockedAt,
        lockedById: workerTask.id,
        lockedToVersionId: backgroundWorker.id,
        lockedQueueId: queue.id,
        startedAt,
        baseCostInCents: 5,
        machinePreset: "small-1x",
        taskVersion: "20260601.1",
        sdkVersion: "3.0.0",
        cliVersion: "3.0.0",
        maxDurationInSeconds: null,
        snapshot: {
          id: snapshotId,
          previousSnapshotId: priorSnapshot.id,
          environmentId: environment.id,
          environmentType: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          completedWaitpointIds: [],
          completedWaitpointOrder: [],
        },
      });

      expect(locked.status).toBe("DEQUEUED");
      expect(locked.lockedAt).toEqual(lockedAt);
      expect(locked.lockedById).toBe(workerTask.id);
      expect(locked.lockedToVersionId).toBe(backgroundWorker.id);
      expect(locked.lockedQueueId).toBe(queue.id);
      expect(locked.runtimeEnvironment).toBeDefined();
      expect(locked.runtimeEnvironment.id).toBe(environment.id);

      const snap = await prisma.taskRunExecutionSnapshot.findUnique({ where: { id: snapshotId } });
      expect(snap).not.toBeNull();
      expect(snap?.executionStatus).toBe("PENDING_EXECUTING");
      expect(snap?.runStatus).toBe("PENDING");
    }
  );

  postgresTest("parkPendingVersion sets status to PENDING_VERSION and stores statusReason", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runId = "run_park_1";

    await store.createRun(
      buildCreateRunInput({
        runId,
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
      })
    );

    const run = await store.parkPendingVersion(
      runId,
      { statusReason: "No background worker found" },
      { select: { id: true, status: true, statusReason: true } }
    );

    expect(run.id).toBe(runId);
    expect(run.status).toBe("PENDING_VERSION");
    expect(run.statusReason).toBe("No background worker found");
  });

  postgresTest(
    "promotePendingVersionRuns flips PENDING_VERSION to PENDING and returns count 1; run in another status returns count 0 and is unchanged",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);

      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      // Seed a PENDING_VERSION run
      const pendingVersionId = "run_promote_pv_1";
      await prisma.taskRun.create({
        data: {
          id: pendingVersionId,
          engine: "V2",
          status: "PENDING_VERSION",
          friendlyId: "run_promote_pv_friendly_1",
          runtimeEnvironmentId: environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: organization.id,
          projectId: project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: "trace_pv1",
          spanId: "span_pv1",
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });

      const result = await store.promotePendingVersionRuns(pendingVersionId);

      expect(result.count).toBe(1);

      const promoted = await prisma.taskRun.findUniqueOrThrow({ where: { id: pendingVersionId }, select: { status: true } });
      expect(promoted.status).toBe("PENDING");

      // Seed a run NOT in PENDING_VERSION (e.g. EXECUTING)
      const executingId = "run_promote_exec_1";
      await prisma.taskRun.create({
        data: {
          id: executingId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_promote_exec_friendly_1",
          runtimeEnvironmentId: environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: organization.id,
          projectId: project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: "trace_exec1",
          spanId: "span_exec1",
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });

      const result2 = await store.promotePendingVersionRuns(executingId);

      expect(result2.count).toBe(0);

      const unchanged = await prisma.taskRun.findUniqueOrThrow({ where: { id: executingId }, select: { status: true } });
      expect(unchanged.status).toBe("EXECUTING");
    }
  );

  postgresTest("suspendForCheckpoint sets status to WAITING_TO_RESUME", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runId = "run_suspend_1";

    await store.createRun(
      buildCreateRunInput({
        runId,
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
      })
    );

    const run = await store.suspendForCheckpoint(runId, {
      include: { runtimeEnvironment: true },
    });

    expect(run.id).toBe(runId);
    expect(run.status).toBe("WAITING_TO_RESUME");
    expect(run.runtimeEnvironment).toBeDefined();
  });

  postgresTest("resumeFromCheckpoint sets status to EXECUTING", async ({ prisma }) => {
    const { organization, project, environment } = await seedEnvironment(prisma);

    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runId = "run_resume_1";

    await store.createRun(
      buildCreateRunInput({
        runId,
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
      })
    );

    // Suspend first so we start from a realistic state
    await store.suspendForCheckpoint(runId, { include: {} });

    const run = await store.resumeFromCheckpoint(runId, {
      select: { id: true, status: true },
    });

    expect(run.id).toBe(runId);
    expect(run.status).toBe("EXECUTING");
  });
});

describe("PostgresRunStore — delayed / debounce / metadata / idempotency / array-append", () => {
  // Helper: seed a run with idempotency key and expiry set
  async function seedRunWithIdempotency(
    prisma: PrismaClient,
    params: {
      runId: string;
      friendlyId: string;
      organizationId: string;
      projectId: string;
      runtimeEnvironmentId: string;
      taskIdentifier?: string;
      idempotencyKey: string;
      idempotencyKeyExpiresAt?: Date;
      status?: string;
    }
  ) {
    return prisma.taskRun.create({
      data: {
        id: params.runId,
        engine: "V2",
        status: (params.status as any) ?? "PENDING",
        friendlyId: params.friendlyId,
        runtimeEnvironmentId: params.runtimeEnvironmentId,
        environmentType: "DEVELOPMENT",
        organizationId: params.organizationId,
        projectId: params.projectId,
        taskIdentifier: params.taskIdentifier ?? "my-task",
        payload: "{}",
        payloadType: "application/json",
        traceContext: {},
        traceId: `trace_${params.runId}`,
        spanId: `span_${params.runId}`,
        queue: "task/my-task",
        isTest: false,
        taskEventStore: "taskEvent",
        depth: 0,
        idempotencyKey: params.idempotencyKey,
        idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt ?? null,
      },
    });
  }

  // Helper: seed a plain run (no idempotency)
  async function seedRun(
    prisma: PrismaClient,
    params: {
      runId: string;
      friendlyId: string;
      organizationId: string;
      projectId: string;
      runtimeEnvironmentId: string;
      status?: string;
      runTags?: string[];
      realtimeStreams?: string[];
      metadata?: string;
      metadataType?: string;
      metadataVersion?: number;
    }
  ) {
    return prisma.taskRun.create({
      data: {
        id: params.runId,
        engine: "V2",
        status: (params.status as any) ?? "PENDING",
        friendlyId: params.friendlyId,
        runtimeEnvironmentId: params.runtimeEnvironmentId,
        environmentType: "DEVELOPMENT",
        organizationId: params.organizationId,
        projectId: params.projectId,
        taskIdentifier: "my-task",
        payload: "{}",
        payloadType: "application/json",
        traceContext: {},
        traceId: `trace_${params.runId}`,
        spanId: `span_${params.runId}`,
        queue: "task/my-task",
        isTest: false,
        taskEventStore: "taskEvent",
        depth: 0,
        runTags: params.runTags ?? [],
        realtimeStreams: params.realtimeStreams ?? [],
        ...(params.metadata !== undefined && { metadata: params.metadata }),
        ...(params.metadataType !== undefined && { metadataType: params.metadataType }),
        ...(params.metadataVersion !== undefined && { metadataVersion: params.metadataVersion }),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // rescheduleRun
  // ---------------------------------------------------------------------------

  postgresTest(
    "rescheduleRun with snapshot: writes delayUntil and creates a DELAYED snapshot",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_reschedule_snapshot_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_reschedule_snap_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        status: "DELAYED",
      });

      const delayUntil = new Date("2027-01-01T00:00:00.000Z");

      const updated = await store.rescheduleRun(runId, {
        delayUntil,
        snapshot: {
          environmentId: environment.id,
          environmentType: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
        },
      });

      expect(updated.id).toBe(runId);
      expect(updated.delayUntil).toEqual(delayUntil);

      const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
        where: { runId, executionStatus: "DELAYED" },
      });
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.runStatus).toBe("DELAYED");
    }
  );

  postgresTest(
    "rescheduleRun with queueTimestamp and no snapshot: writes delayUntil + queueTimestamp, no new snapshot",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_reschedule_notimestamp_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_reschedule_notimestamp_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        status: "DELAYED",
      });

      const delayUntil = new Date("2027-02-01T00:00:00.000Z");
      const queueTimestamp = new Date("2027-02-01T00:00:00.000Z");

      const updated = await store.rescheduleRun(runId, { delayUntil, queueTimestamp });

      expect(updated.delayUntil).toEqual(delayUntil);
      expect(updated.queueTimestamp).toEqual(queueTimestamp);

      const snapshotCount = await prisma.taskRunExecutionSnapshot.count({ where: { runId } });
      expect(snapshotCount).toBe(0);
    }
  );

  // ---------------------------------------------------------------------------
  // enqueueDelayedRun
  // ---------------------------------------------------------------------------

  postgresTest(
    "enqueueDelayedRun sets status to PENDING and writes queuedAt",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_enqueue_delayed_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_enqueue_delayed_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        status: "DELAYED",
      });

      const queuedAt = new Date("2026-06-17T10:00:00.000Z");
      const updated = await store.enqueueDelayedRun(runId, { queuedAt });

      expect(updated.id).toBe(runId);
      expect(updated.status).toBe("PENDING");
      expect(updated.queuedAt).toEqual(queuedAt);
    }
  );

  // ---------------------------------------------------------------------------
  // rewriteDebouncedRun
  // ---------------------------------------------------------------------------

  postgresTest(
    "rewriteDebouncedRun updates the requested columns and returns the run with associatedWaitpoint key",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_rewrite_debounced_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_rewrite_debounced_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        runTags: ["original-tag"],
      });

      const result = await store.rewriteDebouncedRun(runId, {
        payload: '{"key":"newvalue"}',
        payloadType: "application/json",
        runTags: ["new-tag"],
      });

      expect(result.id).toBe(runId);
      expect(result.payload).toBe('{"key":"newvalue"}');
      expect(result.runTags).toEqual(["new-tag"]);
      // associatedWaitpoint key must exist in the result (even if null)
      expect("associatedWaitpoint" in result).toBe(true);
    }
  );

  // ---------------------------------------------------------------------------
  // updateMetadata
  // ---------------------------------------------------------------------------

  postgresTest(
    "updateMetadata optimistic-lock: matching version writes metadata and returns count 1",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_update_meta_match_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_update_meta_match_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        metadata: '{"old":"data"}',
        metadataType: "application/json",
        metadataVersion: 1,
      });

      const updatedAt = new Date("2026-06-17T11:00:00.000Z");
      const result = await store.updateMetadata(
        runId,
        {
          metadata: '{"new":"data"}',
          metadataType: "application/json",
          metadataVersion: { increment: 1 },
          updatedAt,
        },
        { expectedMetadataVersion: 1 }
      );

      expect(result.count).toBe(1);

      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { metadata: true, metadataVersion: true, updatedAt: true },
      });
      expect(row?.metadata).toBe('{"new":"data"}');
      expect(row?.metadataVersion).toBe(2);
      expect(row?.updatedAt).toEqual(updatedAt);
    }
  );

  postgresTest(
    "updateMetadata optimistic-lock: non-matching version returns count 0, row unchanged",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_update_meta_mismatch_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_update_meta_mismatch_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        metadata: '{"original":"data"}',
        metadataType: "application/json",
        metadataVersion: 5,
      });

      const result = await store.updateMetadata(
        runId,
        {
          metadata: '{"new":"data"}',
          metadataVersion: { increment: 1 },
          updatedAt: new Date(),
        },
        { expectedMetadataVersion: 3 } // wrong version
      );

      expect(result.count).toBe(0);

      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { metadata: true, metadataVersion: true },
      });
      expect(row?.metadata).toBe('{"original":"data"}');
      expect(row?.metadataVersion).toBe(5);
    }
  );

  postgresTest(
    "updateMetadata direct (no expectedMetadataVersion): writes metadata and returns count 1",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_update_meta_direct_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_update_meta_direct_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        metadataVersion: 0,
      });

      const result = await store.updateMetadata(
        runId,
        {
          metadata: '{"direct":"write"}',
          metadataType: "application/json",
          metadataVersion: { increment: 1 },
          updatedAt: new Date(),
        },
        {}
      );

      expect(result.count).toBe(1);

      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { metadata: true, metadataVersion: true },
      });
      expect(row?.metadata).toBe('{"direct":"write"}');
      expect(row?.metadataVersion).toBe(1);
    }
  );

  // ---------------------------------------------------------------------------
  // clearIdempotencyKey
  // ---------------------------------------------------------------------------

  postgresTest(
    "clearIdempotencyKey byId: clears both idempotencyKey and idempotencyKeyExpiresAt when key matches",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_clear_idempotency_byid_1";
      const expiresAt = new Date("2028-01-01T00:00:00.000Z");

      await seedRunWithIdempotency(prisma, {
        runId,
        friendlyId: "run_clear_byid_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        idempotencyKey: "idem-key-abc",
        idempotencyKeyExpiresAt: expiresAt,
      });

      const result = await store.clearIdempotencyKey({
        byId: { runId, idempotencyKey: "idem-key-abc" },
      });

      expect(result.count).toBe(1);

      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { idempotencyKey: true, idempotencyKeyExpiresAt: true },
      });
      expect(row?.idempotencyKey).toBeNull();
      expect(row?.idempotencyKeyExpiresAt).toBeNull();
    }
  );

  postgresTest(
    "clearIdempotencyKey byId: returns count 0 when idempotencyKey does not match",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_clear_byid_mismatch_1";

      await seedRunWithIdempotency(prisma, {
        runId,
        friendlyId: "run_clear_byid_mismatch_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        idempotencyKey: "idem-key-real",
      });

      const result = await store.clearIdempotencyKey({
        byId: { runId, idempotencyKey: "idem-key-wrong" },
      });

      expect(result.count).toBe(0);

      // key still set
      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { idempotencyKey: true },
      });
      expect(row?.idempotencyKey).toBe("idem-key-real");
    }
  );

  postgresTest(
    "clearIdempotencyKey byPredicate: clears both columns when predicate matches",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_clear_predicate_1";
      const expiresAt = new Date("2028-06-01T00:00:00.000Z");

      await seedRunWithIdempotency(prisma, {
        runId,
        friendlyId: "run_clear_predicate_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        taskIdentifier: "predicate-task",
        idempotencyKey: "pred-idem-key",
        idempotencyKeyExpiresAt: expiresAt,
      });

      const result = await store.clearIdempotencyKey({
        byPredicate: {
          idempotencyKey: "pred-idem-key",
          taskIdentifier: "predicate-task",
          runtimeEnvironmentId: environment.id,
        },
      });

      expect(result.count).toBe(1);

      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { idempotencyKey: true, idempotencyKeyExpiresAt: true },
      });
      expect(row?.idempotencyKey).toBeNull();
      expect(row?.idempotencyKeyExpiresAt).toBeNull();
    }
  );

  postgresTest(
    "clearIdempotencyKey byFriendlyIds: clears ONLY idempotencyKey, leaves idempotencyKeyExpiresAt intact",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_clear_friendly_1";
      const expiresAt = new Date("2028-07-01T00:00:00.000Z");

      await seedRunWithIdempotency(prisma, {
        runId,
        friendlyId: "run_clear_friendly_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        idempotencyKey: "friendly-idem-key",
        idempotencyKeyExpiresAt: expiresAt,
      });

      const result = await store.clearIdempotencyKey({
        byFriendlyIds: ["run_clear_friendly_friendly_1"],
      });

      expect(result.count).toBe(1);

      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { idempotencyKey: true, idempotencyKeyExpiresAt: true },
      });
      // idempotencyKey cleared
      expect(row?.idempotencyKey).toBeNull();
      // idempotencyKeyExpiresAt NOT cleared (byFriendlyIds only clears the key)
      expect(row?.idempotencyKeyExpiresAt).toEqual(expiresAt);
    }
  );

  // ---------------------------------------------------------------------------
  // pushTags
  // ---------------------------------------------------------------------------

  postgresTest(
    "pushTags appends to existing runTags (seed [a], push [b,c] → [a,b,c]) and returns updatedAt",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_push_tags_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_push_tags_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        runTags: ["a"],
      });

      const result = await store.pushTags(runId, ["b", "c"], {
        runtimeEnvironmentId: environment.id,
      });

      expect(result.updatedAt).toBeInstanceOf(Date);

      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { runTags: true },
      });
      expect(row?.runTags).toEqual(["a", "b", "c"]);
    }
  );

  // ---------------------------------------------------------------------------
  // pushRealtimeStream
  // ---------------------------------------------------------------------------

  postgresTest(
    "pushRealtimeStream appends streamId to existing realtimeStreams",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = "run_push_stream_1";

      await seedRun(prisma, {
        runId,
        friendlyId: "run_push_stream_friendly_1",
        organizationId: organization.id,
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        realtimeStreams: ["existing-stream"],
      });

      await store.pushRealtimeStream(runId, "new-stream");

      const row = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { realtimeStreams: true },
      });
      expect(row?.realtimeStreams).toEqual(["existing-stream", "new-stream"]);
    }
  );
});
