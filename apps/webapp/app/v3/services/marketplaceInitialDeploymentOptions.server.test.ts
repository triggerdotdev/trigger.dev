import { randomUUID } from "node:crypto";
import { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { expect, test } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeSetFlag } from "~/v3/featureFlags.server";
import { marketplaceInitialDeploymentOptions } from "./marketplaceInitialDeploymentOptions.server";

postgresTest(
  "marketplace keeps the legacy payload unless branch selection is enabled",
  async ({ prisma }) => {
    const org = await prisma.organization.create({ data: { title: "Org", slug: randomUUID() } });
    const project = await prisma.project.create({
      data: {
        name: "Test",
        slug: randomUUID(),
        externalRef: randomUUID(),
        organizationId: org.id,
      },
    });
    const installation = await prisma.githubAppInstallation.create({
      data: {
        appInstallationId: 1n,
        targetId: 1n,
        targetType: "Organization",
        accountHandle: "test",
        repositorySelection: "ALL",
        organizationId: org.id,
      },
    });
    const repository = await prisma.githubRepository.create({
      data: {
        githubId: 1n,
        name: "test",
        fullName: "test/test",
        htmlUrl: "https://github.com/test/test",
        private: true,
        defaultBranch: "main",
        installationId: installation.id,
      },
    });
    await prisma.connectedGithubRepository.create({
      data: {
        projectId: project.id,
        repositoryId: repository.id,
        branchTracking: { prod: { branch: "release" }, staging: {} },
      },
    });

    const options = () => marketplaceInitialDeploymentOptions(project.id, org.id, prisma);
    const legacy = { environment: "prod" };
    expect(await options()).toEqual(legacy);
    expect(JSON.stringify(await options())).toBe('{"environment":"prod"}');

    const key = FEATURE_FLAG.deployNowEnabled;
    await makeSetFlag(prisma)({ key, value: false });
    await prisma.organization.update({
      where: { id: org.id },
      data: { featureFlags: { [key]: true } },
    });
    expect(await options()).toEqual({ environment: "prod", branch: "release" });

    await makeSetFlag(prisma)({ key, value: true });
    await prisma.organization.update({
      where: { id: org.id },
      data: { featureFlags: { [key]: false } },
    });
    expect(await options()).toEqual(legacy);

    const otherOrg = await prisma.organization.create({
      data: { title: "Other", slug: randomUUID(), featureFlags: { [key]: true } },
    });
    expect(
      (await marketplaceInitialDeploymentOptions(project.id, otherOrg.id, prisma)).branch
    ).toBeUndefined();
  }
);

test("a flag lookup outage preserves the existing marketplace payload", async () => {
  const unavailable = new PrismaClient({
    datasources: {
      db: { url: "postgresql://test:test@127.0.0.1:1/unavailable?connect_timeout=1" },
    },
  });
  try {
    expect(await marketplaceInitialDeploymentOptions("project", "org", unavailable)).toEqual({
      environment: "prod",
    });
  } finally {
    await unavailable.$disconnect();
  }
});
