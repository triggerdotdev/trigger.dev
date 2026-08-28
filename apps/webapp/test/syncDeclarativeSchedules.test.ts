import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { syncDeclarativeSchedules } from "~/v3/services/createBackgroundWorker.server";

const { registerNextTaskScheduleInstance } = vi.hoisted(() => ({
  registerNextTaskScheduleInstance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/v3/scheduleEngine.server", () => ({
  scheduleEngine: { registerNextTaskScheduleInstance },
}));

vi.setConfig({ testTimeout: 60_000 });

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

const asEnv = (env: { id: string; projectId: string; type: string }) =>
  env as unknown as AuthenticatedEnvironment;

function declarativeTasks(schedule: { cron: string; timezone: string; window?: string }): TasksArg {
  return [{ id: "my-task", schedule }] as TasksArg;
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

describe("syncDeclarativeSchedules registration", () => {
  containerTest(
    "preserves an existing Redis job when declarative timing is unchanged",
    async ({ prisma }) => {
      registerNextTaskScheduleInstance.mockClear();
      const { project, prodEnv } = await seedProjectWithEnvs(prisma);
      const schedule = await makeDeclarativeSchedule(prisma, project.id, [prodEnv.id]);
      await seedScheduledTask(prisma, project.id, prodEnv.id);

      await syncDeclarativeSchedules(
        declarativeTasks({ cron: "0 * * * *", timezone: "UTC" }),
        noWorker,
        asEnv(prodEnv),
        prisma
      );

      expect(registerNextTaskScheduleInstance).toHaveBeenCalledWith({
        instanceId: schedule.instances[0].id,
        preserveExistingJob: true,
      });
    }
  );

  containerTest("replaces the Redis job when declarative timing changes", async ({ prisma }) => {
    registerNextTaskScheduleInstance.mockClear();
    const { project, prodEnv } = await seedProjectWithEnvs(prisma);
    const schedule = await makeDeclarativeSchedule(prisma, project.id, [prodEnv.id]);
    await seedScheduledTask(prisma, project.id, prodEnv.id);

    await syncDeclarativeSchedules(
      declarativeTasks({ cron: "30 * * * *", timezone: "UTC", window: "30m" }),
      noWorker,
      asEnv(prodEnv),
      prisma
    );

    expect(registerNextTaskScheduleInstance).toHaveBeenCalledWith({
      instanceId: schedule.instances[0].id,
      preserveExistingJob: false,
    });
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
