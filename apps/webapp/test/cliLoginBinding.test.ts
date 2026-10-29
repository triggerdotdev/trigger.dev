import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, vi } from "vitest";

/**
 * A CLI login code minted with a PKCE challenge only discloses its token to the client that
 * holds the verifier and the approval code, and the approval code only reaches the browser that
 * approved. So whoever mints a code can't collect the token of someone else who approves it.
 * Codes minted without a challenge work only until CLI_LOGIN_LEGACY_UNTIL.
 */

const db = vi.hoisted(() => ({ client: null as any }));
const mockEnv = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-cli-login-binding",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  CLI_LOGIN_LEGACY_UNTIL: "2000-01-01T00:00:00.000Z",
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));
vi.mock("~/env.server", () => ({ env: mockEnv }));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: { isUsingPlugin: async () => false, setTokenRole: async () => ({ ok: true }) },
}));

import { postgresTest } from "@internal/testcontainers";
import {
  CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
  createAuthorizationCode,
  createPersonalAccessTokenFromAuthorizationCode,
  getMintableAuthorizationCode,
  getPersonalAccessTokenFromAuthorizationCode,
  isLegacyCliLoginAllowed,
} from "~/services/personalAccessToken.server";

vi.setConfig({ testTimeout: 60_000 });

const INVALID = "Invalid authorization code, or code expired";

let userCounter = 0;

async function createUser(prisma: any) {
  userCounter += 1;
  return prisma.user.create({
    data: {
      email: `cli-login-binding-${userCounter}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
}

function pkce() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

async function boundLogin(userId: string, callbackPort?: number) {
  const { codeVerifier, codeChallenge } = pkce();
  const code = await createAuthorizationCode({ codeChallenge, callbackPort });
  const minted = await createPersonalAccessTokenFromAuthorizationCode(code.code, userId);
  return { code: code.code, codeVerifier, minted, approvalCode: minted.approval!.approvalCode };
}

describe("CLI login with a PKCE challenge", () => {
  beforeEach(() => {
    db.client = null;
    mockEnv.CLI_LOGIN_LEGACY_UNTIL = "2000-01-01T00:00:00.000Z";
  });

  postgresTest(
    "discloses the token once to the holder of the verifier and approval code",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      const login = await boundLogin(user.id);

      expect(login.approvalCode).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

      const disclosed = await getPersonalAccessTokenFromAuthorizationCode(login.code, {
        codeVerifier: login.codeVerifier,
        approvalCode: login.approvalCode,
      });
      expect(disclosed.token?.token).toBe(login.minted.token);

      await expect(
        getPersonalAccessTokenFromAuthorizationCode(login.code, {
          codeVerifier: login.codeVerifier,
          approvalCode: login.approvalCode,
        })
      ).rejects.toThrow(INVALID);
    }
  );

  postgresTest(
    "the minting client can't collect the token without the approval code",
    async ({ prisma }) => {
      db.client = prisma;
      const victim = await createUser(prisma);
      const attacker = pkce();

      const code = await createAuthorizationCode({ codeChallenge: attacker.codeChallenge });
      const approved = await createPersonalAccessTokenFromAuthorizationCode(code.code, victim.id);

      await expect(
        getPersonalAccessTokenFromAuthorizationCode(code.code, {
          codeVerifier: attacker.codeVerifier,
        })
      ).rejects.toThrow(INVALID);
      await expect(
        getPersonalAccessTokenFromAuthorizationCode(code.code, {
          codeVerifier: attacker.codeVerifier,
          approvalCode: "2222-2222-2222",
        })
      ).rejects.toThrow(INVALID);
      await expect(getPersonalAccessTokenFromAuthorizationCode(code.code)).rejects.toThrow(INVALID);

      const disclosed = await getPersonalAccessTokenFromAuthorizationCode(code.code, {
        codeVerifier: attacker.codeVerifier,
        approvalCode: approved.approval!.approvalCode,
      });
      expect(disclosed.token?.token).toBe(approved.token);
    }
  );

  postgresTest("rejects a wrong verifier even with the approval code", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const login = await boundLogin(user.id);

    await expect(
      getPersonalAccessTokenFromAuthorizationCode(login.code, {
        codeVerifier: pkce().codeVerifier,
        approvalCode: login.approvalCode,
      })
    ).rejects.toThrow(INVALID);
  });

  postgresTest("accepts the approval code as a user might type it", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const login = await boundLogin(user.id);

    const disclosed = await getPersonalAccessTokenFromAuthorizationCode(login.code, {
      codeVerifier: login.codeVerifier,
      approvalCode: ` ${login.approvalCode.replaceAll("-", "").toLowerCase()} `,
    });
    expect(disclosed.token?.token).toBe(login.minted.token);
  });

  postgresTest("reports an unapproved code as not ready yet", async ({ prisma }) => {
    db.client = prisma;
    const { codeVerifier, codeChallenge } = pkce();
    const code = await createAuthorizationCode({ codeChallenge });

    const disclosed = await getPersonalAccessTokenFromAuthorizationCode(code.code, {
      codeVerifier,
    });
    expect(disclosed.token).toBeNull();
  });

  postgresTest("hands the callback port back with the approval", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);

    const withCallback = await boundLogin(user.id, 54321);
    const withPaste = await boundLogin(user.id);

    expect(withCallback.minted.approval?.callbackPort).toBe(54321);
    expect(withPaste.minted.approval?.callbackPort).toBeNull();
  });
});

describe("CLI login without a PKCE challenge", () => {
  beforeEach(() => {
    db.client = null;
    mockEnv.CLI_LOGIN_LEGACY_UNTIL = "2000-01-01T00:00:00.000Z";
  });

  postgresTest(
    "works with the authorization code alone during the grace window",
    async ({ prisma }) => {
      db.client = prisma;
      mockEnv.CLI_LOGIN_LEGACY_UNTIL = new Date(Date.now() + 60_000).toISOString();
      const user = await createUser(prisma);

      const code = await createAuthorizationCode();
      expect(await getMintableAuthorizationCode(code.code)).toMatchObject({ legacy: true });

      const minted = await createPersonalAccessTokenFromAuthorizationCode(code.code, user.id);
      expect(minted.approval).toBeUndefined();

      const disclosed = await getPersonalAccessTokenFromAuthorizationCode(code.code);
      expect(disclosed.token?.token).toBe(minted.token);
    }
  );

  postgresTest("is refused after the grace window", async ({ prisma }) => {
    db.client = prisma;
    mockEnv.CLI_LOGIN_LEGACY_UNTIL = new Date(Date.now() + 60_000).toISOString();
    const user = await createUser(prisma);

    const approvedInGrace = await createAuthorizationCode();
    await createPersonalAccessTokenFromAuthorizationCode(approvedInGrace.code, user.id);
    const unapproved = await createAuthorizationCode();

    mockEnv.CLI_LOGIN_LEGACY_UNTIL = new Date(Date.now() - 1_000).toISOString();

    expect(isLegacyCliLoginAllowed()).toBe(false);
    expect(await getMintableAuthorizationCode(unapproved.code)).toBeNull();
    await expect(
      createPersonalAccessTokenFromAuthorizationCode(unapproved.code, user.id)
    ).rejects.toThrow(CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE);
    await expect(getPersonalAccessTokenFromAuthorizationCode(approvedInGrace.code)).rejects.toThrow(
      CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE
    );
  });
});
