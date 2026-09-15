import { containerTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";
import {
  disableRootApiKeyVisibility,
  regenerateApiKey,
  RootApiKeyNotVisibleError,
} from "~/models/api-key.server";
import { createEnvironment } from "~/models/organization.server";
import { findEnvironmentByApiKey } from "~/models/runtimeEnvironment.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

containerTest("new runtime environments hide their root API key", async ({ prisma }) => {
  const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);

  const environment = await createEnvironment({
    organization,
    project,
    member: orgMember,
    type: "DEVELOPMENT",
    maximumConcurrencyLimit: 5,
    prismaClient: prisma,
  });

  expect(environment.rootApiKeyHiddenAt).toBeInstanceOf(Date);
});

containerTest(
  "disabling root key visibility rotates with a grace period and keeps existing keys",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const oldRootApiKey = environment.apiKey;
    const oldPkApiKey = environment.pkApiKey;
    const historicalRootApiKey = uniqueId("historical-root");
    await prisma.revokedApiKey.create({
      data: {
        apiKey: historicalRootApiKey,
        runtimeEnvironmentId: environment.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const additionalApiKey = await prisma.apiKey.create({
      data: {
        name: "Application key",
        keyHash: uniqueId("hash"),
        lastFour: "safe",
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        scopes: ["admin"],
      },
    });
    const disabledAt = Date.now();

    const result = await disableRootApiKeyVisibility(
      { environmentId: environment.id, userId: user.id },
      { prismaClient: prisma }
    );
    const stored = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: environment.id },
    });
    const revokedRootApiKeys = await prisma.revokedApiKey.findMany({
      where: { runtimeEnvironmentId: environment.id },
    });

    expect(result.rootApiKeyHiddenAt).toBeInstanceOf(Date);
    expect(stored.rootApiKeyHiddenAt).toEqual(result.rootApiKeyHiddenAt);
    expect(stored.apiKey).not.toBe(oldRootApiKey);
    expect(stored.pkApiKey).not.toBe(oldPkApiKey);
    await expect(findEnvironmentByApiKey(oldRootApiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
    await expect(
      findEnvironmentByApiKey(historicalRootApiKey, undefined, prisma)
    ).resolves.toMatchObject({ id: environment.id });
    await expect(findEnvironmentByApiKey(stored.apiKey, undefined, prisma)).resolves.toMatchObject({
      id: environment.id,
    });
    expect(revokedRootApiKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ apiKey: historicalRootApiKey }),
        expect.objectContaining({
          apiKey: oldRootApiKey,
          expiresAt: expect.any(Date),
        }),
      ])
    );
    expect(revokedRootApiKeys).toHaveLength(2);
    expect(
      revokedRootApiKeys.find((key) => key.apiKey === oldRootApiKey)?.expiresAt.getTime()
    ).toBeGreaterThan(disabledAt + 23 * 60 * 60 * 1000);
    await expect(
      prisma.apiKey.findFirst({ where: { id: additionalApiKey.id } })
    ).resolves.toMatchObject({ revokedAt: null });
  }
);

containerTest(
  "concurrent root key rotations do not report the key as hidden",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const rotatedEnvironments = await Promise.all([
      regenerateApiKey(
        { environmentId: environment.id, userId: user.id },
        { prismaClient: prisma }
      ),
      regenerateApiKey(
        { environmentId: environment.id, userId: user.id },
        { prismaClient: prisma }
      ),
    ]);
    const stored = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: environment.id },
    });
    const revokedRootApiKeys = await prisma.revokedApiKey.findMany({
      where: { runtimeEnvironmentId: environment.id },
    });
    const rotatedApiKeys = rotatedEnvironments.map((environment) => environment.apiKey);

    expect(new Set(rotatedApiKeys).size).toBe(2);
    expect(rotatedApiKeys).toContain(stored.apiKey);
    expect(revokedRootApiKeys.map((key) => key.apiKey)).toEqual(
      expect.arrayContaining([
        environment.apiKey,
        ...rotatedApiKeys.filter((key) => key !== stored.apiKey),
      ])
    );
    expect(revokedRootApiKeys).toHaveLength(2);
  }
);

