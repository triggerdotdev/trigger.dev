import { containerTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  createTestUser,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

containerTest("binds API key reads to the organization in the route", async ({ prisma }) => {
  const first = await createTestOrgProjectWithMember(prisma);
  const second = await createTestOrgProjectWithMember(prisma, { userId: first.user.id });
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: second.project.id,
    organizationId: second.organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  const presenter = new ApiKeysPresenter(prisma);

  await expect(
    presenter.call({
      userId: first.user.id,
      organizationSlug: first.organization.slug,
      projectSlug: second.project.slug,
      environmentSlug: environment.slug,
    })
  ).rejects.toThrow("Environment not found");
});

containerTest(
  "describes stored full, catalogued, and unknown policies without exposing scopes",
  async ({ prisma }) => {
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      slug: uniqueId("prod"),
    });
    await prisma.apiKey.create({
      data: {
        name: "Full access",
        keyHash: uniqueId("full-hash"),
        lastFour: "full",
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: null,
        scopes: ["admin"],
      },
    });
    await prisma.apiKey.create({
      data: {
        name: "Restricted access",
        keyHash: uniqueId("restricted-hash"),
        lastFour: "rstr",
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: "RESTRICTED_TEST_PRESET",
        scopes: ["read:deployments"],
      },
    });
    await prisma.apiKey.create({
      data: {
        name: "Unknown preset",
        keyHash: uniqueId("unknown-hash"),
        lastFour: "unkn",
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: "REMOVED_PRESET",
        scopes: ["trigger:tasks:send-email"],
      },
    });
    await prisma.apiKey.create({
      data: {
        name: "Restricted without preset",
        keyHash: uniqueId("null-restricted-hash"),
        lastFour: "null",
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: null,
        scopes: ["read:runs"],
      },
    });
    await prisma.apiKey.create({
      data: {
        name: "Revoked key",
        keyHash: uniqueId("revoked-hash"),
        lastFour: "rvkd",
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: null,
        scopes: ["admin"],
        revokedAt: new Date(),
      },
    });
    const describeApiKeyPolicy = vi.fn(async (policy: { scopes: string[] }) =>
      policy.scopes.includes("trigger:tasks:send-email") ? { taskIdentifiers: ["send-email"] } : {}
    );
    const apiKeyPresets = vi.fn().mockResolvedValue([
      {
        id: "RESTRICTED_TEST_PRESET",
        label: "Restricted access",
        description: "Restricted test access",
        scopes: ["read:deployments"],
        usesTaskSelection: false,
        available: true,
      },
    ]);
    const presenter = new ApiKeysPresenter(prisma, { describeApiKeyPolicy, apiKeyPresets });

    const result = await presenter.call({
      userId: user.id,
      organizationSlug: organization.slug,
      projectSlug: project.slug,
      environmentSlug: environment.slug,
    });
    const keysByName = new Map(result.apiKeys.map((key) => [key.name, key]));

    expect(describeApiKeyPolicy).toHaveBeenCalledTimes(4);
    expect(describeApiKeyPolicy).toHaveBeenCalledWith({
      presetId: null,
      scopes: ["admin"],
    });
    expect(apiKeyPresets).toHaveBeenCalledWith(organization.id);
    expect(result.rootApiKey.obfuscated).toBe(`tr_prod_••••••••${environment.apiKey.slice(-4)}`);
    expect(keysByName.get("Full access")?.obfuscated).toBe("tr_prod_sk_••••••••full");
    expect(keysByName.get("Full access")?.access).toMatchObject({
      presetId: null,
      label: "Full access",
      usesTaskSelection: false,
    });
    expect(keysByName.get("Restricted access")?.access).toMatchObject({
      presetId: "RESTRICTED_TEST_PRESET",
      label: "Restricted access",
      usesTaskSelection: false,
    });
    expect(keysByName.get("Restricted without preset")?.access).toMatchObject({
      presetId: null,
      label: "Custom",
      usesTaskSelection: false,
    });
    expect(keysByName.get("Unknown preset")?.access).toEqual({
      presetId: "REMOVED_PRESET",
      label: "Custom",
      taskIdentifiers: ["send-email"],
      usesTaskSelection: true,
    });
    expect(keysByName.get("Full access")).not.toHaveProperty("scopes");
    expect(keysByName.get("Restricted access")).not.toHaveProperty("scopes");
    expect(keysByName.has("Revoked key")).toBe(false);
  }
);

containerTest(
  "does not expose another member's named development branch keys",
  async ({ prisma }) => {
    const owner = await createTestOrgProjectWithMember(prisma);
    const otherUser = await createTestUser(prisma);
    const otherMember = await prisma.orgMember.create({
      data: {
        organizationId: owner.organization.id,
        userId: otherUser.id,
        role: "MEMBER",
      },
    });
    const otherRoot = await createRuntimeEnvironment(prisma, {
      projectId: owner.project.id,
      organizationId: owner.organization.id,
      type: "DEVELOPMENT",
      orgMemberId: otherMember.id,
      slug: uniqueId("other-dev"),
    });
    const branch = await prisma.runtimeEnvironment.create({
      data: {
        slug: uniqueId("named-branch"),
        type: "DEVELOPMENT",
        projectId: owner.project.id,
        organizationId: owner.organization.id,
        orgMemberId: otherMember.id,
        parentEnvironmentId: otherRoot.id,
        branchName: "feature/secret",
        apiKey: uniqueId("api"),
        pkApiKey: uniqueId("pk"),
        shortcode: uniqueId("sc"),
      },
    });
    const presenter = new ApiKeysPresenter(prisma);

    await expect(
      presenter.call({
        userId: owner.user.id,
        organizationSlug: owner.organization.slug,
        projectSlug: owner.project.slug,
        environmentSlug: branch.slug,
      })
    ).rejects.toThrow("Environment not found");
  }
);
