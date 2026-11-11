import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { archiveBranchMutation } from "~/services/branchArchiveMutation.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

// Catches: overlapping cleanup failing or retrying against a replacement branch generation.
postgresTest(
  "concurrent archives succeed without changing an archived generation or its replacement",
  async ({ prisma }) => {
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
      slug: "preview-feature",
    });
    const branch = await prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { parentEnvironmentId: root.id, branchName: "feature" },
    });

    const [first, second] = await Promise.all([
      archiveBranchMutation(prisma, branch),
      archiveBranchMutation(prisma, branch),
    ]);
    expect(first.archivedAt).not.toBeNull();
    expect(second).toEqual(first);

    const replacement = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PREVIEW",
      slug: branch.slug,
    });
    await prisma.runtimeEnvironment.update({
      where: { id: replacement.id },
      data: { parentEnvironmentId: root.id, branchName: branch.branchName },
    });
    expect(await archiveBranchMutation(prisma, branch)).toEqual(first);
    expect(
      await prisma.runtimeEnvironment.findFirst({ where: { id: replacement.id } })
    ).toMatchObject({
      archivedAt: null,
      slug: branch.slug,
    });
    await expect(
      archiveBranchMutation(prisma, { id: "missing-environment", slug: branch.slug })
    ).rejects.toMatchObject({ code: "P2025" });
  }
);
