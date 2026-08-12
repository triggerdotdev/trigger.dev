import { postgresTest } from "@internal/testcontainers";
import plugin, { signUserActorToken } from "@trigger.dev/rbac";
import { createHash } from "node:crypto";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { type PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import { generateAdditionalApiKey } from "~/utils/apiKeys";
import { createTestOrgProjectWithMember, uniqueId } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

// Exercises the RBAC *fallback* controller's bearer-auth branch pivot — the
// "new auth path" used by createLoaderApiRoute / createActionApiRoute. It
// mirrors findEnvironmentByApiKey, but is a separate implementation, so it
// needs its own coverage. forceFallback skips loading the closed-source plugin
// and uses the in-repo fallback directly.
function makeController(prisma: PrismaClient, additionalApiKeyLookupEnabled?: () => boolean) {
  return plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, additionalApiKeyLookupEnabled }
  );
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

describe("RBAC fallback — root key resolution", () => {
  it("reports an unknown root key as not found", async () => {
    const prisma = {
      runtimeEnvironment: { findFirst: vi.fn().mockResolvedValue(null) },
      revokedApiKey: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const rbac = makeController(prisma);

    const result = await rbac.authenticateBearer(bearerRequest("tr_prod_unknown"));

    expect(result).toMatchObject({
      ok: false,
      resolution: {
        credentialKind: "root_api_key",
        lookupPath: "not_found",
      },
    });
  });
});

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

  postgresTest(
    "the 'default' sentinel resolves the root dev env (no pivot)",
    async ({ prisma }) => {
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
    }
  );

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

  postgresTest(
    "a named branch that doesn't exist is rejected (not a fall-through)",
    async ({ prisma }) => {
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
      expect(result.error).toBe("No matching branch env");
    }
  );
});

