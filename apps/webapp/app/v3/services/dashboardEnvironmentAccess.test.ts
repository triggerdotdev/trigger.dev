import { postgresTest } from "@internal/testcontainers";
import rbac from "@trigger.dev/rbac";
import { expect } from "vitest";
import { dashboardEnvironmentAccess } from "./dashboardEnvironmentAccess.server";

postgresTest(
  "the writer resolves the actual tenant and tier; self-hosted members retain permissive abilities",
  async ({ prisma }) => {
    const member = await prisma.user.create({
      data: {
        email: "runtime-member@example.test",
        authenticationMethod: "MAGIC_LINK",
        admin: false,
      },
    });
    const outsider = await prisma.user.create({
      data: { email: "runtime-outsider@example.test", authenticationMethod: "MAGIC_LINK" },
    });
    const organization = await prisma.organization.create({
      data: {
        slug: "runtime-auth",
        title: "Runtime auth",
        members: { create: { userId: member.id, role: "MEMBER" } },
      },
    });
    const project = await prisma.project.create({
      data: {
        slug: "runtime-auth",
        name: "Runtime auth",
        externalRef: "runtime-auth",
        organizationId: organization.id,
      },
    });
    const controller = rbac.create(prisma, { forceFallback: true });
    const request = new Request("https://example.test/orgs/wrong/projects/wrong/env/dev");

    for (const type of ["DEVELOPMENT", "STAGING", "PREVIEW", "PRODUCTION"] as const) {
      const environment = await prisma.runtimeEnvironment.create({
        data: {
          slug: type,
          type,
          shortcode: type,
          apiKey: `key_${type}`,
          pkApiKey: `pk_${type}`,
          projectId: project.id,
          organizationId: organization.id,
        },
      });
      const access = await dashboardEnvironmentAccess(
        prisma,
        controller,
        request,
        member.id,
        environment.id
      );
      expect(access.environment).toEqual({
        id: environment.id,
        type,
        organizationId: organization.id,
        projectId: project.id,
      });
      expect(access.ability.can("write", { type: "tasks", envType: type })).toBe(true);
      await expect(
        dashboardEnvironmentAccess(prisma, controller, request, outsider.id, environment.id)
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        dashboardEnvironmentAccess(prisma, controller, request, "", environment.id)
      ).rejects.toMatchObject({ status: 404 });
      // Each inactive ancestor must independently reject an otherwise valid member.
      for (const inactiveTarget of ["environment", "project", "organization"] as const) {
        if (inactiveTarget === "environment") {
          await prisma.runtimeEnvironment.update({
            where: { id: environment.id },
            data: { archivedAt: new Date() },
          });
        } else if (inactiveTarget === "project") {
          await prisma.project.update({
            where: { id: project.id },
            data: { deletedAt: new Date() },
          });
        } else {
          await prisma.organization.update({
            where: { id: organization.id },
            data: { deletedAt: new Date() },
          });
        }
        await expect(
          dashboardEnvironmentAccess(prisma, controller, request, member.id, environment.id)
        ).rejects.toMatchObject({ status: 404 });
        await prisma.runtimeEnvironment.update({
          where: { id: environment.id },
          data: { archivedAt: null },
        });
        await prisma.project.update({ where: { id: project.id }, data: { deletedAt: null } });
        await prisma.organization.update({
          where: { id: organization.id },
          data: { deletedAt: null },
        });
      }
    }
    await expect(
      dashboardEnvironmentAccess(prisma, controller, request, member.id, "missing")
    ).rejects.toMatchObject({ status: 404 });
  }
);
