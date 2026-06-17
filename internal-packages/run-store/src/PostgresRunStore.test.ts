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
});
