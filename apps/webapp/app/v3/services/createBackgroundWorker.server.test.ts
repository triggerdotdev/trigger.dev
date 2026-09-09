import { ScheduleEngine } from "@internal/schedule-engine";
import { containerTest } from "@internal/testcontainers";
import type { BackgroundWorkerMetadata } from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  CreateBackgroundWorkerService,
  createWorkerResources,
  syncDeclarativeSchedules,
} from "~/v3/services/createBackgroundWorker.server";

vi.setConfig({ testTimeout: 60_000 });

function createTestScheduleEngine(
  prisma: PrismaClient,
  redis: ConstructorParameters<typeof ScheduleEngine>[0]["redis"]
) {
  return new ScheduleEngine({
    prisma,
    redis,
    worker: { concurrency: 1, disabled: true },
    distributionWindow: { seconds: 0 },
    schedulePhaseSecret: "sync-declarative-schedules-test",
    cronSpreadFraction: 1,
    onTriggerScheduledTask: async () => ({ success: true }),
    isDevEnvironmentConnectedHandler: async () => true,
  });
}

const scheduleJobId = (instanceId: string) => `scheduled-task-instance:${instanceId}`;

type TasksArg = Parameters<typeof syncDeclarativeSchedules>[0];
type WorkerArg = Parameters<typeof syncDeclarativeSchedules>[1];
const noWorker = {} as unknown as WorkerArg;

async function seedProjectWithEnvs(prisma: PrismaClient) {
  const slug = `sds_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  const mkEnv = (envSlug: string, type: "PRODUCTION" | "DEVELOPMENT") =>
    prisma.runtimeEnvironment.create({
      data: {
        slug: envSlug,
        type,
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${envSlug}_${slug}`,
        pkApiKey: `pk_${envSlug}_${slug}`,
        shortcode: `${envSlug[0]}${slug.slice(0, 5)}`,
      },
    });
  const prodEnv = await mkEnv("prod", "PRODUCTION");
  const devEnv = await mkEnv("dev", "DEVELOPMENT");
  return { organization, project, prodEnv, devEnv };
}

function makeDeclarativeSchedule(
  prisma: PrismaClient,
  projectId: string,
  environmentIds: string[],
  taskIdentifier = "my-task"
) {
  return prisma.taskSchedule.create({
    data: {
      friendlyId: `sched_${Math.random().toString(36).slice(2, 10)}`,
      taskIdentifier,
      projectId,
      generatorExpression: "0 * * * *",
      generatorDescription: "every hour",
      type: "DECLARATIVE",
      instances: {
        create: environmentIds.map((environmentId) => ({ environmentId, projectId })),
      },
    },
    include: { instances: true },
  });
}

function countingPrisma(prisma: PrismaClient) {
  const counts = { instanceDeleteMany: 0, scheduleDelete: 0, scheduleDeleteMany: 0 };
  const client = prisma.$extends({
    query: {
      taskScheduleInstance: {
        deleteMany({ args, query }) {
          counts.instanceDeleteMany++;
          return query(args);
        },
      },
      taskSchedule: {
        delete({ args, query }) {
          counts.scheduleDelete++;
          return query(args);
        },
        deleteMany({ args, query }) {
          counts.scheduleDeleteMany++;
          return query(args);
        },
      },
    },
  });
  return { client: client as unknown as PrismaClient, counts };
}

// syncDeclarativeSchedules reads environment.organizationId AND
// environment.organization.featureFlags (the free-plan policy resolves the rollout flag from
// the pre-loaded org). Attach a minimal organization so the fake env matches the real shape,
// and explicitly disable the unrelated policy unless a test opts into it. A valid org override
// also keeps these testcontainer calls from falling through to the app singleton's database.
const asEnv = (
  env: { id: string; projectId: string; type: string; organizationId?: string },
  organizationFeatureFlags: unknown = {
    [FEATURE_FLAG.freeScheduleMinimumWindowEnabled]: false,
  }
) =>
  ({
    ...env,
    organization: { id: env.organizationId, featureFlags: organizationFeatureFlags },
  }) as unknown as AuthenticatedEnvironment;