describe("RBAC fallback — additional keys", () => {
  it("rejects a disabled additional-key lookup without querying", async () => {
    const runtimeEnvironmentFind = vi.fn();
    const revokedApiKeyFind = vi.fn();
    const apiKeyFind = vi.fn();
    const prisma = {
      runtimeEnvironment: { findFirst: runtimeEnvironmentFind },
      revokedApiKey: { findFirst: revokedApiKeyFind },
      apiKey: { findFirst: apiKeyFind },
    } as unknown as PrismaClient;
    const rbac = makeController(prisma, () => false);
    const key = "tr_prod_sk_0123456789abcdefghijklmn";

    await expect(rbac.authenticateBearer(bearerRequest(key))).resolves.toMatchObject({
      ok: false,
      resolution: {
        credentialKind: "additional_api_key",
        lookupPath: "additional_skipped",
      },
    });
    expect(runtimeEnvironmentFind).not.toHaveBeenCalled();
    expect(revokedApiKeyFind).not.toHaveBeenCalled();
    expect(apiKeyFind).not.toHaveBeenCalled();
  });

  postgresTest("rejects revoked and expired additional keys", async ({ prisma }) => {
    const { organization, project, orgMember, user } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const environment = await createEnv(prisma, project.id, organization.id, {
      type: "PRODUCTION",
      orgMemberId: orgMember.id,
    });
    const revoked = generateAdditionalApiKey("PRODUCTION").apiKey;
    const expired = generateAdditionalApiKey("PRODUCTION").apiKey;

    await prisma.apiKey.createMany({
      data: [
        {
          name: "Revoked deploy key",
          keyHash: createHash("sha256").update(revoked).digest("hex"),
          lastFour: revoked.slice(-4),
          runtimeEnvironmentId: environment.id,
          createdByUserId: user.id,
          scopes: ["admin"],
          revokedAt: new Date(),
        },
        {
          name: "Expired deploy key",
          keyHash: createHash("sha256").update(expired).digest("hex"),
          lastFour: expired.slice(-4),
          runtimeEnvironmentId: environment.id,
          createdByUserId: user.id,
          scopes: ["admin"],
          expiresAt: new Date(Date.now() - 1_000),
        },
      ],
    });

    await expect(rbac.authenticateBearer(bearerRequest(revoked))).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
    await expect(rbac.authenticateBearer(bearerRequest(expired))).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  postgresTest("authenticates an additional key and records its use", async ({ prisma }) => {
    const { organization, project, orgMember, user } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const environment = await createEnv(prisma, project.id, organization.id, {
      type: "PRODUCTION",
      orgMemberId: orgMember.id,
    });
    const additional = generateAdditionalApiKey("PRODUCTION").apiKey;

    await prisma.apiKey.create({
      data: {
        name: "External integration",
        keyHash: createHash("sha256").update(additional).digest("hex"),
        lastFour: additional.slice(-4),
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: null,
        scopes: ["admin"],
      },
    });
    const rootResult = await rbac.authenticateBearer(bearerRequest(environment.apiKey));
    const additionalResult = await rbac.authenticateBearer(bearerRequest(additional));

    expect(rootResult.ok).toBe(true);
    expect(additionalResult.ok).toBe(true);
    if (!additionalResult.ok) return;
    expect(additionalResult.environment.id).toBe(environment.id);
    expect(additionalResult.environment.apiKey).toBe(environment.apiKey);
    await expect(
      prisma.apiKey.findFirst({
        where: { keyHash: createHash("sha256").update(additional).digest("hex") },
        select: { lastUsedAt: true },
      })
    ).resolves.toMatchObject({ lastUsedAt: expect.any(Date) });
  });

  postgresTest("enforces restricted stored scopes on an additional key", async ({ prisma }) => {
    const { organization, project, orgMember, user } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const environment = await createEnv(prisma, project.id, organization.id, {
      type: "PRODUCTION",
      orgMemberId: orgMember.id,
    });
    const additional = generateAdditionalApiKey("PRODUCTION").apiKey;

    await prisma.apiKey.create({
      data: {
        name: "Task-scoped",
        keyHash: createHash("sha256").update(additional).digest("hex"),
        lastFour: additional.slice(-4),
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: "TRIGGER_ONLY",
        scopes: ["trigger:tasks:send-email"],
      },
    });

    const result = await rbac.authenticateBearer(bearerRequest(additional));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toMatchObject({ type: "apiKey", restricted: true });
    expect(result.ability.can("trigger", { type: "tasks", id: "send-email" })).toBe(true);
    expect(result.ability.can("trigger", { type: "tasks", id: "other-task" })).toBe(false);
    expect(result.ability.can("read", { type: "runs" })).toBe(false);
  });

  postgresTest("pivots an additional key to its branch environment", async ({ prisma }) => {
    const { organization, project, orgMember, user } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const devRoot = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
    });
    const branch = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
      parentEnvironmentId: devRoot.id,
      branchName: "api-key-policy",
    });
    const additional = generateAdditionalApiKey("DEVELOPMENT").apiKey;

    await prisma.apiKey.create({
      data: {
        name: "Branch key",
        keyHash: createHash("sha256").update(additional).digest("hex"),
        lastFour: additional.slice(-4),
        runtimeEnvironmentId: devRoot.id,
        createdByUserId: user.id,
        presetId: null,
        scopes: ["admin"],
      },
    });

    const result = await rbac.authenticateBearer(bearerRequest(additional, "api-key-policy"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment.id).toBe(branch.id);
    expect(result.environment.parentEnvironment?.id).toBe(devRoot.id);
    expect(result.subject).toMatchObject({ type: "apiKey", restricted: false });
  });

  postgresTest("does not record use when branch resolution fails", async ({ prisma }) => {
    const { organization, project, orgMember, user } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const devRoot = await createEnv(prisma, project.id, organization.id, {
      type: "DEVELOPMENT",
      orgMemberId: orgMember.id,
    });
    const additional = generateAdditionalApiKey("DEVELOPMENT").apiKey;
    const created = await prisma.apiKey.create({
      data: {
        name: "Branch key",
        keyHash: createHash("sha256").update(additional).digest("hex"),
        lastFour: additional.slice(-4),
        runtimeEnvironmentId: devRoot.id,
        createdByUserId: user.id,
        presetId: null,
        scopes: ["admin"],
      },
    });

    const result = await rbac.authenticateBearer(bearerRequest(additional, "missing-branch"));

    expect(result).toMatchObject({ ok: false, status: 401, error: "No matching branch env" });
    await expect(
      prisma.apiKey.findUnique({ where: { id: created.id }, select: { lastUsedAt: true } })
    ).resolves.toEqual({ lastUsedAt: null });
  });

  postgresTest("treats empty stored scopes as restricted and deny-all", async ({ prisma }) => {
    const { organization, project, orgMember, user } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const environment = await createEnv(prisma, project.id, organization.id, {
      type: "PRODUCTION",
      orgMemberId: orgMember.id,
    });
    const additional = generateAdditionalApiKey("PRODUCTION").apiKey;

    await prisma.apiKey.create({
      data: {
        name: "Empty policy",
        keyHash: createHash("sha256").update(additional).digest("hex"),
        lastFour: additional.slice(-4),
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: null,
        scopes: [],
      },
    });

    const result = await rbac.authenticateBearer(bearerRequest(additional));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toMatchObject({ type: "apiKey", restricted: true });
    expect(result.ability.can("read", { type: "runs" })).toBe(false);
    expect(result.ability.can("trigger", { type: "tasks", id: "send-email" })).toBe(false);
  });
});

