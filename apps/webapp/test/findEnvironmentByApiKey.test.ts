import { postgresTest } from "@internal/testcontainers";
import { type PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { findEnvironmentByApiKey } from "~/models/runtimeEnvironment.server";
import { createTestOrgProjectWithMember, uniqueId } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

type EnvOverrides = {
  type: "DEVELOPMENT" | "PREVIEW" | "PRODUCTION";
  orgMemberId?: string | null;
  parentEnvironmentId?: string | null;
  branchName?: string | null;
  isBranchableEnvironment?: boolean;
  archivedAt?: Date | null;
};

async function createEnv(
  prisma: PrismaClient,
  projectId: string,
  organizationId: string,
  overrides: EnvOverrides
) {
  return prisma.runtimeEnvironment.create({
    data: {
      slug: uniqueId("env"),
      apiKey: uniqueId("tr"),
      pkApiKey: uniqueId("pk"),
      shortcode: uniqueId("sc"),
      projectId,
      organizationId,
      type: overrides.type,
      orgMemberId: overrides.orgMemberId ?? null,
      parentEnvironmentId: overrides.parentEnvironmentId ?? null,
      branchName: overrides.branchName ?? null,
      isBranchableEnvironment: overrides.isBranchableEnvironment ?? false,
      archivedAt: overrides.archivedAt ?? null,
    },
  });
}

describe("findEnvironmentByApiKey — DEVELOPMENT branch resolution", () => {
  postgresTest("resolves the full dev auth matrix from the parent's api key", async ({ prisma }) => {
    const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);

    // The existing per-member dev env IS the default branch (no branchName).
    const devRoot = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
    });

    const namedBranch = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
      parentEnvironmentId: devRoot.id,
      branchName: "my-feature",
    });

    await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
      parentEnvironmentId: devRoot.id,
      branchName: "archived-feature",
      archivedAt: new Date(),
    });

    // No header → the root dev env (unchanged, day-one behaviour).
    const noHeader = await findEnvironmentByApiKey(devRoot.apiKey, undefined, prisma);
    expect(noHeader?.id).toBe(devRoot.id);

    // "default" sentinel → also the root dev env.
    const defaultHeader = await findEnvironmentByApiKey(devRoot.apiKey, "default", prisma);
    expect(defaultHeader?.id).toBe(devRoot.id);

    // A named branch that exists → the child env...
    const child = await findEnvironmentByApiKey(devRoot.apiKey, "my-feature", prisma);
    expect(child?.id).toBe(namedBranch.id);
    expect(child?.branchName).toBe("my-feature");
    // ...but carrying the PARENT's api key and ownership, not the child's own key.
    expect(child?.apiKey).toBe(devRoot.apiKey);
    expect(child?.orgMemberId).toBe(orgMember.id);

    // A named branch that doesn't exist → null (not a silent fall-through to root).
    const missing = await findEnvironmentByApiKey(devRoot.apiKey, "does-not-exist", prisma);
    expect(missing).toBeNull();

    // An archived branch → null (archivedAt filter on the child include).
    const archived = await findEnvironmentByApiKey(devRoot.apiKey, "archived-feature", prisma);
    expect(archived).toBeNull();
  });

  postgresTest("a branch name is sanitized before lookup", async ({ prisma }) => {
    const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);

    const devRoot = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
    });
    const namedBranch = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
      parentEnvironmentId: devRoot.id,
      branchName: "feature/login",
    });

    // refs/heads/ prefix is stripped to match the stored branch name.
    const resolved = await findEnvironmentByApiKey(
      devRoot.apiKey,
      "refs/heads/feature/login",
      prisma
    );
    expect(resolved?.id).toBe(namedBranch.id);
  });
});

describe("findEnvironmentByApiKey — PREVIEW (regression guard)", () => {
  postgresTest("preview still requires a branch and never resolves the parent", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);

    const previewParent = await createEnv(prisma, project.id, organization.id, {
      type: "PREVIEW",
      isBranchableEnvironment: true,
    });
    const previewBranch = await createEnv(prisma, project.id, organization.id, {
      type: "PREVIEW",
      parentEnvironmentId: previewParent.id,
      branchName: "pr-123",
    });

    // No header on a preview key → null (preview has no default).
    const noHeader = await findEnvironmentByApiKey(previewParent.apiKey, undefined, prisma);
    expect(noHeader).toBeNull();

    // With a branch → the child, carrying the parent's api key.
    const resolved = await findEnvironmentByApiKey(previewParent.apiKey, "pr-123", prisma);
    expect(resolved?.id).toBe(previewBranch.id);
    expect(resolved?.apiKey).toBe(previewParent.apiKey);
  });
});

describe("findEnvironmentByApiKey — non-branchable", () => {
  postgresTest("a production key ignores the branch header and returns itself", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);

    const prod = await createEnv(prisma, project.id, organization.id, { type: "PRODUCTION" });

    const resolved = await findEnvironmentByApiKey(prod.apiKey, "some-branch", prisma);
    expect(resolved?.id).toBe(prod.id);
  });

  postgresTest("an unknown api key returns null", async ({ prisma }) => {
    const resolved = await findEnvironmentByApiKey("tr_dev_nonexistent", undefined, prisma);
    expect(resolved).toBeNull();
  });
});
