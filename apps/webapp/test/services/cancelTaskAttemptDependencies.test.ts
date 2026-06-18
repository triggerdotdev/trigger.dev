import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { customAlphabet } from "nanoid";
import { expect, vi } from "vitest";
import { CancelTaskAttemptDependenciesService } from "~/v3/services/cancelTaskAttemptDependencies.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";
import { seedTestEnvironment } from "../helpers/seedTestEnvironment";

vi.setConfig({ testTimeout: 60_000 });

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

type SeedContext = {
  environmentId: string;
  projectId: string;
  organizationId: string;
  backgroundWorkerId: string;
  backgroundWorkerTaskId: string;
  queueId: string;
};

async function seedWorker(
  prisma: PrismaClient,
  ctx: { environmentId: string; projectId: string }
) {
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
      workerId: worker.id,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
    },
  });
  return { queueId: queue.id, backgroundWorkerId: worker.id, backgroundWorkerTaskId: task.id };
}

async function seedRun(prisma: PrismaClient, ctx: SeedContext) {
  const id = idGenerator();
  return prisma.taskRun.create({
    data: {
      id,
      friendlyId: `run_${id}`,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: idGenerator(),
      spanId: idGenerator(),
      queue: "task/test-task",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
    },
  });
}

async function seedAttempt(prisma: PrismaClient, ctx: SeedContext, taskRunId: string) {
  return prisma.taskRunAttempt.create({
    data: {
      friendlyId: `attempt_${idGenerator()}`,
      taskRunId,
      backgroundWorkerId: ctx.backgroundWorkerId,
      backgroundWorkerTaskId: ctx.backgroundWorkerTaskId,
      runtimeEnvironmentId: ctx.environmentId,
      queueId: ctx.queueId,
      status: "CANCELED",
    },
  });
}

containerTest(
  "cancelTaskAttemptDependencies cancels each dependent run once, in original order",
  async ({ prisma }) => {
    const { environment, project, organization } = await seedTestEnvironment(prisma);
    const worker = await seedWorker(prisma, {
      environmentId: environment.id,
      projectId: project.id,
    });
    const ctx: SeedContext = {
      environmentId: environment.id,
      projectId: project.id,
      organizationId: organization.id,
      ...worker,
    };

    // The attempt whose dependencies we cancel.
    const parentRun = await seedRun(prisma, ctx);
    const parentAttempt = await seedAttempt(prisma, ctx, parentRun.id);

    // Two direct dependencies.
    const depRunA = await seedRun(prisma, ctx);
    const depRunB = await seedRun(prisma, ctx);
    await prisma.taskRunDependency.create({
      data: { taskRunId: depRunA.id, dependentAttemptId: parentAttempt.id },
    });
    await prisma.taskRunDependency.create({
      data: { taskRunId: depRunB.id, dependentAttemptId: parentAttempt.id },
    });

    // One batch dependency carrying two run dependencies.
    const batchRunDepC = await seedRun(prisma, ctx);
    const batchRunDepD = await seedRun(prisma, ctx);
    const batchId = idGenerator();
    await prisma.batchTaskRun.create({
      data: {
        id: batchId,
        friendlyId: `batch_${batchId}`,
        runtimeEnvironmentId: environment.id,
        dependentTaskAttemptId: parentAttempt.id,
      },
    });
    await prisma.taskRunDependency.create({
      data: { taskRunId: batchRunDepC.id, dependentBatchRunId: batchId },
    });
    await prisma.taskRunDependency.create({
      data: { taskRunId: batchRunDepD.id, dependentBatchRunId: batchId },
    });

    const cancelledRunIds: string[] = [];
    const callSpy = vi
      .spyOn(CancelTaskRunService.prototype, "call")
      .mockImplementation(async (taskRun: any) => {
        cancelledRunIds.push(taskRun.id);
        return { id: taskRun.id, alreadyFinished: false };
      });

    try {
      const service = new CancelTaskAttemptDependenciesService(prisma);
      await service.call(parentAttempt.id);
    } finally {
      callSpy.mockRestore();
    }

    // Each dependent run cancelled exactly once.
    expect(cancelledRunIds).toHaveLength(4);
    expect(new Set(cancelledRunIds).size).toBe(4);

    // Direct dependencies first (both paths preserve insertion/iteration order), then batch run deps.
    const directIds = cancelledRunIds.slice(0, 2);
    const batchIds = cancelledRunIds.slice(2);
    expect(new Set(directIds)).toEqual(new Set([depRunA.id, depRunB.id]));
    expect(new Set(batchIds)).toEqual(new Set([batchRunDepC.id, batchRunDepD.id]));

    // The hydrated runs carry the fields CancelableTaskRun requires.
    const cancelArgs = callSpy.mock.calls.map((c) => c[0] as any);
    for (const run of cancelArgs) {
      expect(run).toMatchObject({
        id: expect.any(String),
        friendlyId: expect.any(String),
      });
      expect(run).toHaveProperty("engine");
      expect(run).toHaveProperty("status");
      expect(run).toHaveProperty("taskEventStore");
      expect(run).toHaveProperty("createdAt");
      expect("completedAt" in run).toBe(true);
    }
  }
);

containerTest(
  "cancelTaskAttemptDependencies skips dependencies whose run is not hydrated",
  async ({ prisma }) => {
    const { environment, project, organization } = await seedTestEnvironment(prisma);
    const worker = await seedWorker(prisma, {
      environmentId: environment.id,
      projectId: project.id,
    });
    const ctx: SeedContext = {
      environmentId: environment.id,
      projectId: project.id,
      organizationId: organization.id,
      ...worker,
    };

    const parentRun = await seedRun(prisma, ctx);
    const parentAttempt = await seedAttempt(prisma, ctx, parentRun.id);

    const presentRun = await seedRun(prisma, ctx);
    const missingRun = await seedRun(prisma, ctx);
    await prisma.taskRunDependency.create({
      data: { taskRunId: presentRun.id, dependentAttemptId: parentAttempt.id },
    });
    await prisma.taskRunDependency.create({
      data: { taskRunId: missingRun.id, dependentAttemptId: parentAttempt.id },
    });

    const cancelledRunIds: string[] = [];
    const callSpy = vi
      .spyOn(CancelTaskRunService.prototype, "call")
      .mockImplementation(async (taskRun: any) => {
        cancelledRunIds.push(taskRun.id);
        return { id: taskRun.id, alreadyFinished: false };
      });

    // Inject a runStore that deliberately omits `missingRun` to exercise the runMap-miss skip
    // (the post-redirect "run not found here" case). The constructor's third arg is the seam.
    const filteringRunStore = {
      findRuns: async (args: any) => {
        const ids: string[] = args.where.id.in;
        return prisma.taskRun.findMany({
          where: { id: { in: ids.filter((id) => id !== missingRun.id) } },
          select: args.select,
        });
      },
    } as any;

    try {
      const service = new CancelTaskAttemptDependenciesService(
        prisma,
        undefined,
        filteringRunStore
      );
      await service.call(parentAttempt.id);
    } finally {
      callSpy.mockRestore();
    }

    expect(cancelledRunIds).toEqual([presentRun.id]);
  }
);
