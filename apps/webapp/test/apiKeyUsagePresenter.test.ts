import { containerTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";
import { ApiKeyUsagePresenter } from "~/presenters/v3/ApiKeyUsagePresenter.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

containerTest("reads usage for one key in the route's environment", async ({ prisma }) => {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  const otherEnvironment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "STAGING",
    slug: uniqueId("staging"),
  });
  const createKey = (name: string, runtimeEnvironmentId: string, revokedAt?: Date) =>
    prisma.apiKey.create({
      data: {
        name,
        keyHash: uniqueId(`${name}-hash`),
        lastFour: "abcd",
        runtimeEnvironmentId,
        createdByUserId: user.id,
        presetId: null,
        scopes: ["read:deployments"],
        revokedAt,
      },
    });
  const key = await createKey("Deploy reader", environment.id);
  const revoked = await createKey("Revoked", environment.id, new Date());
  const elsewhere = await createKey("Elsewhere", otherEnvironment.id);

  const trackedSince = new Date("2026-11-01T00:00:00Z");
  const apiKeyScopeUsage = vi.fn(async ({ apiKeys }: { apiKeys: { id: string }[] }) =>
    apiKeys.map((apiKey) => ({
      apiKeyId: apiKey.id,
      trackedSince,
      capabilities: {},
      usedOutsideCatalogue: [],
      usedUnrestrictedRoutes: false,
      narrowTo: { deployments: "read" },
    }))
  );
  const presenter = new ApiKeyUsagePresenter(prisma, { apiKeyScopeUsage });
  const read = (apiKeyId: string) =>
    presenter.call({
      userId: user.id,
      organizationSlug: organization.slug,
      projectSlug: project.slug,
      environmentSlug: environment.slug,
      apiKeyId,
    });

  const result = await read(key.id);
  expect(apiKeyScopeUsage).toHaveBeenCalledWith({
    organizationId: organization.id,
    windowDays: 30,
    apiKeys: [{ id: key.id, createdAt: key.createdAt, scopes: ["read:deployments"] }],
  });
  expect(result).toEqual({
    environmentType: "PRODUCTION",
    apiKey: { id: key.id, name: "Deploy reader", revokedAt: null },
    usage: { trackedSince, windowDays: 30, capabilities: {}, narrowTo: { deployments: "read" } },
  });

  apiKeyScopeUsage.mockClear();
  expect((await read(revoked.id)).usage).toBeNull();
  expect((await read(elsewhere.id)).apiKey).toBeNull();
  expect(apiKeyScopeUsage).not.toHaveBeenCalled();
});

containerTest("binds the key read to the caller's organization", async ({ prisma }) => {
  const first = await createTestOrgProjectWithMember(prisma);
  const second = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: second.project.id,
    organizationId: second.organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  const presenter = new ApiKeyUsagePresenter(prisma, { apiKeyScopeUsage: async () => null });

  await expect(
    presenter.call({
      userId: first.user.id,
      organizationSlug: second.organization.slug,
      projectSlug: second.project.slug,
      environmentSlug: environment.slug,
      apiKeyId: "any",
    })
  ).rejects.toThrow("Environment not found");
});

containerTest("does not inspect a system-issued key", async ({ prisma }) => {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  const systemKey = await prisma.apiKey.create({
    data: {
      name: "Build key",
      keyHash: uniqueId("build-hash"),
      lastFour: "abcd",
      runtimeEnvironmentId: environment.id,
      presetId: null,
      scopes: ["read:deployments"],
      issuedBy: "SYSTEM",
    },
  });
  const presenter = new ApiKeyUsagePresenter(prisma, { apiKeyScopeUsage: async () => null });

  const result = await presenter.call({
    userId: user.id,
    organizationSlug: organization.slug,
    projectSlug: project.slug,
    environmentSlug: environment.slug,
    apiKeyId: systemKey.id,
  });

  expect(result).toEqual({ environmentType: "PRODUCTION", apiKey: null, usage: null });
});
