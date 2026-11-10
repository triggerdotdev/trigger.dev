import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { findTrustedPreviewBranch } from "~/services/trustedDeploys/findPreviewBranch.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

// Catches: lifecycle lookups missing deployed Git refs or selecting another project's live branch after archival.
postgresTest(
  "trusted lifecycle targets normalize Git refs and stay under their granted Preview parent",
  async ({ prisma }) => {
    const targets = [];
    for (let i = 0; i < 2; i++) {
      const { project, organization } = await createTestOrgProjectWithMember(prisma);
      const root = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PREVIEW",
      });
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PREVIEW",
      });
      const branch = await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { parentEnvironmentId: root.id, branchName: "feature" },
      });
      targets.push({ root, branch });
    }
    const [first, second] = targets;
    for (const name of ["feature", "refs/heads/feature", "refs/pull/feature"]) {
      expect(await findTrustedPreviewBranch(prisma, first.root, name)).toEqual({
        id: first.branch.id,
      });
    }
    expect(
      await findTrustedPreviewBranch(prisma, first.root, "refs/unsupported/feature")
    ).toBeNull();
    expect(
      await findTrustedPreviewBranch(
        prisma,
        { ...first.root, projectId: second.root.projectId },
        "feature"
      )
    ).toBeNull();

    await prisma.runtimeEnvironment.update({
      where: { id: first.branch.id },
      data: { archivedAt: new Date() },
    });
    expect(await findTrustedPreviewBranch(prisma, first.root, "feature")).toBeNull();
    expect(await findTrustedPreviewBranch(prisma, second.root, "feature")).toEqual({
      id: second.branch.id,
    });
  }
);
