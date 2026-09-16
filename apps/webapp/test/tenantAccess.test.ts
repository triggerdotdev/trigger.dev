import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  findProjectByRef,
  findProjectBySlug,
  findProjectWithOrgFlagsBySlug,
} from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { EditSchedulePresenter } from "~/presenters/v3/EditSchedulePresenter.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function createSchedule(prisma: PrismaClient, projectId: string, environmentIds: string[]) {
  return prisma.taskSchedule.create({
    data: {
      friendlyId: uniqueId("schedule"),
      taskIdentifier: "scheduled-task",
      projectId,
      generatorExpression: "0 * * * *",
      type: "IMPERATIVE",
      instances: {
        create: environmentIds.map((environmentId) => ({ environmentId, projectId })),
      },
    },
  });
}

describe("tenant access boundaries", () => {
  postgresTest(
    "excludes deleted projects and organizations without hiding archived environments",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
        slug: "prod",
      });

      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { archivedAt: new Date() },
      });

      expect(
        await findProjectBySlug(organization.slug, project.slug, user.id, prisma)
      ).not.toBeNull();
      expect(await findProjectByRef(project.externalRef, user.id, prisma)).not.toBeNull();
      expect(
        await findProjectWithOrgFlagsBySlug(organization.slug, project.slug, user.id, prisma)
      ).not.toBeNull();
      expect(
        await findEnvironmentBySlug(project.id, environment.slug, user.id, prisma)
      ).not.toBeNull();

      await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

      expect(await findProjectBySlug(organization.slug, project.slug, user.id, prisma)).toBeNull();
      expect(await findProjectByRef(project.externalRef, user.id, prisma)).toBeNull();
      expect(
        await findProjectWithOrgFlagsBySlug(organization.slug, project.slug, user.id, prisma)
      ).toBeNull();
      expect(await findEnvironmentBySlug(project.id, environment.slug, user.id, prisma)).toBeNull();

      await prisma.project.update({ where: { id: project.id }, data: { deletedAt: null } });
      await prisma.organization.update({
        where: { id: organization.id },
        data: { deletedAt: new Date() },
      });

      expect(await findProjectBySlug(organization.slug, project.slug, user.id, prisma)).toBeNull();
      expect(await findProjectByRef(project.externalRef, user.id, prisma)).toBeNull();
      expect(
        await findProjectWithOrgFlagsBySlug(organization.slug, project.slug, user.id, prisma)
      ).toBeNull();
      expect(await findEnvironmentBySlug(project.id, environment.slug, user.id, prisma)).toBeNull();
    }
  );

  postgresTest(
    "rejects schedules from another project while preserving new and cross-environment schedules",
    async ({ prisma }) => {
      const owner = await createTestOrgProjectWithMember(prisma);
      const production = await createRuntimeEnvironment(prisma, {
        projectId: owner.project.id,
        organizationId: owner.organization.id,
        type: "PRODUCTION",
        slug: "prod",
      });
      const staging = await createRuntimeEnvironment(prisma, {
        projectId: owner.project.id,
        organizationId: owner.organization.id,
        type: "STAGING",
        slug: "staging",
      });
      const ownSchedule = await createSchedule(prisma, owner.project.id, [
        production.id,
        staging.id,
      ]);

      const other = await createTestOrgProjectWithMember(prisma);
      const foreignSchedule = await createSchedule(prisma, other.project.id, []);
      const presenter = new EditSchedulePresenter(prisma);

      const newSchedule = await presenter.call({
        userId: owner.user.id,
        projectSlug: owner.project.slug,
        environmentSlug: production.slug,
      });
      expect(newSchedule.schedule).toBeUndefined();

      const editable = await presenter.call({
        userId: owner.user.id,
        projectSlug: owner.project.slug,
        environmentSlug: production.slug,
        friendlyId: ownSchedule.friendlyId,
      });
      expect(editable.schedule?.environments.map((environment) => environment.id).sort()).toEqual(
        [production.id, staging.id].sort()
      );
      expect(editable.schedule).not.toHaveProperty("instances");

      await expect(
        presenter.call({
          userId: owner.user.id,
          projectSlug: owner.project.slug,
          environmentSlug: production.slug,
          friendlyId: foreignSchedule.friendlyId,
        })
      ).rejects.toMatchObject({ status: 404 });

      await expect(
        presenter.call({
          userId: owner.user.id,
          projectSlug: owner.project.slug,
          environmentSlug: production.slug,
          friendlyId: uniqueId("missing-schedule"),
        })
      ).rejects.toMatchObject({ status: 404 });
    }
  );
});
