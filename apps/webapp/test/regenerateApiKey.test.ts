import { containerTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";
import { regenerateApiKey } from "~/models/api-key.server";
import { findEnvironmentByApiKey } from "~/models/runtimeEnvironment.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

containerTest(
  "regenerating keeps the previous root key valid for a grace period",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const oldRootApiKey = environment.apiKey;

    const result = await regenerateApiKey(
      { environmentId: environment.id, userId: user.id },
      { prismaClient: prisma }
    );

    expect(result.apiKey).not.toBe(oldRootApiKey);
    const revoked = await prisma.revokedApiKey.findMany({
      where: { runtimeEnvironmentId: environment.id },
    });
    expect(revoked).toHaveLength(1);
    expect(revoked[0].apiKey).toBe(oldRootApiKey);
    expect(revoked[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(findEnvironmentByApiKey(oldRootApiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
    await expect(findEnvironmentByApiKey(result.apiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
  }
);

containerTest(
  "regenerating with revokeImmediately rejects the previous root key at once",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const oldRootApiKey = environment.apiKey;

    const result = await regenerateApiKey(
      { environmentId: environment.id, userId: user.id, revokeImmediately: true },
      { prismaClient: prisma }
    );

    expect(result.apiKey).not.toBe(oldRootApiKey);
    const revoked = await prisma.revokedApiKey.findMany({
      where: { runtimeEnvironmentId: environment.id },
    });
    expect(revoked).toHaveLength(0);
    await expect(findEnvironmentByApiKey(oldRootApiKey, undefined, prisma)).resolves.toBeNull();
    await expect(findEnvironmentByApiKey(result.apiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
  }
);
