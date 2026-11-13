import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { findTargetEnvironments } from "~/v3/environmentVariables/targetEnvironments.server";
import { findUnauthorizedEnvironmentId } from "~/v3/writableEnvironments";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function setup(prisma: PrismaClient) {
  const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
  const create = () =>
    createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PREVIEW",
    });

  const production = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });
  const preview = await prisma.runtimeEnvironment.update({
    where: { id: (await create()).id },
    data: { isBranchableEnvironment: true },
  });
  const liveBranch = await prisma.runtimeEnvironment.update({
    where: { id: (await create()).id },
    data: { parentEnvironmentId: preview.id, branchName: "feature-live" },
  });
  const archivedBranch = await prisma.runtimeEnvironment.update({
    where: { id: (await create()).id },
    data: { parentEnvironmentId: preview.id, branchName: "feature-closed", archivedAt: new Date() },
  });

  return { user, project, production, liveBranch, archivedBranch };
}

// The create action checks every submitted id against the lookup; edit and delete look up
// their one submitted id and answer "Environment not found" when it is missing.
describe("findTargetEnvironments", () => {
  // Catches: a create POST with an archived branch's id writing a value on that branch.
  postgresTest("create refuses an archived branch among the submitted ids", async ({ prisma }) => {
    const { user, project, production, archivedBranch } = await setup(prisma);
    const ids = [production.id, archivedBranch.id];

    const targets = await findTargetEnvironments(prisma, project.id, ids);

    expect(targets.map((e) => e.id)).toEqual([production.id]);
    expect(findUnauthorizedEnvironmentId(targets, ids, user.id)).toBe(archivedBranch.id);
  });

  // Catches: an edit or delete POST with an archived branch's id changing a value there.
  postgresTest("edit and delete find no environment for an archived branch", async ({ prisma }) => {
    const { user, project, archivedBranch } = await setup(prisma);

    const targets = await findTargetEnvironments(prisma, project.id, [archivedBranch.id]);

    expect(targets).toEqual([]);
    expect(findUnauthorizedEnvironmentId(targets, [archivedBranch.id], user.id)).toBe(
      archivedBranch.id
    );
  });

  postgresTest("a live branch is still a valid target", async ({ prisma }) => {
    const { user, project, liveBranch } = await setup(prisma);

    const targets = await findTargetEnvironments(prisma, project.id, [liveBranch.id]);

    expect(targets).toEqual([
      { id: liveBranch.id, type: "PREVIEW", branchName: "feature-live", orgMember: null },
    ]);
    expect(findUnauthorizedEnvironmentId(targets, [liveBranch.id], user.id)).toBeNull();
  });

  postgresTest("ignores an environment from another project", async ({ prisma }) => {
    const { project } = await setup(prisma);
    const other = await setup(prisma);

    const targets = await findTargetEnvironments(prisma, project.id, [other.production.id]);

    expect(targets).toEqual([]);
  });
});