describe("RBAC fallback — public JWTs", () => {
  postgresTest(
    "keeps tokens signed with a rotated root key valid for the grace window",
    async ({ prisma }) => {
      const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
      const rbac = makeController(prisma);
      const environment = await createEnv(prisma, project.id, organization.id, {
        type: "PRODUCTION",
        orgMemberId: orgMember.id,
      });
      const token = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
        expirationTime: "1h",
      });

      await expect(
        rbac.authenticateBearer(bearerRequest(token), { allowJWT: true })
      ).resolves.toMatchObject({ ok: true });

      // Rotate exactly as `regenerateApiKey` does: new value on the env, old
      // value parked in RevokedApiKey with a future expiry.
      const previousApiKey = environment.apiKey;
      await prisma.$transaction([
        prisma.revokedApiKey.create({
          data: {
            apiKey: previousApiKey,
            runtimeEnvironmentId: environment.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        }),
        prisma.runtimeEnvironment.update({
          where: { id: environment.id },
          data: { apiKey: uniqueId("tr_rotated") },
        }),
      ]);

      const graceResult = await rbac.authenticateBearer(bearerRequest(token), { allowJWT: true });
      expect(graceResult.ok).toBe(true);
      if (!graceResult.ok) return;
      expect(graceResult.environment.id).toBe(environment.id);
      expect(graceResult.ability.can("read", { type: "runs" })).toBe(true);
      expect(graceResult.ability.can("write", { type: "runs" })).toBe(false);
    }
  );

  postgresTest(
    "rejects a token signed with a rotated key once the grace window expires",
    async ({ prisma }) => {
      const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
      const rbac = makeController(prisma);
      const environment = await createEnv(prisma, project.id, organization.id, {
        type: "PRODUCTION",
        orgMemberId: orgMember.id,
      });
      const token = await generateJWT({
        secretKey: environment.apiKey,
        payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
        expirationTime: "1h",
      });

      await prisma.$transaction([
        prisma.revokedApiKey.create({
          data: {
            apiKey: environment.apiKey,
            runtimeEnvironmentId: environment.id,
            expiresAt: new Date(Date.now() - 60 * 1000),
          },
        }),
        prisma.runtimeEnvironment.update({
          where: { id: environment.id },
          data: { apiKey: uniqueId("tr_rotated") },
        }),
      ]);

      await expect(
        rbac.authenticateBearer(bearerRequest(token), { allowJWT: true })
      ).resolves.toMatchObject({ ok: false, status: 401 });
    }
  );

  postgresTest("surfaces public JWT actor attribution", async ({ prisma }) => {
    const { organization, project, orgMember, user } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const environment = await createEnv(prisma, project.id, organization.id, {
      type: "PRODUCTION",
      orgMemberId: orgMember.id,
    });
    const token = await generateJWT({
      secretKey: environment.apiKey,
      payload: {
        pub: true,
        sub: environment.id,
        scopes: ["read:runs"],
        act: { sub: user.id },
      },
      expirationTime: "1h",
    });

    const result = await rbac.authenticateBearer(bearerRequest(token), { allowJWT: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jwt?.act).toEqual({ sub: user.id });
  });

  postgresTest("rejects public JWTs for soft-deleted projects", async ({ prisma }) => {
    const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const environment = await createEnv(prisma, project.id, organization.id, {
      type: "PRODUCTION",
      orgMemberId: orgMember.id,
    });
    const token = await generateJWT({
      secretKey: environment.apiKey,
      payload: { pub: true, sub: environment.id, scopes: ["read:runs"] },
      expirationTime: "1h",
    });
    await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });

    const result = await rbac.authenticateBearer(bearerRequest(token), { allowJWT: true });

    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});