function declarativeTasks(schedule: { cron: string; timezone: string; window?: string }): TasksArg {
  return [{ id: "my-task", schedule }] as TasksArg;
}

function workerMetadata(description: string) {
  return {
    contentHash: "duplicate-task-content",
    tasks: [
      {
        id: "duplicate-task",
        description,
        filePath: "src/trigger/duplicate-task.ts",
        exportName: "duplicateTask",
        queue: { name: "duplicate-task-queue" },
      },
    ],
    queues: [{ name: "duplicate-task-queue" }],
  } as unknown as BackgroundWorkerMetadata;
}

async function seedScheduledTask(
  prisma: PrismaClient,
  projectId: string,
  runtimeEnvironmentId: string
) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${runtimeEnvironmentId}`,
      contentHash: `hash_${runtimeEnvironmentId}`,
      version: "20260811.1",
      metadata: {},
      projectId,
      runtimeEnvironmentId,
    },
  });

  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${runtimeEnvironmentId}`,
      slug: "my-task",
      filePath: "src/trigger/my-task.ts",
      workerId: worker.id,
      projectId,
      runtimeEnvironmentId,
      triggerSource: "SCHEDULED",
    },
  });
}

describe("worker task creation", () => {
  containerTest(
    "preserves one task when concurrent registration transactions target the same worker and slug",
    async ({ prisma }) => {
      const { project, devEnv } = await seedProjectWithEnvs(prisma);
      const worker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: `worker_${devEnv.id}`,
          contentHash: "duplicate-task-content",
          version: "20260811.1",
          metadata: {},
          projectId: project.id,
          runtimeEnvironmentId: devEnv.id,
        },
      });
      const queue = await prisma.taskQueue.create({
        data: {
          friendlyId: `queue_${devEnv.id}`,
          name: "duplicate-task-queue",
          type: "NAMED",
          version: "V2",
          paused: true,
          projectId: project.id,
          runtimeEnvironmentId: devEnv.id,
        },
      });
      const environment = { ...asEnv(devEnv), project } as AuthenticatedEnvironment;

      const entries = await Promise.all(
        ["first registration", "second registration"].map((description) =>
          prisma.$transaction((tx) =>
            createWorkerResources(workerMetadata(description), worker, environment, tx)
          )
        )
      );

      expect(entries).toEqual([
        [
          {
            slug: "duplicate-task",
            ttl: null,
            triggerSource: "STANDARD",
            queueId: queue.id,
            queueName: queue.name,
          },
        ],
        [
          {
            slug: "duplicate-task",
            ttl: null,
            triggerSource: "STANDARD",
            queueId: queue.id,
            queueName: queue.name,
          },
        ],
      ]);

      const created = await prisma.backgroundWorkerTask.findUniqueOrThrow({
        where: { workerId_slug: { workerId: worker.id, slug: "duplicate-task" } },
      });
      expect(["first registration", "second registration"]).toContain(created.description);
      expect(await prisma.backgroundWorkerTask.count({ where: { workerId: worker.id } })).toBe(1);

      await prisma.$transaction((tx) =>
        createWorkerResources(workerMetadata("replacement"), worker, environment, tx)
      );

      const afterRetry = await prisma.backgroundWorkerTask.findUniqueOrThrow({
        where: { workerId_slug: { workerId: worker.id, slug: "duplicate-task" } },
      });
      expect(afterRetry.id).toBe(created.id);
      expect(afterRetry.description).toBe(created.description);
    }
  );
});

