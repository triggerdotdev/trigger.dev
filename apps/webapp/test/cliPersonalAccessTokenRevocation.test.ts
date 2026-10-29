import { beforeEach, describe, expect, vi } from "vitest";

/**
 * Every CLI login mints its own personal access token, and its authorization code discloses that
 * token exactly once. Revoking a CLI token is permanent: the revoked string never authenticates
 * or gets handed back out over the unauthenticated token endpoint.
 */

const db = vi.hoisted(() => ({ client: null as any }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));
vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET: "test-session-secret-for-cli-pat-revocation",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    CLI_LOGIN_LEGACY_UNTIL: "2999-01-01T00:00:00.000Z",
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: { isUsingPlugin: async () => false, setTokenRole: async () => ({ ok: true }) },
}));

import { postgresTest } from "@internal/testcontainers";
import {
  authenticatePersonalAccessToken,
  createAuthorizationCode,
  createPersonalAccessToken,
  createPersonalAccessTokenFromAuthorizationCode,
  getPersonalAccessTokenFromAuthorizationCode,
  revokePersonalAccessToken,
} from "~/services/personalAccessToken.server";

vi.setConfig({ testTimeout: 60_000 });

let userCounter = 0;

async function createUser(prisma: any) {
  userCounter += 1;
  return prisma.user.create({
    data: {
      email: `cli-pat-revocation-${userCounter}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
}

/** Runs the consent-screen mint the CLI login flow triggers, and returns what it minted. */
async function cliLogin(userId: string) {
  const code = await createAuthorizationCode();
  const minted = await createPersonalAccessTokenFromAuthorizationCode(code.code, userId);
  return { code: code.code, minted };
}

function secretOf(minted: unknown): string {
  return (minted as { token: string }).token;
}

describe("CLI personal access token revocation", () => {
  beforeEach(() => {
    db.client = null;
  });

  postgresTest("every login mints its own CLI token", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);

    const first = await cliLogin(user.id);
    const second = await cliLogin(user.id);

    expect(second.minted.id).not.toBe(first.minted.id);
    expect(secretOf(second.minted)).not.toBe(secretOf(first.minted));
    expect(
      await prisma.personalAccessToken.count({ where: { userId: user.id, revokedAt: null } })
    ).toBe(2);
    expect(await authenticatePersonalAccessToken(secretOf(first.minted))).toMatchObject({
      userId: user.id,
    });
  });

  postgresTest(
    "a second Authorize on the same code is rejected and leaves no extra live token",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);

      const login = await cliLogin(user.id);

      await expect(
        createPersonalAccessTokenFromAuthorizationCode(login.code, user.id)
      ).rejects.toThrow("Invalid authorization code, code already used, or code expired");
      expect(
        await prisma.personalAccessToken.count({ where: { userId: user.id, revokedAt: null } })
      ).toBe(1);
    }
  );

  postgresTest(
    "a revoked CLI token is not revived by a later login, and its secret stays rejected",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);

      const first = await cliLogin(user.id);
      const revokedSecret = secretOf(first.minted);
      expect(await authenticatePersonalAccessToken(revokedSecret)).toMatchObject({
        userId: user.id,
      });

      await revokePersonalAccessToken(first.minted.id, user.id);

      const second = await cliLogin(user.id);
      const freshSecret = secretOf(second.minted);

      expect(second.minted.id).not.toBe(first.minted.id);
      expect(freshSecret).not.toBe(revokedSecret);

      const revokedRow = await prisma.personalAccessToken.findFirst({
        where: { id: first.minted.id },
      });
      expect(revokedRow?.revokedAt).toBeInstanceOf(Date);
      expect(revokedRow?.name).toBe("cli");

      expect(await authenticatePersonalAccessToken(revokedSecret)).toBeUndefined();
      expect(await authenticatePersonalAccessToken(freshSecret)).toMatchObject({
        userId: user.id,
      });
    }
  );

  postgresTest("revoking again after re-login leaves both secrets dead", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);

    const first = await cliLogin(user.id);
    await revokePersonalAccessToken(first.minted.id, user.id);

    const second = await cliLogin(user.id);
    await revokePersonalAccessToken(second.minted.id, user.id);

    const third = await cliLogin(user.id);

    expect(third.minted.id).not.toBe(first.minted.id);
    expect(third.minted.id).not.toBe(second.minted.id);
    expect(await authenticatePersonalAccessToken(secretOf(first.minted))).toBeUndefined();
    expect(await authenticatePersonalAccessToken(secretOf(second.minted))).toBeUndefined();
  });

  postgresTest(
    "a token revoked under a different name does not block a fresh CLI login",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);

      const dashboardToken = await createPersonalAccessToken({ name: "laptop", userId: user.id });
      await revokePersonalAccessToken(dashboardToken.id, user.id);

      const login = await cliLogin(user.id);

      expect(login.minted.id).not.toBe(dashboardToken.id);
      expect(await authenticatePersonalAccessToken(dashboardToken.token)).toBeUndefined();
    }
  );
});

describe("the authorization code token endpoint", () => {
  beforeEach(() => {
    db.client = null;
  });

  postgresTest("discloses the token it minted", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);

    const login = await cliLogin(user.id);

    const disclosed = await getPersonalAccessTokenFromAuthorizationCode(login.code);
    expect(disclosed.token?.token).toBe(secretOf(login.minted));
  });

  postgresTest(
    "stops disclosing a token that was revoked after the code was bound",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);

      const login = await cliLogin(user.id);
      await revokePersonalAccessToken(login.minted.id, user.id);

      await expect(getPersonalAccessTokenFromAuthorizationCode(login.code)).rejects.toThrow(
        "Invalid authorization code, or code expired"
      );
    }
  );

  postgresTest("discloses the token only once", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);

    const login = await cliLogin(user.id);

    const disclosed = await getPersonalAccessTokenFromAuthorizationCode(login.code);
    expect(disclosed.token?.token).toBe(secretOf(login.minted));

    await expect(getPersonalAccessTokenFromAuthorizationCode(login.code)).rejects.toThrow(
      "Invalid authorization code, or code expired"
    );
  });

  postgresTest(
    "concurrent exchanges disclose the token to exactly one caller",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);

      const login = await cliLogin(user.id);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => getPersonalAccessTokenFromAuthorizationCode(login.code))
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    }
  );

  postgresTest("a login never discloses another login's token", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);

    const first = await cliLogin(user.id);
    const second = await cliLogin(user.id);

    const disclosed = await getPersonalAccessTokenFromAuthorizationCode(second.code);
    expect(disclosed.token?.token).toBe(secretOf(second.minted));
    expect(disclosed.token?.token).not.toBe(secretOf(first.minted));
  });

  postgresTest("reports an unapproved code as not ready yet", async ({ prisma }) => {
    db.client = prisma;

    const code = await createAuthorizationCode();

    const disclosed = await getPersonalAccessTokenFromAuthorizationCode(code.code);
    expect(disclosed.token).toBeNull();
  });
});
