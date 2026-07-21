import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { scheduleWhereClause } from "~/models/schedules.server";

vi.setConfig({ testTimeout: 60_000 });

// Exercises the project-scoping primitive DeleteTaskScheduleService relies on
// (`scheduleWhereClause`) directly against a real database, to avoid importing
// `~/db.server` and its eager global-prisma connect.

async function seedProject(prisma: PrismaClient, slugBase: string) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  return { organization, project };
}

function seedSchedule(prisma: PrismaClient, projectId: string, friendlyId: string) {
  return prisma.taskSchedule.create({
    data: {
      friendlyId,
      taskIdentifier: "my-task",
      projectId,
      generatorExpression: "0 * * * *",
      generatorDescription: "every hour",
      type: "IMPERATIVE",
    },
  });
}

describe("scheduleWhereClause (delete lookup scoping)", () => {
  containerTest(
    "a schedule from another project is not found when scoped to the caller's project",
    async ({ prisma }) => {
      const a = await seedProject(prisma, "orga");
      const b = await seedProject(prisma, "orgb");
      const victim = await seedSchedule(
        prisma,
        b.project.id,
        `sched_${Math.random().toString(36).slice(2, 10)}`
      );

      // Scoped to A's project: the cross-tenant schedule is invisible (the
      // `projectId` in the where is what prevents a cross-project delete).
      const fromA = await prisma.taskSchedule.findFirst({
        where: scheduleWhereClause(a.project.id, victim.friendlyId),
      });
      expect(fromA).toBeNull();

      // Scoped to its own project: found.
      const fromB = await prisma.taskSchedule.findFirst({
        where: scheduleWhereClause(b.project.id, victim.friendlyId),
      });
      expect(fromB?.id).toBe(victim.id);
    }
  );

  containerTest("the where pins projectId for both id shapes", async ({ prisma }) => {
    const a = await seedProject(prisma, "orga");

    // friendlyId shape
    expect(scheduleWhereClause(a.project.id, "sched_abc")).toMatchObject({
      friendlyId: "sched_abc",
      projectId: a.project.id,
    });
    // deduplicationKey shape
    expect(scheduleWhereClause(a.project.id, "my-dedup-key")).toMatchObject({
      projectId: a.project.id,
      deduplicationKey: "my-dedup-key",
    });
  });
});
