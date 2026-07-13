import { describe, expect, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  $transaction: async (
    prismaClient: {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    },
    nameOrFn: string | ((tx: unknown) => Promise<unknown>),
    fnOrOptions?: ((tx: unknown) => Promise<unknown>) | unknown
  ) => {
    const fn =
      typeof nameOrFn === "string" ? (fnOrOptions as (tx: unknown) => Promise<unknown>) : nameOrFn;

    return prismaClient.$transaction(fn);
  },
}));

import { postgresTest } from "@internal/testcontainers";
import { loadEnvironmentVariablesEnvironments } from "~/presenters/v3/environmentVariablesEnvironments.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  createTestUser,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

describe("loadEnvironmentVariablesEnvironments", () => {
  postgresTest("returns environments for a project member", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);

    const production = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const result = await loadEnvironmentVariablesEnvironments(prisma, {
      userId: user.id,
      projectId: project.id,
    });

    expect(result.environments.map((environment) => environment.id)).toContain(production.id);
    expect(result.environments.every((environment) => typeof environment.id === "string")).toBe(
      true
    );
  });

  postgresTest("rejects users who are not project members", async ({ prisma }) => {
    const { project } = await createTestOrgProjectWithMember(prisma);
    const outsider = await createTestUser(prisma);

    await expect(
      loadEnvironmentVariablesEnvironments(prisma, {
        userId: outsider.id,
        projectId: project.id,
      })
    ).rejects.toThrow("Project not found");
  });

  postgresTest("filters shared, personal, and inaccessible environments", async ({ prisma }) => {
    const { user, organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
    const otherUser = await createTestUser(prisma);
    const otherOrgMember = await prisma.orgMember.create({
      data: {
        organizationId: organization.id,
        userId: otherUser.id,
        role: "MEMBER",
      },
    });

    const sharedProduction = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const currentUserDev = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
    });
    const otherUserDev = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "DEVELOPMENT",
      orgMemberId: otherOrgMember.id,
    });
    const orphanedDev = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "DEVELOPMENT",
      orgMemberId: null,
    });

    const result = await loadEnvironmentVariablesEnvironments(prisma, {
      userId: user.id,
      projectId: project.id,
    });

    const environmentIds = result.environments.map((environment) => environment.id);

    expect(environmentIds).toContain(sharedProduction.id);
    expect(environmentIds).toContain(currentUserDev.id);
    expect(environmentIds).not.toContain(otherUserDev.id);
    expect(environmentIds).not.toContain(orphanedDev.id);
  });

  postgresTest("returns hasStaging true when a staging environment exists", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);

    await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "STAGING",
    });

    const result = await loadEnvironmentVariablesEnvironments(prisma, {
      userId: user.id,
      projectId: project.id,
    });

    expect(result.hasStaging).toBe(true);
  });

  postgresTest(
    "returns hasStaging false when no staging environment exists",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);

      await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });

      const result = await loadEnvironmentVariablesEnvironments(prisma, {
        userId: user.id,
        projectId: project.id,
      });

      expect(result.hasStaging).toBe(false);
    }
  );
});
