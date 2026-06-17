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
});
