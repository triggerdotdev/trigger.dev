import { containerTest } from "@internal/testcontainers";
import type { Organization, PrismaClient, Project, RuntimeEnvironment } from "@trigger.dev/database";
import { customAlphabet } from "nanoid";
import { expect, vi } from "vitest";
import { ApiBatchResultsPresenter } from "~/presenters/v3/ApiBatchResultsPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { seedTestEnvironment } from "../helpers/seedTestEnvironment";

vi.setConfig({ testTimeout: 60_000 });

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

function authEnv(
  environment: RuntimeEnvironment,
  project: Project,
  organization: Organization
): AuthenticatedEnvironment {
  return { ...environment, project, organization, orgMember: null } as AuthenticatedEnvironment;
}

type SeedContext = {
  environmentId: string;
  projectId: string;
  organizationId: string;
  backgroundWorkerId: string;
  backgroundWorkerTaskId: string;
  queueId: string;
};

async function seedWorker(prisma: PrismaClient, ctx: Omit<SeedContext, "backgroundWorkerId" | "backgroundWorkerTaskId" | "queueId">) {
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${idGenerator()}`,
      name: "task/test-task",
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
    },
  });

  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${idGenerator()}`,
      contentHash: "hash",
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
      version: "20240101.1",
      metadata: {},
    },
  });

  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${idGenerator()}`,
      slug: "test-task",
      filePath: "src/test.ts",
      exportName: "testTask",
      workerId: worker.id,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
    },
  });

  return { queueId: queue.id, backgroundWorkerId: worker.id, backgroundWorkerTaskId: task.id };
}

async function seedRunWithAttempt(
  prisma: PrismaClient,
  ctx: SeedContext,
  opts: {
    status: "COMPLETED_SUCCESSFULLY" | "COMPLETED_WITH_ERRORS" | "CANCELED" | "EXECUTING";
    attempt?: {
      status: "COMPLETED" | "FAILED";
      output?: string;
      outputType?: string;
      error?: unknown;
    };
  }
) {
  const runInternalId = idGenerator();
  const run = await prisma.taskRun.create({
    data: {
      id: runInternalId,
      friendlyId: `run_${runInternalId}`,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: idGenerator(),
      spanId: idGenerator(),
      queue: "task/test-task",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      status: opts.status,
    },
  });

  if (opts.attempt) {
    await prisma.taskRunAttempt.create({
      data: {
        friendlyId: `attempt_${idGenerator()}`,
        taskRunId: run.id,
        backgroundWorkerId: ctx.backgroundWorkerId,
        backgroundWorkerTaskId: ctx.backgroundWorkerTaskId,
        runtimeEnvironmentId: ctx.environmentId,
        queueId: ctx.queueId,
        status: opts.attempt.status,
        output: opts.attempt.output,
        outputType: opts.attempt.outputType ?? "application/json",
        error: opts.attempt.error as any,
      },
    });
  }

  return run;
}

containerTest(
  "ApiBatchResultsPresenter returns ordered results matching pre-decompose behavior",
  async ({ prisma }) => {
    const { environment, project, organization } = await seedTestEnvironment(prisma);
    const worker = await seedWorker(prisma, {
      environmentId: environment.id,
      projectId: project.id,
      organizationId: organization.id,
    });
    const ctx: SeedContext = {
      environmentId: environment.id,
      projectId: project.id,
      organizationId: organization.id,
      ...worker,
    };

    // A successful run, a failed run, and an executing run (no terminal attempt → undefined).
    const successRun = await seedRunWithAttempt(prisma, ctx, {
      status: "COMPLETED_SUCCESSFULLY",
      attempt: { status: "COMPLETED", output: "\"hello\"", outputType: "application/json" },
    });
    const failedRun = await seedRunWithAttempt(prisma, ctx, {
      status: "COMPLETED_WITH_ERRORS",
      attempt: {
        status: "FAILED",
        error: { type: "BUILT_IN_ERROR", name: "Error", message: "boom", stackTrace: "boom" },
      },
    });
    const executingRun = await seedRunWithAttempt(prisma, ctx, {
      status: "EXECUTING",
    });

    const batchInternalId = idGenerator();
    const batchFriendlyId = `batch_${batchInternalId}`;
    await prisma.batchTaskRun.create({
      data: {
        id: batchInternalId,
        friendlyId: batchFriendlyId,
        runtimeEnvironmentId: environment.id,
      },
    });

    // Items inserted in a deterministic order: success, failed, executing.
    for (const run of [successRun, failedRun, executingRun]) {
      await prisma.batchTaskRunItem.create({
        data: {
          batchTaskRunId: batchInternalId,
          taskRunId: run.id,
        },
      });
    }

    const presenter = new ApiBatchResultsPresenter(prisma);
    const result = await presenter.call(batchFriendlyId, authEnv(environment, project, organization));

    expect(result).toBeDefined();
    expect(result?.id).toBe(batchFriendlyId);

    // executing run yields no execution result → filtered out. Order preserved: success then failed.
    expect(result?.items).toHaveLength(2);

    const [first, second] = result!.items;
    expect(first.ok).toBe(true);
    expect(first.id).toBe(successRun.friendlyId);
    if (first.ok) {
      expect(first.output).toBe("\"hello\"");
      expect(first.taskIdentifier).toBe("test-task");
    }

    expect(second.ok).toBe(false);
    expect(second.id).toBe(failedRun.friendlyId);
  }
);

containerTest(
  "ApiBatchResultsPresenter filters runs without an execution result but keeps order",
  async ({ prisma }) => {
    const { environment, project, organization } = await seedTestEnvironment(prisma);
    const worker = await seedWorker(prisma, {
      environmentId: environment.id,
      projectId: project.id,
      organizationId: organization.id,
    });
    const ctx: SeedContext = {
      environmentId: environment.id,
      projectId: project.id,
      organizationId: organization.id,
      ...worker,
    };

    // Pending run → executionResultForTaskRun returns undefined → filtered out, like the
    // pre-decompose code did via `.filter(Boolean)`.
    const pendingRun = await seedRunWithAttempt(prisma, ctx, { status: "EXECUTING" });
    const successRun = await seedRunWithAttempt(prisma, ctx, {
      status: "COMPLETED_SUCCESSFULLY",
      attempt: { status: "COMPLETED", output: "\"ok\"", outputType: "application/json" },
    });

    const batchInternalId = idGenerator();
    const batchFriendlyId = `batch_${batchInternalId}`;
    await prisma.batchTaskRun.create({
      data: {
        id: batchInternalId,
        friendlyId: batchFriendlyId,
        runtimeEnvironmentId: environment.id,
      },
    });

    // pending first, success second — only the success result should survive, in order.
    for (const run of [pendingRun, successRun]) {
      await prisma.batchTaskRunItem.create({
        data: { batchTaskRunId: batchInternalId, taskRunId: run.id },
      });
    }

    const presenter = new ApiBatchResultsPresenter(prisma);
    const result = await presenter.call(batchFriendlyId, authEnv(environment, project, organization));

    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.id).toBe(successRun.friendlyId);
  }
);

containerTest("ApiBatchResultsPresenter short-circuits an empty batch", async ({ prisma }) => {
  const { environment, project, organization } = await seedTestEnvironment(prisma);

  const batchInternalId = idGenerator();
  const batchFriendlyId = `batch_${batchInternalId}`;
  await prisma.batchTaskRun.create({
    data: {
      id: batchInternalId,
      friendlyId: batchFriendlyId,
      runtimeEnvironmentId: environment.id,
    },
  });

  const presenter = new ApiBatchResultsPresenter(prisma);
  const result = await presenter.call(batchFriendlyId, authEnv(environment, project, organization));

  expect(result).toEqual({ id: batchFriendlyId, items: [] });
});
