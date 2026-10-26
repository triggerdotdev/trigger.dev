import { containerTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";
import { disableRootApiKeyVisibility, regenerateApiKey } from "~/models/api-key.server";
import { findEnvironmentByApiKey } from "~/models/runtimeEnvironment.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
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

containerTest(
  "regenerating a hidden root key keeps it hidden and keeps the previous key for a grace period",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const hiddenAt = new Date();
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      rootApiKeyHiddenAt: hiddenAt,
    });
    const oldRootApiKey = environment.apiKey;

    const result = await regenerateApiKey(
      { environmentId: environment.id, userId: user.id, allowHidden: true },
      { prismaClient: prisma }
    );
    const stored = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: environment.id },
    });

    expect(result.apiKey).not.toBe(oldRootApiKey);
    expect(result.rootApiKeyHiddenAt).toEqual(hiddenAt);
    expect(stored.apiKey).toBe(result.apiKey);
    expect(stored.pkApiKey).not.toBe(environment.pkApiKey);
    expect(stored.rootApiKeyHiddenAt).toEqual(hiddenAt);
    const revoked = await prisma.revokedApiKey.findMany({
      where: { runtimeEnvironmentId: environment.id },
    });
    expect(revoked).toHaveLength(1);
    expect(revoked[0].apiKey).toBe(oldRootApiKey);
    await expect(findEnvironmentByApiKey(oldRootApiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
    await expect(findEnvironmentByApiKey(stored.apiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
  }
);

containerTest(
  "regenerating a hidden root key with revokeImmediately rejects the previous key at once",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const hiddenAt = new Date();
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      rootApiKeyHiddenAt: hiddenAt,
    });
    const oldRootApiKey = environment.apiKey;

    const result = await regenerateApiKey(
      {
        environmentId: environment.id,
        userId: user.id,
        revokeImmediately: true,
        allowHidden: true,
      },
      { prismaClient: prisma }
    );
    const stored = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: environment.id },
    });

    expect(stored.apiKey).toBe(result.apiKey);
    expect(stored.rootApiKeyHiddenAt).toEqual(hiddenAt);
    await expect(
      prisma.revokedApiKey.count({ where: { runtimeEnvironmentId: environment.id } })
    ).resolves.toBe(0);
    await expect(findEnvironmentByApiKey(oldRootApiKey, undefined, prisma)).resolves.toBeNull();
    await expect(findEnvironmentByApiKey(stored.apiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
  }
);

containerTest(
  "regenerating a hidden branch root key rotates the shared parent and keeps it hidden",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const hiddenAt = new Date();
    const parent = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PREVIEW",
      rootApiKeyHiddenAt: hiddenAt,
    });
    const branch = await prisma.runtimeEnvironment.create({
      data: {
        slug: uniqueId("preview-branch"),
        type: "PREVIEW",
        projectId: project.id,
        organizationId: organization.id,
        parentEnvironmentId: parent.id,
        branchName: "feature/hidden-rotation",
        apiKey: uniqueId("branch-api"),
        pkApiKey: uniqueId("branch-pk"),
        shortcode: uniqueId("branch-sc"),
      },
    });

    const result = await regenerateApiKey(
      { environmentId: branch.id, userId: user.id, allowHidden: true },
      { prismaClient: prisma }
    );
    const storedParent = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: parent.id },
    });
    const storedBranch = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: branch.id },
    });

    expect(result.id).toBe(parent.id);
    expect(storedParent.apiKey).toBe(result.apiKey);
    expect(storedParent.apiKey).not.toBe(parent.apiKey);
    expect(storedParent.rootApiKeyHiddenAt).toEqual(hiddenAt);
    expect(storedBranch.apiKey).toBe(branch.apiKey);
  }
);

containerTest(
  "revokeImmediately also ends the grace window of root keys rotated earlier, only in that environment",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const otherEnvironment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "STAGING",
    });
    const oldestRootApiKey = environment.apiKey;

    const graceRotation = await regenerateApiKey(
      { environmentId: environment.id, userId: user.id },
      { prismaClient: prisma }
    );
    const otherRotation = await regenerateApiKey(
      { environmentId: otherEnvironment.id, userId: user.id },
      { prismaClient: prisma }
    );
    const revokeRotation = await regenerateApiKey(
      { environmentId: environment.id, userId: user.id, revokeImmediately: true },
      { prismaClient: prisma }
    );

    await expect(findEnvironmentByApiKey(oldestRootApiKey, undefined, prisma)).resolves.toBeNull();
    await expect(
      findEnvironmentByApiKey(graceRotation.apiKey, undefined, prisma)
    ).resolves.toBeNull();
    await expect(
      findEnvironmentByApiKey(revokeRotation.apiKey, undefined, prisma)
    ).resolves.toMatchObject({ id: environment.id });
    await expect(
      findEnvironmentByApiKey(otherEnvironment.apiKey, undefined, prisma)
    ).resolves.toMatchObject({ id: otherEnvironment.id });
    await expect(
      findEnvironmentByApiKey(otherRotation.apiKey, undefined, prisma)
    ).resolves.toMatchObject({ id: otherEnvironment.id });
  }
);

containerTest(
  "revoking immediately after disabling visibility stops the key that was visible before",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const previouslyVisibleApiKey = environment.apiKey;

    const disabled = await disableRootApiKeyVisibility(
      { environmentId: environment.id, userId: user.id },
      { prismaClient: prisma }
    );
    await expect(
      findEnvironmentByApiKey(previouslyVisibleApiKey, undefined, prisma)
    ).resolves.toMatchObject({ id: environment.id });

    const result = await regenerateApiKey(
      {
        environmentId: environment.id,
        userId: user.id,
        revokeImmediately: true,
        allowHidden: true,
      },
      { prismaClient: prisma }
    );

    await expect(
      findEnvironmentByApiKey(previouslyVisibleApiKey, undefined, prisma)
    ).resolves.toBeNull();
    await expect(findEnvironmentByApiKey(disabled.apiKey, undefined, prisma)).resolves.toBeNull();
    await expect(findEnvironmentByApiKey(result.apiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
    expect(result.rootApiKeyHiddenAt).toEqual(disabled.rootApiKeyHiddenAt);
  }
);