describe("RBAC fallback — additional key permissions", () => {
  postgresTest(
    "gives additional keys root-key-equivalent permissive access",
    async ({ prisma }) => {
      const { organization, project, orgMember, user } =
        await createTestOrgProjectWithMember(prisma);
      const rbac = makeController(prisma);
      const environment = await createEnv(prisma, project.id, organization.id, {
        type: "PRODUCTION",
        orgMemberId: orgMember.id,
      });
      const additional = generateAdditionalApiKey("PRODUCTION").apiKey;

      await prisma.apiKey.create({
        data: {
          name: "External integration",
          keyHash: createHash("sha256").update(additional).digest("hex"),
          lastFour: additional.slice(-4),
          runtimeEnvironmentId: environment.id,
          createdByUserId: user.id,
          presetId: null,
          scopes: ["admin"],
        },
      });

      const rootResult = await rbac.authenticateBearer(bearerRequest(environment.apiKey));
      const additionalResult = await rbac.authenticateBearer(bearerRequest(additional));

      expect(rootResult.ok).toBe(true);
      expect(additionalResult.ok).toBe(true);
      if (!rootResult.ok || !additionalResult.ok) return;

      expect(additionalResult.subject).toMatchObject({ type: "apiKey", restricted: false });
      for (const [action, resource] of [
        ["write", { type: "envvars" }],
        ["trigger", { type: "tasks", id: "send-email" }],
        ["read", { type: "runs", id: "run_123" }],
      ] as const) {
        expect(additionalResult.ability.can(action, resource)).toBe(
          rootResult.ability.can(action, resource)
        );
      }
    }
  );
});

describe("RBAC fallback — branch header guards", () => {
  postgresTest("preview environments require a branch header", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    const rbac = makeController(prisma);
    const previewParent = await createEnv(prisma, project.id, organization.id, {
      type: "PREVIEW",
      isBranchableEnvironment: true,
    });

    const result = await rbac.authenticateBearer(bearerRequest(previewParent.apiKey));

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      error: "x-trigger-branch header required for preview env",
      resolution: {
        credentialKind: "root_api_key",
        lookupPath: "root_current",
      },
    });
  });

  postgresTest(
    "allows branch management to authenticate against the preview parent",
    async ({ prisma }) => {
      const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
      const rbac = makeController(prisma);
      const previewParent = await createEnv(prisma, project.id, organization.id, {
        type: "PREVIEW",
        isBranchableEnvironment: true,
      });
      const additional = generateAdditionalApiKey("PREVIEW").apiKey;

      await prisma.apiKey.create({
        data: {
          name: "Deploy key",
          keyHash: createHash("sha256").update(additional).digest("hex"),
          lastFour: additional.slice(-4),
          runtimeEnvironmentId: previewParent.id,
          createdByUserId: user.id,
          presetId: "DEPLOY_ONLY",
          scopes: ["write:branches"],
        },
      });

      const result = await rbac.authenticateBearer(bearerRequest(additional), {
        allowPreviewParent: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.environment.id).toBe(previewParent.id);
      expect(result.ability.can("write", { type: "branches" })).toBe(true);
      expect(result.ability.can("write", { type: "deployments" })).toBe(false);
    }
  );

  // The "default" sentinel is DEVELOPMENT-only: it maps the dev root env to its
  // (branchless) self. For PREVIEW, "default" is an ordinary branch name, so a
  // PREVIEW branch literally named "default" is reachable and the request pivots
  // to it like any other branch. (Preview branch names are normally PR refs, so
  // a branch named "default" is unusual — but it's supported, not a collision.)
  postgresTest(
    "preview + 'default' pivots to the branch named 'default' (sentinel is dev-only)",
    async ({ prisma }) => {
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
    }
  );
});