containerTest("a hidden root API key cannot be regenerated and returned", async ({ prisma }) => {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    rootApiKeyHiddenAt: new Date(),
  });

  await expect(
    regenerateApiKey({ environmentId: environment.id, userId: user.id }, { prismaClient: prisma })
  ).rejects.toBeInstanceOf(RootApiKeyNotVisibleError);

  await expect(
    prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: environment.id } })
  ).resolves.toMatchObject({ apiKey: environment.apiKey });
});

containerTest(
  "root key mutations use the shared parent environment for branches",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const parent = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PREVIEW",
    });
    const childHiddenAt = new Date();
    const child = await prisma.runtimeEnvironment.create({
      data: {
        slug: uniqueId("preview-branch"),
        type: "PREVIEW",
        projectId: project.id,
        organizationId: organization.id,
        parentEnvironmentId: parent.id,
        branchName: "feature/shared-key",
        apiKey: uniqueId("child-api"),
        pkApiKey: uniqueId("child-pk"),
        shortcode: uniqueId("child-sc"),
        rootApiKeyHiddenAt: childHiddenAt,
      },
    });

    const result = await disableRootApiKeyVisibility(
      { environmentId: child.id, userId: user.id },
      { prismaClient: prisma }
    );
    const storedParent = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: parent.id },
    });
    const storedChild = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: child.id },
    });

    expect(result.id).toBe(parent.id);
    expect(storedParent.rootApiKeyHiddenAt).toBeInstanceOf(Date);
    expect(storedParent.apiKey).not.toBe(parent.apiKey);
    expect(storedChild.rootApiKeyHiddenAt).toEqual(childHiddenAt);
    expect(storedChild.apiKey).toBe(child.apiKey);

    await prisma.runtimeEnvironment.update({
      where: { id: child.id },
      data: { rootApiKeyHiddenAt: null },
    });
    await expect(
      regenerateApiKey({ environmentId: child.id, userId: user.id }, { prismaClient: prisma })
    ).rejects.toBeInstanceOf(RootApiKeyNotVisibleError);
  }
);

containerTest("visibility disable wins a race with root key regeneration", async ({ prisma }) => {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });

  const [, disableResult] = await Promise.allSettled([
    regenerateApiKey({ environmentId: environment.id, userId: user.id }, { prismaClient: prisma }),
    disableRootApiKeyVisibility(
      { environmentId: environment.id, userId: user.id },
      { prismaClient: prisma }
    ),
  ]);
  const stored = await prisma.runtimeEnvironment.findFirstOrThrow({
    where: { id: environment.id },
  });
  const revokedCount = await prisma.revokedApiKey.count({
    where: { runtimeEnvironmentId: environment.id },
  });

  expect(disableResult.status).toBe("fulfilled");
  expect(stored.rootApiKeyHiddenAt).toBeInstanceOf(Date);
  expect(revokedCount).toBeGreaterThanOrEqual(1);
  await expect(
    findEnvironmentByApiKey(environment.apiKey, undefined, prisma)
  ).resolves.toMatchObject({ id: environment.id });
});

containerTest("only one concurrent request can disable a root API key", async ({ prisma }) => {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });

  const results = await Promise.allSettled([
    disableRootApiKeyVisibility(
      { environmentId: environment.id, userId: user.id },
      { prismaClient: prisma }
    ),
    disableRootApiKeyVisibility(
      { environmentId: environment.id, userId: user.id },
      { prismaClient: prisma }
    ),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejection = results.find((result) => result.status === "rejected");
  expect(rejection).toMatchObject({ reason: expect.any(RootApiKeyNotVisibleError) });
});
