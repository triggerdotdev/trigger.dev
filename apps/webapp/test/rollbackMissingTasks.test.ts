import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import { findRollbackTarget, tasksMissingFromTarget } from "~/v3/rollbackMissingTasks.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  createTestUser,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

describe("tasksMissingFromTarget", () => {
  // Catches: a rollback warning that lists tasks the target already has, or misses dropped ones.
  it("returns the current deploy's tasks the target lacks, sorted and unique", () => {
    expect(
      tasksMissingFromTarget(["v2-only", "hello", "b-task", "b-task"], ["hello", "extra"])
    ).toEqual(["b-task", "v2-only"]);
  });

  it("returns nothing when the target has every task", () => {
    expect(tasksMissingFromTarget(["a"], ["a", "b"])).toEqual([]);
  });
});

describe("findRollbackTarget", () => {
  // Catches: the rollback dialog's lookup returning a deployment to someone outside its organization.
  postgresTest("finds the deployment only for a member of its organization", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const deployment = await prisma.workerDeployment.create({
      data: {
        friendlyId: uniqueId("deployment"),
        shortCode: uniqueId("short"),
        version: "20261119.1",
        contentHash: "hash",
        projectId: project.id,
        environmentId: environment.id,
      },
    });
    const outsider = await createTestUser(prisma);
    const lookup = { projectId: project.id, deploymentShortCode: deployment.shortCode };

    expect(await findRollbackTarget(prisma, { ...lookup, userId: user.id })).toEqual({
      environmentId: environment.id,
      workerId: null,
    });
    expect(await findRollbackTarget(prisma, { ...lookup, userId: outsider.id })).toBeNull();
  });
});