describe("declarative schedule preflight", () => {
  containerTest("rejects identical retries before persisting a worker", async ({ prisma }) => {
    const { project, devEnv } = await seedProjectWithEnvs(prisma);
    const schedule = await makeDeclarativeSchedule(prisma, project.id, [devEnv.id]);
    await prisma.taskSchedule.update({
      where: { id: schedule.id },
      data: { minimumWindowDurationSeconds: 3600 },
    });
    const environment = { ...asEnv(devEnv), project } as AuthenticatedEnvironment;
    const body = {
      engine: "V2",
      metadata: {
        contentHash: "rejected-schedule-hash",
        tasks: declarativeTasks({ cron: "*/5 * * * *", timezone: "UTC" }),
      },
    } as Parameters<CreateBackgroundWorkerService["call"]>[2];
    const service = new CreateBackgroundWorkerService(prisma, prisma);

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.call(project.externalRef, environment, body)).rejects.toThrow(
        "Free-plan schedules must have at least 60 minutes between runs"
      );
      expect(await prisma.backgroundWorker.count({ where: { projectId: project.id } })).toBe(0);
    }
    expect(await prisma.taskSchedule.findFirst({ where: { id: schedule.id } })).toMatchObject({
      generatorExpression: "0 * * * *",
      minimumWindowDurationSeconds: 3600,
    });

    // A worker left by the old write-before-validation path must not bypass the guard either.
    await prisma.backgroundWorker.create({
      data: {
        friendlyId: `worker_${devEnv.id}`,
        contentHash: body.metadata.contentHash,
        version: "20260811.1",
        metadata: {},
        projectId: project.id,
        runtimeEnvironmentId: devEnv.id,
      },
    });
    await expect(service.call(project.externalRef, environment, body)).rejects.toThrow(
      "Free-plan schedules must have at least 60 minutes between runs"
    );
  });

  containerTest(
    "deletes excluded schedules without reading organization policy",
    async ({ prisma }) => {
      const { project, devEnv } = await seedProjectWithEnvs(prisma);
      await makeDeclarativeSchedule(prisma, project.id, [devEnv.id]);
      let organizationReads = 0;
      const client = prisma.$extends({
        query: {
          organization: {
            $allOperations({ args, query }) {
              organizationReads++;
              return query(args);
            },
          },
        },
      });
      // No preloaded organization: any attempted policy lookup would fail. The Prisma extension
      // observes real queries, including the default-window organization's database read.
      const tasks = [
        {
          id: "my-task",
          schedule: {
            cron: "0 * * * *",
            timezone: "UTC",
            environments: ["PRODUCTION"],
          },
        },
      ] as TasksArg;
      await syncDeclarativeSchedules(
        tasks,
        noWorker,
        devEnv as unknown as AuthenticatedEnvironment,
        client as unknown as PrismaClient
      );
      expect(organizationReads).toBe(0);
      expect(await prisma.taskSchedule.count({ where: { projectId: project.id } })).toBe(0);
    }
  );
});

