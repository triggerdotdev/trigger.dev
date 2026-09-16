import { postgresTest } from "@internal/testcontainers";
import rbac from "@trigger.dev/rbac";
import { expect } from "vitest";
import { dashboardResourceAccess } from "./dashboardResourceAccess.server";

postgresTest(
  "resource access resolves writer tenancy before permissive fallback",
  async ({ prisma }) => {
    const user = await prisma.user.create({
      data: { email: "resource@example.test", authenticationMethod: "MAGIC_LINK" },
    });
    const org = await prisma.organization.create({
      data: {
        slug: "resource",
        title: "Resource",
        members: { create: { userId: user.id, role: "MEMBER" } },
      },
    });
    const project = await prisma.project.create({
      data: { slug: "resource", name: "Resource", externalRef: "resource", organizationId: org.id },
    });
    const environment = await prisma.runtimeEnvironment.create({
      data: {
        slug: "prod",
        shortcode: "prod",
        type: "PRODUCTION",
        apiKey: "key",
        pkApiKey: "pk",
        projectId: project.id,
        organizationId: org.id,
      },
    });
    const controller = rbac.create(prisma, { forceFallback: true });
    const request = new Request("https://example.test/env/dev");
    const scope = { organizationId: org.id, projectId: project.id, environmentId: environment.id };
    const access = await dashboardResourceAccess(prisma, controller, request, user.id, scope);
    for (const subject of [
      "webhooks",
      "alerts",
      "dashboards",
      "errors",
      "query",
      "sessions",
      "slack",
      "privateConnections",
      "dashboardAgent",
    ]) {
      expect(access.can("write", subject)).toBe(true);
      expect(() => access.require("write", subject)).not.toThrow();
    }
    for (const invalid of [
      { ...scope, organizationId: "foreign" },
      { ...scope, projectId: "foreign" },
      { ...scope, environmentId: "foreign" },
    ]) {
      await expect(
        dashboardResourceAccess(prisma, controller, request, user.id, invalid)
      ).rejects.toMatchObject({ status: 404 });
    }
    await expect(
      dashboardResourceAccess(prisma, controller, request, "outsider", scope)
    ).rejects.toMatchObject({ status: 404 });
    // Environment-only scopes must enforce the owning project's lifecycle too.
    const environmentScope = { organizationId: org.id, environmentId: environment.id };
    await expect(
      dashboardResourceAccess(prisma, controller, request, user.id, environmentScope)
    ).resolves.toBeDefined();
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
    for (const deletedProjectScope of [scope, environmentScope]) {
      await expect(
        dashboardResourceAccess(prisma, controller, request, user.id, deletedProjectScope)
      ).rejects.toMatchObject({ status: 404 });
    }
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: null } });
    await prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { archivedAt: new Date() },
    });
    await expect(
      dashboardResourceAccess(prisma, controller, request, user.id, scope)
    ).rejects.toMatchObject({ status: 404 });
  }
);
