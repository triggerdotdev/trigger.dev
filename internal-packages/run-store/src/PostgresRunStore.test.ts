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