describe("syncDeclarativeSchedules registration", () => {
  containerTest(
    "preserves an existing Redis job when declarative timing is unchanged",
    async ({ prisma, redisOptions }) => {
      const { project, prodEnv } = await seedProjectWithEnvs(prisma);
      const schedule = await makeDeclarativeSchedule(prisma, project.id, [prodEnv.id]);
      await seedScheduledTask(prisma, project.id, prodEnv.id);
      const engine = createTestScheduleEngine(prisma, redisOptions);

      try {
        const jobId = scheduleJobId(schedule.instances[0].id);
        await engine.registerNextTaskScheduleInstance({ instanceId: schedule.instances[0].id });
        const before = await engine.getJob(jobId);

        await syncDeclarativeSchedules(
          declarativeTasks({ cron: "0 * * * *", timezone: "UTC" }),
          noWorker,
          asEnv(prodEnv),
          prisma,
          engine
        );

        expect(before).toBeDefined();
        expect(await engine.getJob(jobId)).toEqual(before);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "replaces the Redis job when declarative timing changes",
    async ({ prisma, redisOptions }) => {
      const { project, prodEnv } = await seedProjectWithEnvs(prisma);
      const schedule = await makeDeclarativeSchedule(prisma, project.id, [prodEnv.id]);
      await seedScheduledTask(prisma, project.id, prodEnv.id);
      const engine = createTestScheduleEngine(prisma, redisOptions);

      try {
        const jobId = scheduleJobId(schedule.instances[0].id);
        await engine.registerNextTaskScheduleInstance({ instanceId: schedule.instances[0].id });
        const before = await engine.getJob(jobId);

        await syncDeclarativeSchedules(
          declarativeTasks({ cron: "30 * * * *", timezone: "UTC", window: "30m" }),
          noWorker,
          asEnv(prodEnv),
          prisma,
          engine
        );

        expect(before).toBeDefined();
        expect(await engine.getJob(jobId)).not.toEqual(before);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("re-registers every instance when shared timing changes", async ({ prisma }) => {
    const { project, prodEnv, devEnv } = await seedProjectWithEnvs(prisma);
    await seedScheduledTask(prisma, project.id, prodEnv.id);
    const schedule = await makeDeclarativeSchedule(prisma, project.id, [prodEnv.id, devEnv.id]);
    const restrictedSchedule = await prisma.taskSchedule.update({
      where: { id: schedule.id },
      data: { minimumWindowDurationSeconds: 3600 },
      include: { instances: true },
    });
    const tasks = declarativeTasks({ cron: "0 * * * *", timezone: "UTC" });
    const registerNextTaskScheduleInstance = vi.fn(async () => undefined);
    const prepared = {
      existingDeclarativeSchedules: [restrictedSchedule],
      preparedTasks: [
        {
          task: tasks[0],
          existingSchedule: restrictedSchedule,
          minimumWindowDurationSeconds: null,
        },
      ],
      defaultWindowDurationSeconds: null,
    } as NonNullable<Parameters<typeof syncDeclarativeSchedules>[5]>;

    await syncDeclarativeSchedules(
      tasks,
      noWorker,
      asEnv(prodEnv),
      prisma,
      { registerNextTaskScheduleInstance },
      prepared
    );

    expect(registerNextTaskScheduleInstance).toHaveBeenCalledTimes(2);
    expect(
      registerNextTaskScheduleInstance.mock.calls
        .map(([options]) => options)
        .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
    ).toEqual(
      restrictedSchedule.instances
        .map((instance) => ({ instanceId: instance.id, preserveExistingJob: false }))
        .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
    );
  });
});

describe("syncDeclarativeSchedules deletion path", () => {
  containerTest(
    "does not issue any instance delete when the env owns no instance of the missing schedules",
    async ({ prisma }) => {
      const { project, prodEnv, devEnv } = await seedProjectWithEnvs(prisma);

      for (let i = 0; i < 5; i++) {
        await makeDeclarativeSchedule(prisma, project.id, [prodEnv.id], `task-${i}`);
      }

      const { client, counts } = countingPrisma(prisma);
      await syncDeclarativeSchedules([], noWorker, asEnv(devEnv), client);

      expect(counts.instanceDeleteMany).toBe(0);
      expect(counts.scheduleDelete).toBe(0);

      const remaining = await prisma.taskScheduleInstance.count({
        where: { projectId: project.id },
      });
      expect(remaining).toBe(5);
    }
  );

  containerTest(
    "collapses N per-schedule instance deletes into a single batched deleteMany",
    async ({ prisma }) => {
      const { project, prodEnv, devEnv } = await seedProjectWithEnvs(prisma);

      for (let i = 0; i < 5; i++) {
        await makeDeclarativeSchedule(prisma, project.id, [prodEnv.id, devEnv.id], `task-${i}`);
      }

      const { client, counts } = countingPrisma(prisma);
      await syncDeclarativeSchedules([], noWorker, asEnv(devEnv), client);

      expect(counts.instanceDeleteMany).toBe(1);

      const devInstances = await prisma.taskScheduleInstance.count({
        where: { projectId: project.id, environmentId: devEnv.id },
      });
      expect(devInstances).toBe(0);

      const prodInstances = await prisma.taskScheduleInstance.count({
        where: { projectId: project.id, environmentId: prodEnv.id },
      });
      expect(prodInstances).toBe(5);

      const remainingSchedules = await prisma.taskSchedule.count({
        where: { projectId: project.id },
      });
      expect(remainingSchedules).toBe(5);
    }
  );

  containerTest(
    "deletes schedules whose only instance is in the current env",
    async ({ prisma }) => {
      const { project, devEnv } = await seedProjectWithEnvs(prisma);

      for (let i = 0; i < 3; i++) {
        await makeDeclarativeSchedule(prisma, project.id, [devEnv.id], `task-${i}`);
      }

      const { client } = countingPrisma(prisma);
      await syncDeclarativeSchedules([], noWorker, asEnv(devEnv), client);

      const schedules = await prisma.taskSchedule.count({ where: { projectId: project.id } });
      expect(schedules).toBe(0);
      const instances = await prisma.taskScheduleInstance.count({
        where: { projectId: project.id },
      });
      expect(instances).toBe(0);
    }
  );
});

describe("syncDeclarativeSchedules default window enrollment", () => {
  containerTest(
    "leaves a new declarative schedule NULL when the org flag is off",
    async ({ prisma, redisOptions }) => {
      const { project, prodEnv } = await seedProjectWithEnvs(prisma);
      await seedScheduledTask(prisma, project.id, prodEnv.id);
      const engine = createTestScheduleEngine(prisma, redisOptions);

      try {
        await syncDeclarativeSchedules(
          declarativeTasks({ cron: "0 * * * *", timezone: "UTC" }),
          noWorker,
          asEnv(prodEnv),
          prisma,
          engine
        );

        const schedule = await prisma.taskSchedule.findFirstOrThrow({
          where: { projectId: project.id, taskIdentifier: "my-task" },
        });
        expect(schedule.defaultWindowDurationSeconds).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "captures the 60m default on a new declarative schedule when the org flag is on",
    async ({ prisma, redisOptions }) => {
      const { organization, project, prodEnv } = await seedProjectWithEnvs(prisma);
      await prisma.organization.update({
        where: { id: organization.id },
        data: { featureFlags: { scheduleDefaultWindowEnabled: true } },
      });
      await seedScheduledTask(prisma, project.id, prodEnv.id);
      const engine = createTestScheduleEngine(prisma, redisOptions);

      try {
        await syncDeclarativeSchedules(
          declarativeTasks({ cron: "0 * * * *", timezone: "UTC" }),
          noWorker,
          asEnv(prodEnv),
          prisma,
          engine
        );

        const schedule = await prisma.taskSchedule.findFirstOrThrow({
          where: { projectId: project.id, taskIdentifier: "my-task" },
        });
        expect(schedule.defaultWindowDurationSeconds).toBe(3600);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "does not backfill or replace the job on a no-op redeploy of an enrolled schedule",
    async ({ prisma, redisOptions }) => {
      const { organization, project, prodEnv } = await seedProjectWithEnvs(prisma);
      await prisma.organization.update({
        where: { id: organization.id },
        data: { featureFlags: { scheduleDefaultWindowEnabled: true } },
      });
      await seedScheduledTask(prisma, project.id, prodEnv.id);
      const engine = createTestScheduleEngine(prisma, redisOptions);

      try {
        // First deploy enrolls the schedule.
        await syncDeclarativeSchedules(
          declarativeTasks({ cron: "0 * * * *", timezone: "UTC" }),
          noWorker,
          asEnv(prodEnv),
          prisma,
          engine
        );
        const created = await prisma.taskSchedule.findFirstOrThrow({
          where: { projectId: project.id, taskIdentifier: "my-task" },
          include: { instances: true },
        });
        expect(created.defaultWindowDurationSeconds).toBe(3600);

        const jobId = scheduleJobId(created.instances[0].id);
        const before = await engine.getJob(jobId);

        // Redeploy with no changes: the captured default is not backfilled again and the
        // pending Redis job is preserved because the resolved window is unchanged.
        await syncDeclarativeSchedules(
          declarativeTasks({ cron: "0 * * * *", timezone: "UTC" }),
          noWorker,
          asEnv(prodEnv),
          prisma,
          engine
        );

        const after = await prisma.taskSchedule.findFirstOrThrow({
          where: { id: created.id },
        });
        expect(after.defaultWindowDurationSeconds).toBe(3600);
        expect(before).toBeDefined();
        expect(await engine.getJob(jobId)).toEqual(before);
      } finally {
        await engine.quit();
      }
    }
  );
});
