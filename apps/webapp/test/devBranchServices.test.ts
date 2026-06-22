import { postgresTest } from "@internal/testcontainers";
import { type PrismaClient } from "@trigger.dev/database";
import slug from "slug";
import { describe, expect, vi } from "vitest";
import { ArchiveBranchService } from "~/services/archiveBranch.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { createTestOrgProjectWithMember, uniqueId } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function createDevRoot(
  prisma: PrismaClient,
  projectId: string,
  organizationId: string,
  orgMemberId: string
) {
  return prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      apiKey: uniqueId("tr_dev"),
      pkApiKey: uniqueId("pk_dev"),
      shortcode: uniqueId("sc"),
      projectId,
      organizationId,
      type: "DEVELOPMENT",
      orgMemberId,
      maximumConcurrencyLimit: 17,
    },
  });
}

describe("UpsertBranchService — DEVELOPMENT parent", () => {
  postgresTest("creates a child branch that inherits the parent's ownership", async ({ prisma }) => {
    const { organization, project, user, orgMember } = await createTestOrgProjectWithMember(prisma);
    const devRoot = await createDevRoot(prisma, project.id, organization.id, orgMember.id);

    const result = await new UpsertBranchService(prisma).call(
      { type: "userMembership", userId: user.id },
      { projectId: project.id, env: "development", branchName: "my-feature" }
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const { branch } = result;
    expect(branch.type).toBe("DEVELOPMENT");
    expect(branch.parentEnvironmentId).toBe(devRoot.id);
    expect(branch.branchName).toBe("my-feature");
    // The key dev-vs-preview divergence: dev branches MUST copy the parent's
    // orgMemberId (preview parents have none).
    expect(branch.orgMemberId).toBe(orgMember.id);
    // Children inherit the parent's concurrency limit at creation.
    expect(branch.maximumConcurrencyLimit).toBe(17);
    expect(branch.slug).toBe(slug(`${devRoot.slug}-my-feature`));
  });

  postgresTest("is idempotent — upserting the same branch returns the existing row", async ({ prisma }) => {
    const { organization, project, user, orgMember } = await createTestOrgProjectWithMember(prisma);
    await createDevRoot(prisma, project.id, organization.id, orgMember.id);
    const orgFilter = { type: "userMembership" as const, userId: user.id };
    const options = { projectId: project.id, env: "development" as const, branchName: "dup" };

    const first = await new UpsertBranchService(prisma).call(orgFilter, options);
    const second = await new UpsertBranchService(prisma).call(orgFilter, options);

    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(second.alreadyExisted).toBe(true);
    expect(second.branch.id).toBe(first.branch.id);
  });

  postgresTest("rejects an invalid branch name without touching the database", async ({ prisma }) => {
    const { organization, project, user, orgMember } = await createTestOrgProjectWithMember(prisma);
    await createDevRoot(prisma, project.id, organization.id, orgMember.id);

    const result = await new UpsertBranchService(prisma).call(
      { type: "userMembership", userId: user.id },
      { projectId: project.id, env: "development", branchName: "bad branch name!" }
    );

    expect(result.success).toBe(false);
  });
});

describe("ArchiveBranchService — DEVELOPMENT", () => {
  postgresTest("archives a dev branch and frees its slug/shortcode for reuse", async ({ prisma }) => {
    const { organization, project, user, orgMember } = await createTestOrgProjectWithMember(prisma);
    await createDevRoot(prisma, project.id, organization.id, orgMember.id);
    const orgFilter = { type: "userMembership" as const, userId: user.id };

    const created = await new UpsertBranchService(prisma).call(orgFilter, {
      projectId: project.id,
      env: "development",
      branchName: "reuse-me",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const originalSlug = created.branch.slug;

    const archived = await new ArchiveBranchService(prisma).call(orgFilter, {
      environmentId: created.branch.id,
    });
    expect(archived.success).toBe(true);
    if (!archived.success) return;
    expect(archived.branch.archivedAt).not.toBeNull();
    // Slug + shortcode are randomized on archive so the name can be reused.
    expect(archived.branch.slug).not.toBe(originalSlug);

    // The same branch name can now be created again (new row, deterministic slug).
    const recreated = await new UpsertBranchService(prisma).call(orgFilter, {
      projectId: project.id,
      env: "development",
      branchName: "reuse-me",
    });
    expect(recreated.success).toBe(true);
    if (!recreated.success) return;
    expect(recreated.branch.id).not.toBe(created.branch.id);
    expect(recreated.branch.slug).toBe(originalSlug);
  });

  postgresTest("refuses to archive the default branch (the dev root)", async ({ prisma }) => {
    const { organization, project, user, orgMember } = await createTestOrgProjectWithMember(prisma);
    const devRoot = await createDevRoot(prisma, project.id, organization.id, orgMember.id);

    const result = await new ArchiveBranchService(prisma).call(
      { type: "userMembership", userId: user.id },
      { environmentId: devRoot.id }
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("The default development branch cannot be archived.");
  });
});
