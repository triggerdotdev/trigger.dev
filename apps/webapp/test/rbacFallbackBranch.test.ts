import { postgresTest } from "@internal/testcontainers";
import plugin from "@trigger.dev/rbac";
import { type PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { createTestOrgProjectWithMember, uniqueId } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

// Exercises the RBAC *fallback* controller's bearer-auth branch pivot — the
// "new auth path" used by createLoaderApiRoute / createActionApiRoute. It
// mirrors findEnvironmentByApiKey, but is a separate implementation, so it
// needs its own coverage. forceFallback skips loading the closed-source plugin
// and uses the in-repo fallback directly.
function makeController(prisma: PrismaClient) {
  return plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });
}

function bearerRequest(apiKey: string, branch?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (branch !== undefined) {
    headers["x-trigger-branch"] = branch;
  }
  return new Request("https://api.trigger.dev/api/v1/test", { headers });
}

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

describe("RBAC fallback — DEVELOPMENT branch pivot", () => {
  postgresTest("pivots to the named branch, carrying the parent's api key", async ({ prisma }) => {
    const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);

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

    const result = await rbac.authenticateBearer(bearerRequest(devRoot.apiKey, "my-feature"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment.id).toBe(namedBranch.id);
    expect(result.environment.branchName).toBe("my-feature");
    // The pivoted env adopts the parent's api key, not the child's own.
    expect(result.environment.apiKey).toBe(devRoot.apiKey);
  });

  postgresTest("the 'default' sentinel resolves the root dev env (no pivot)", async ({ prisma }) => {
    const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);

    const devRoot = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
    });
    await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
      parentEnvironmentId: devRoot.id,
      branchName: "my-feature",
    });

    const result = await rbac.authenticateBearer(bearerRequest(devRoot.apiKey, "default"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment.id).toBe(devRoot.id);
  });

  postgresTest("no branch header resolves the root dev env", async ({ prisma }) => {
    const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);

    const devRoot = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
    });

    const result = await rbac.authenticateBearer(bearerRequest(devRoot.apiKey));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment.id).toBe(devRoot.id);
  });

  postgresTest("a named branch that doesn't exist is rejected (not a fall-through)", async ({
    prisma,
  }) => {
    const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);

    const devRoot = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
    });

    const result = await rbac.authenticateBearer(bearerRequest(devRoot.apiKey, "nope"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });
});

describe("RBAC fallback — branch header guards", () => {
  // The "default" sentinel is DEVELOPMENT-only: it maps the dev root env to its
  // (branchless) self. For PREVIEW, "default" is an ordinary branch name, so a
  // PREVIEW branch literally named "default" is reachable and the request pivots
  // to it like any other branch. (Preview branch names are normally PR refs, so
  // a branch named "default" is unusual — but it's supported, not a collision.)
  postgresTest("preview + 'default' pivots to the branch named 'default' (sentinel is dev-only)", async ({
    prisma,
  }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);

    const previewParent = await createEnv(prisma, project.id, organization.id, {
      type: "PREVIEW",
      isBranchableEnvironment: true,
    });
    const previewDefaultBranch = await createEnv(prisma, project.id, organization.id, {
      type: "PREVIEW",
      parentEnvironmentId: previewParent.id,
      branchName: "default",
    });

    const result = await rbac.authenticateBearer(bearerRequest(previewParent.apiKey, "default"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Pivots to the branch named "default", carrying the parent's api key.
    expect(result.environment.id).toBe(previewDefaultBranch.id);
    expect(result.environment.id).not.toBe(previewParent.id);
    expect(result.environment.apiKey).toBe(previewParent.apiKey);
  });
});
