import { postgresTest } from "@internal/testcontainers";
import { Prisma, type PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { listDeploymentBranches } from "~/v3/deploymentBranches.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const schema = Prisma.sql([`public`]);

async function createEnvironment(prisma: PrismaClient) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  return createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });
}

async function createDeployment(
  prisma: PrismaClient,
  environment: { id: string; projectId: string },
  version: string,
  commitRef?: string
) {
  await prisma.workerDeployment.create({
    data: {
      friendlyId: uniqueId("deployment"),
      shortCode: uniqueId("short"),
      version,
      contentHash: "hash",
      projectId: environment.projectId,
      environmentId: environment.id,
      git: commitRef ? { commitRef, commitSha: "abc1234" } : undefined,
    },
  });
}

describe("listDeploymentBranches", () => {
  // Catches: the Branch filter listing a branch twice, or another environment's branches.
  postgresTest("lists each of the environment's branches once, sorted", async ({ prisma }) => {
    const environment = await createEnvironment(prisma);
    const other = await createEnvironment(prisma);
    await createDeployment(prisma, environment, "20261119.1", "main");
    await createDeployment(prisma, environment, "20261119.2", "feature/filters");
    await createDeployment(prisma, environment, "20261119.3", "main");
    await createDeployment(prisma, environment, "20261119.4");
    await createDeployment(prisma, other, "20261119.1", "release");

    expect(await listDeploymentBranches(prisma, schema, environment.id)).toEqual([
      "feature/filters",
      "main",
    ]);
  });

  postgresTest("is empty when no deployment has git metadata", async ({ prisma }) => {
    const environment = await createEnvironment(prisma);
    await createDeployment(prisma, environment, "20261119.1");

    expect(await listDeploymentBranches(prisma, schema, environment.id)).toEqual([]);
  });
});
