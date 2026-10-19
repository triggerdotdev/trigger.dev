import { beforeEach, describe, expect, vi } from "vitest";

/**
 * A user-actor token is a stateless JWT good for up to seven days, so re-checking its source
 * personal access token is the only thing revocation has to act on. This helper owns that
 * recheck itself, since routes can reach it without a preamble that already did it.
 *
 * The source token lives in a real database here. The RBAC plugin is stubbed: what's under test
 * is the host-side recheck, which has to hold whatever claims the plugin hands back.
 */

const { SESSION_SECRET } = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-envvar-source-pat-recheck",
}));

const db = vi.hoisted(() => ({ client: null as any }));

const mocks = vi.hoisted(() => ({
  authenticatePat: vi.fn<(...args: any[]) => Promise<any>>(),
  authenticateUserActor: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET, ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticatePat: mocks.authenticatePat,
    authenticateUserActor: mocks.authenticateUserActor,
  },
}));

import { postgresTest } from "@internal/testcontainers";
import { signUserActorToken } from "@trigger.dev/rbac";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";

vi.setConfig({ testTimeout: 60_000 });

const allowEverything = { can: () => true };

let counter = 0;

async function createSourcePat(prisma: any) {
  counter += 1;
  const user = await prisma.user.create({
    data: {
      email: `envvar-source-pat-${counter}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  const pat = await prisma.personalAccessToken.create({
    data: {
      name: "cli",
      userId: user.id,
      encryptedToken: {},
      obfuscatedToken: "tr_pat_test••••••••••••••••••0000",
      hashedToken: `hashed-${counter}-${Date.now()}`,
    },
  });
  return { user, pat };
}

function requestWith(bearer: string) {
  return new Request("https://example.com/api/v1/projects/proj_1/envvars/prod", {
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

async function userActorRequest(userId: string, pat?: string) {
  const bearer = await signUserActorToken(SESSION_SECRET, {
    userId,
    client: "cli",
    ...(pat ? { pat } : {}),
  });
  return requestWith(bearer);
}

function authorize(request: Request) {
  return authorizePatEnvironmentAccess({
    request,
    authType: "personalAccessToken",
    organizationId: "org_1",
    projectId: "proj_1",
    envType: "PRODUCTION",
    resource: "envvars",
    action: "read",
  });
}

function pluginAccepts(userId: string, claims: Record<string, unknown>, can = () => true) {
  mocks.authenticateUserActor.mockResolvedValue({
    ok: true,
    userId,
    claims,
    subject: { type: "userActorToken" },
    ability: { can },
  });
}

describe("authorizePatEnvironmentAccess rechecks a user-actor token's source PAT", () => {
  beforeEach(() => {
    db.client = null;
    mocks.authenticatePat.mockReset();
    mocks.authenticateUserActor.mockReset();
    mocks.authenticatePat.mockResolvedValue({
      ok: true,
      tokenId: "pat_1234",
      userId: "usr_1",
      subject: { type: "personalAccessToken" },
      ability: allowEverything,
    });
  });

  postgresTest("allows while the source PAT is live", async ({ prisma }) => {
    db.client = prisma;
    const { user, pat } = await createSourcePat(prisma);
    pluginAccepts(user.id, { userId: user.id, pat: pat.id });

    expect(await authorize(await userActorRequest(user.id, pat.id))).toBeUndefined();
  });

  postgresTest("denies once the source PAT is revoked", async ({ prisma }) => {
    db.client = prisma;
    const { user, pat } = await createSourcePat(prisma);
    pluginAccepts(user.id, { userId: user.id, pat: pat.id });
    await prisma.personalAccessToken.update({
      where: { id: pat.id },
      data: { revokedAt: new Date() },
    });

    const response = await authorize(await userActorRequest(user.id, pat.id));

    expect(response?.status).toBe(401);
  });

  postgresTest(
    "rechecks the bearer's own source PAT even when the plugin omits it",
    async ({ prisma }) => {
      db.client = prisma;
      const { user, pat } = await createSourcePat(prisma);
      pluginAccepts(user.id, { userId: user.id });
      await prisma.personalAccessToken.update({
        where: { id: pat.id },
        data: { revokedAt: new Date() },
      });

      const response = await authorize(await userActorRequest(user.id, pat.id));

      expect(response?.status).toBe(401);
    }
  );

  postgresTest("allows a token that names no source PAT", async ({ prisma }) => {
    db.client = prisma;
    const { user } = await createSourcePat(prisma);
    pluginAccepts(user.id, { userId: user.id });

    expect(await authorize(await userActorRequest(user.id))).toBeUndefined();
  });

  postgresTest("leaves the plain PAT branch on its own authentication", async ({ prisma }) => {
    db.client = prisma;

    expect(await authorize(requestWith("tr_pat_abcdef"))).toBeUndefined();
    expect(mocks.authenticatePat).toHaveBeenCalled();
    expect(mocks.authenticateUserActor).not.toHaveBeenCalled();
  });

  postgresTest(
    "still enforces the environment-tier ability after the recheck passes",
    async ({ prisma }) => {
      db.client = prisma;
      const { user, pat } = await createSourcePat(prisma);
      pluginAccepts(user.id, { userId: user.id, pat: pat.id }, () => false);

      const response = await authorize(await userActorRequest(user.id, pat.id));

      expect(response?.status).toBe(403);
    }
  );
});
