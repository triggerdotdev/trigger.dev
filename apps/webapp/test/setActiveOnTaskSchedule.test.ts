import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  getScheduleEnvVisibility,
  scheduleUniqWhereClause,
  scheduleWhereClause,
} from "~/models/schedules.server";

vi.setConfig({ testTimeout: 60_000 });

// Exercises the project-scoping primitives SetActiveOnTaskScheduleService relies
// on (`scheduleWhereClause` + `scheduleUniqWhereClause`) directly against a real
// database, to avoid importing `~/db.server` and its eager global-prisma connect.

async function seedProject(prisma: PrismaClient, slugBase: string) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  return { organization, project };
}

function seedSchedule(
  prisma: PrismaClient,
  projectId: string,
  friendlyId: string,
  active: boolean = true
) {
  return prisma.taskSchedule.create({
    data: {
      friendlyId,
      taskIdentifier: "my-task",
      projectId,
      generatorExpression: "0 * * * *",
      generatorDescription: "every hour",
      type: "IMPERATIVE",
      active,
    },
  });
}

describe("schedule scoping (enable/disable)", () => {
  containerTest(
    "toggling scoped to another project does not touch the victim schedule",
    async ({ prisma }) => {
      const a = await seedProject(prisma, "orga");
      const b = await seedProject(prisma, "orgb");
      const victim = await seedSchedule(
        prisma,
        b.project.id,
        `sched_${Math.random().toString(36).slice(2, 10)}`,
        true
      );

      // Project A cannot toggle B's schedule: the where pins projectId, so the
      // update matches zero rows.
      const result = await prisma.taskSchedule.updateMany({
        where: scheduleWhereClause(a.project.id, victim.friendlyId),
        data: { active: false },
      });
      expect(result.count).toBe(0);

      const unchanged = await prisma.taskSchedule.findUnique({ where: { id: victim.id } });
      expect(unchanged?.active).toBe(true);

      // The owning project can toggle it.
      const owned = await prisma.taskSchedule.updateMany({
        where: scheduleWhereClause(b.project.id, victim.friendlyId),
        data: { active: false },
      });
      expect(owned.count).toBe(1);
    }
  );

  containerTest("the unique-where pins projectId", async ({ prisma }) => {
    const a = await seedProject(prisma, "orga");
    expect(scheduleUniqWhereClause(a.project.id, "sched_abc")).toMatchObject({
      friendlyId: "sched_abc",
      projectId: a.project.id,
    });
  });

  // The public activate/deactivate endpoints gate on getScheduleEnvVisibility
  // before toggling `active`. A key scoped to one environment must not be able
  // to enable/disable a schedule that only runs in another environment of the
  // same project.
  containerTest(
    "an env-scoped caller cannot toggle a schedule that only runs in another env",
    async ({ prisma }) => {
      const a = await seedProject(prisma, "orga");
      const prodEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "prod",
          type: "PRODUCTION",
          projectId: a.project.id,
          organizationId: a.organization.id,
          apiKey: `tr_prod_${a.project.slug}`,
          pkApiKey: `pk_prod_${a.project.slug}`,
          shortcode: `p${a.project.slug.slice(0, 4)}`,
        },
      });
      const stagingEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "staging",
          type: "STAGING",
          projectId: a.project.id,
          organizationId: a.organization.id,
          apiKey: `tr_staging_${a.project.slug}`,
          pkApiKey: `pk_staging_${a.project.slug}`,
          shortcode: `s${a.project.slug.slice(0, 4)}`,
        },
      });
      const schedule = await seedSchedule(
        prisma,
        a.project.id,
        `sched_${Math.random().toString(36).slice(2, 10)}`,
        true
      );
      // The schedule only runs in staging.
      await prisma.taskScheduleInstance.create({
        data: {
          taskScheduleId: schedule.id,
          environmentId: stagingEnv.id,
          projectId: a.project.id,
        },
      });

      // A prod-scoped key is refused (the route returns 404 and never updates).
      const fromProd = await getScheduleEnvVisibility(
        prisma,
        a.project.id,
        schedule.friendlyId,
        prodEnv.id
      );
      expect(fromProd.status).toBe("hidden");

      // The staging-scoped key that owns an instance can toggle it.
      const fromStaging = await getScheduleEnvVisibility(
        prisma,
        a.project.id,
        schedule.friendlyId,
        stagingEnv.id
      );
      expect(fromStaging.status).toBe("visible");
    }
  );
});
