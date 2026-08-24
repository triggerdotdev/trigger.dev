import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { getScheduleEnvVisibility } from "~/models/schedules.server";

vi.setConfig({ testTimeout: 60_000 });

async function seedProjectWithEnvs(prisma: PrismaClient, slugBase: string) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({
    data: { title: slug, slug },
  });
  const project = await prisma.project.create({
    data: {
      name: slug,
      slug,
      organizationId: organization.id,
      externalRef: slug,
    },
  });
  const prodEnv = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${slug.slice(0, 4)}`,
    },
  });
  const stagingEnv = await prisma.runtimeEnvironment.create({
    data: {
      slug: "staging",
      type: "STAGING",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_staging_${slug}`,
      pkApiKey: `pk_staging_${slug}`,
      shortcode: `s${slug.slice(0, 4)}`,
    },
  });
  return { organization, project, prodEnv, stagingEnv };
}

async function seedScheduleWithInstance(
  prisma: PrismaClient,
  projectId: string,
  environmentId: string,
  opts: { friendlyId?: string; deduplicationKey?: string } = {}
) {
  const schedule = await prisma.taskSchedule.create({
    data: {
      friendlyId: opts.friendlyId ?? `sched_${Math.random().toString(36).slice(2, 10)}`,
      taskIdentifier: "my-task",
      projectId,
      generatorExpression: "0 * * * *",
      generatorDescription: "every hour",
      type: "IMPERATIVE",
      ...(opts.deduplicationKey
        ? { deduplicationKey: opts.deduplicationKey, userProvidedDeduplicationKey: true }
        : {}),
    },
  });
  await prisma.taskScheduleInstance.create({
    data: {
      taskScheduleId: schedule.id,
      environmentId,
      projectId,
    },
  });
  return schedule;
}

describe("getScheduleEnvVisibility", () => {
  containerTest(
    "returns 'hidden' when an instance lives in a different env (by friendlyId)",
    async ({ prisma }) => {
      const env = await seedProjectWithEnvs(prisma, "orga");
      const schedule = await seedScheduleWithInstance(prisma, env.project.id, env.prodEnv.id);

      const visibility = await getScheduleEnvVisibility(
        prisma,
        env.project.id,
        schedule.friendlyId,
        env.stagingEnv.id
      );
      expect(visibility.status).toBe("hidden");
    }
  );

  containerTest("returns 'visible' when every instance is in caller env", async ({ prisma }) => {
    const env = await seedProjectWithEnvs(prisma, "orga");
    const schedule = await seedScheduleWithInstance(prisma, env.project.id, env.prodEnv.id);

    const visibility = await getScheduleEnvVisibility(
      prisma,
      env.project.id,
      schedule.friendlyId,
      env.prodEnv.id
    );
    expect(visibility.status).toBe("visible");
    if (visibility.status === "visible") {
      expect(visibility.schedule.id).toBe(schedule.id);
    }
  });

  containerTest("returns 'missing' when no schedule exists", async ({ prisma }) => {
    const env = await seedProjectWithEnvs(prisma, "orga");

    const visibility = await getScheduleEnvVisibility(
      prisma,
      env.project.id,
      "sched_does_not_exist",
      env.prodEnv.id
    );
    expect(visibility.status).toBe("missing");
  });

  containerTest("returns 'visible' when no instances exist yet", async ({ prisma }) => {
    const env = await seedProjectWithEnvs(prisma, "orga");
    const schedule = await prisma.taskSchedule.create({
      data: {
        friendlyId: `sched_${Math.random().toString(36).slice(2, 10)}`,
        taskIdentifier: "my-task",
        projectId: env.project.id,
        generatorExpression: "0 * * * *",
        generatorDescription: "every hour",
        type: "IMPERATIVE",
      },
    });

    const visibility = await getScheduleEnvVisibility(
      prisma,
      env.project.id,
      schedule.friendlyId,
      env.prodEnv.id
    );
    expect(visibility.status).toBe("visible");
  });

  containerTest(
    "returns 'visible' from every environment a multi-env schedule spans",
    async ({ prisma }) => {
      const env = await seedProjectWithEnvs(prisma, "orga");
      const schedule = await prisma.taskSchedule.create({
        data: {
          friendlyId: `sched_${Math.random().toString(36).slice(2, 10)}`,
          taskIdentifier: "my-task",
          projectId: env.project.id,
          generatorExpression: "0 * * * *",
          generatorDescription: "every hour",
          type: "IMPERATIVE",
        },
      });
      await prisma.taskScheduleInstance.createMany({
        data: [
          { taskScheduleId: schedule.id, environmentId: env.prodEnv.id, projectId: env.project.id },
          {
            taskScheduleId: schedule.id,
            environmentId: env.stagingEnv.id,
            projectId: env.project.id,
          },
        ],
      });

      // The schedule list surfaces a schedule for any environment it has an
      // instance in, so per-schedule reads/mutations must resolve the same
      // way. A multi-env schedule is visible from each environment it spans.
      const fromProd = await getScheduleEnvVisibility(
        prisma,
        env.project.id,
        schedule.friendlyId,
        env.prodEnv.id
      );
      expect(fromProd.status).toBe("visible");

      const fromStaging = await getScheduleEnvVisibility(
        prisma,
        env.project.id,
        schedule.friendlyId,
        env.stagingEnv.id
      );
      expect(fromStaging.status).toBe("visible");
    }
  );

  containerTest(
    "returns 'hidden' from an environment the schedule has no instance in",
    async ({ prisma }) => {
      const env = await seedProjectWithEnvs(prisma, "orga");
      // A third environment with no instance of the schedule.
      const devEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          projectId: env.project.id,
          organizationId: env.organization.id,
          apiKey: `tr_dev_${env.project.slug}`,
          pkApiKey: `pk_dev_${env.project.slug}`,
          shortcode: `d${env.project.slug.slice(0, 4)}`,
        },
      });
      const schedule = await prisma.taskSchedule.create({
        data: {
          friendlyId: `sched_${Math.random().toString(36).slice(2, 10)}`,
          taskIdentifier: "my-task",
          projectId: env.project.id,
          generatorExpression: "0 * * * *",
          generatorDescription: "every hour",
          type: "IMPERATIVE",
        },
      });
      await prisma.taskScheduleInstance.createMany({
        data: [
          { taskScheduleId: schedule.id, environmentId: env.prodEnv.id, projectId: env.project.id },
          {
            taskScheduleId: schedule.id,
            environmentId: env.stagingEnv.id,
            projectId: env.project.id,
          },
        ],
      });

      const fromDev = await getScheduleEnvVisibility(
        prisma,
        env.project.id,
        schedule.friendlyId,
        devEnv.id
      );
      expect(fromDev.status).toBe("hidden");
    }
  );

  containerTest(
    "resolves by user-provided deduplicationKey (the non-sched_ prefix branch)",
    async ({ prisma }) => {
      const env = await seedProjectWithEnvs(prisma, "orga");
      const dedupKey = `my-daily-cleanup-${Math.random().toString(36).slice(2, 8)}`;
      await seedScheduleWithInstance(prisma, env.project.id, env.prodEnv.id, {
        deduplicationKey: dedupKey,
      });

      const hiddenFromStaging = await getScheduleEnvVisibility(
        prisma,
        env.project.id,
        dedupKey,
        env.stagingEnv.id
      );
      expect(hiddenFromStaging.status).toBe("hidden");

      const visibleFromProd = await getScheduleEnvVisibility(
        prisma,
        env.project.id,
        dedupKey,
        env.prodEnv.id
      );
      expect(visibleFromProd.status).toBe("visible");
    }
  );
});