const USER_ACTOR_SECRET = "test-user-actor-secret";

function userActorController(prisma: PrismaClient) {
  return plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, userActorSecret: USER_ACTOR_SECRET }
  );
}

describe("RBAC fallback — user-actor tokens", () => {
  const stubPrisma = {} as unknown as PrismaClient;

  it("grants a capped token only what its cap says", async () => {
    const rbac = userActorController(stubPrisma);
    const token = await signUserActorToken(USER_ACTOR_SECRET, {
      userId: "usr_1",
      client: "dashboard-agent",
      environmentId: "env_1",
      cap: ["read:runs", "read:apiKeys"],
    });

    const result = await rbac.authenticateUserActor(bearerRequest(token), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ability.can("read", { type: "runs" })).toBe(true);
    expect(result.ability.can("read", { type: "apiKeys" })).toBe(true);
    expect(result.ability.can("read", { type: "envvars" })).toBe(false);
    expect(result.ability.can("write", { type: "envvars" })).toBe(false);
    expect(result.ability.can("write", { type: "runs" })).toBe(false);
    expect(result.ability.canSuper()).toBe(false);
  });

  it("gives a token with no cap reads only, never writes", async () => {
    const rbac = userActorController(stubPrisma);
    const token = await signUserActorToken(USER_ACTOR_SECRET, {
      userId: "usr_1",
      client: "cli",
    });

    const result = await rbac.authenticateUserActor(bearerRequest(token), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ability.can("read", { type: "apiKeys" })).toBe(true);
    expect(result.ability.can("read", { type: "runs" })).toBe(true);
    expect(result.ability.can("write", { type: "envvars" })).toBe(false);
    expect(result.ability.can("write", { type: "runs" })).toBe(false);
    expect(result.ability.can("trigger", { type: "tasks" })).toBe(false);
    expect(result.ability.canSuper()).toBe(false);
  });

  it("carries the environment claim on the result and the subject", async () => {
    const rbac = userActorController(stubPrisma);
    const token = await signUserActorToken(USER_ACTOR_SECRET, {
      userId: "usr_1",
      client: "dashboard-agent",
      environmentId: "env_1",
    });

    const result = await rbac.authenticateUserActor(bearerRequest(token), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims?.environmentId).toBe("env_1");
    expect(result.subject).toMatchObject({ type: "userActor", environmentId: "env_1" });
  });

  postgresTest("leaves a personal access token permissive", async ({ prisma }) => {
    const { user } = await createTestOrgProjectWithMember(prisma);
    const rbac = userActorController(prisma);
    const pat = `tr_pat_${uniqueId("tok")}`;
    await prisma.personalAccessToken.create({
      data: {
        name: "cli",
        encryptedToken: {},
        obfuscatedToken: "tr_pat_****",
        hashedToken: createHash("sha256").update(pat).digest("hex"),
        userId: user.id,
      },
    });

    const result = await rbac.authenticatePat(bearerRequest(pat), {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ability.can("write", { type: "envvars" })).toBe(true);
    expect(result.ability.can("trigger", { type: "tasks" })).toBe(true);
  });
});
