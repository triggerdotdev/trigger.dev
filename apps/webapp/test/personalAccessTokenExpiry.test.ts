import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dashboard-created personal access tokens carry an expiry. An expired token stops
 * authenticating and the request is told why; tokens without an expiry behave as before.
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
const mockEnv = vi.hoisted(() => ({
  CLI_LOGIN_IDLE_TIMEOUT_DAYS: 7,
}));

vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-for-pat-expiry",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      CLI_LOGIN_LEGACY_UNTIL: "2999-01-01T00:00:00.000Z",
      APP_ORIGIN: "https://dashboard.example.test",
      PERSONAL_ACCESS_TOKEN_EXPIRY_DAYS: [30, 90, 365],
      PERSONAL_ACCESS_TOKEN_DEFAULT_EXPIRY_DAYS: 90,
      get CLI_LOGIN_IDLE_TIMEOUT_DAYS() {
        return mockEnv.CLI_LOGIN_IDLE_TIMEOUT_DAYS;
      },
      CLI_LOGIN_NETWORK_CHECK: "off",
      // The built-in RBAC fallback, on the test database. An installed plugin would open its
      // own connection instead.
      RBAC_FORCE_FALLBACK: true,
    }),
  };
});

import { postgresTest } from "@internal/testcontainers";
import {
  assertSourcePatActive,
  authenticatePersonalAccessToken,
  createAuthorizationCode,
  createPersonalAccessToken,
  createPersonalAccessTokenFromAuthorizationCode,
  getPersonalAccessTokenExpiry,
  getValidPersonalAccessTokens,
  isAllowedPersonalAccessTokenExpiry,
  personalAccessTokenExpiryBody,
  personalAccessTokenExpiryOptions,
} from "~/services/personalAccessToken.server";
import { env } from "~/env.server";

vi.setConfig({ testTimeout: 60_000 });

const DAY_MS = 24 * 60 * 60 * 1000;

const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);

let userCounter = 0;

async function createUser(prisma: any) {
  userCounter += 1;
  return prisma.user.create({
    data: {
      email: `pat-expiry-${userCounter}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
}

function bearerRequest(token: string) {
  return new Request("https://api.example.test/api/v2/whoami", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function expire(prisma: any, tokenId: string, expiredAt: Date) {
  await prisma.personalAccessToken.update({
    where: { id: tokenId },
    data: { expiresAt: expiredAt },
  });
}

describe("personal access token expiry", () => {
  beforeEach(() => {
    db.client = null;
  });

  postgresTest(
    "a token created with an expiry date keeps it and reports it as validUntil",
    async ({ prisma }) => {
      db.client = prisma;
      const user = await createUser(prisma);
      const expiresAt = new Date(Date.now() + 30 * DAY_MS);

      const created = await createPersonalAccessToken({
        name: "ci",
        userId: user.id,
        expiresAt,
      });

      expect(created.expiresAt).toEqual(expiresAt);
      await expect(authenticatePersonalAccessToken(created.token)).resolves.toMatchObject({
        userId: user.id,
        tokenId: created.id,
        validUntil: created.expiresAt,
      });
    }
  );

  postgresTest("an expired token no longer authenticates", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const created = await createPersonalAccessToken({
      name: "ci",
      userId: user.id,
      expiresAt: inDays(30),
    });
    const expiredAt = new Date(Date.now() - 1000);
    await expire(prisma, created.id, expiredAt);

    await expect(authenticatePersonalAccessToken(created.token)).resolves.toBeUndefined();
    await expect(assertSourcePatActive({ pat: created.id } as any)).resolves.toBe(false);
    await expect(getPersonalAccessTokenExpiry(bearerRequest(created.token))).resolves.toEqual({
      code: "personal_access_token_expired",
      expiredAt,
    });

    const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.lastAccessedAt).toBeNull();
  });

  postgresTest("a token without an expiry behaves as before", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const created = await createPersonalAccessToken({ name: "cli", userId: user.id });

    expect(created.expiresAt).toBeNull();
    await expect(authenticatePersonalAccessToken(created.token)).resolves.toMatchObject({
      userId: user.id,
      validUntil: undefined,
    });
    await expect(assertSourcePatActive({ pat: created.id } as any)).resolves.toBe(true);
    await expect(
      getPersonalAccessTokenExpiry(bearerRequest(created.token))
    ).resolves.toBeUndefined();
  });

  postgresTest("the tokens page lists expired tokens as expired", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const live = await createPersonalAccessToken({
      name: "live",
      userId: user.id,
      expiresAt: inDays(90),
    });
    const old = await createPersonalAccessToken({
      name: "old",
      userId: user.id,
      expiresAt: inDays(30),
    });
    await expire(prisma, old.id, new Date(Date.now() - DAY_MS));

    const listed = await getValidPersonalAccessTokens(user.id);

    expect(listed.find((t) => t.id === live.id)).toMatchObject({ isExpired: false });
    expect(listed.find((t) => t.id === old.id)).toMatchObject({ isExpired: true });
  });

  postgresTest("the tokens page flags a token that expires within 7 days", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const soon = await createPersonalAccessToken({
      name: "soon",
      userId: user.id,
      expiresAt: inDays(30),
    });
    const later = await createPersonalAccessToken({
      name: "later",
      userId: user.id,
      expiresAt: inDays(30),
    });
    const old = await createPersonalAccessToken({
      name: "old",
      userId: user.id,
      expiresAt: inDays(30),
    });
    const never = await createPersonalAccessToken({ name: "cli", userId: user.id });
    await expire(prisma, soon.id, new Date(Date.now() + 3 * DAY_MS));
    await expire(prisma, later.id, new Date(Date.now() + 8 * DAY_MS));
    await expire(prisma, old.id, new Date(Date.now() - DAY_MS));

    const listed = await getValidPersonalAccessTokens(user.id);
    const flag = (id: string) => listed.find((t) => t.id === id)?.isExpiringSoon;

    expect(flag(soon.id)).toBe(true);
    expect(flag(later.id)).toBe(false);
    // Already expired, or never expiring: nothing to warn about.
    expect(flag(old.id)).toBe(false);
    expect(flag(never.id)).toBe(false);
  });

  postgresTest("an unknown or revoked token is not reported as expired", async ({ prisma }) => {
    db.client = prisma;
    const user = await createUser(prisma);
    const created = await createPersonalAccessToken({
      name: "ci",
      userId: user.id,
      expiresAt: inDays(30),
    });
    await expire(prisma, created.id, new Date(Date.now() - DAY_MS));
    await prisma.personalAccessToken.update({
      where: { id: created.id },
      data: { revokedAt: new Date() },
    });

    await expect(
      getPersonalAccessTokenExpiry(bearerRequest(created.token))
    ).resolves.toBeUndefined();
    await expect(
      getPersonalAccessTokenExpiry(bearerRequest(`tr_pat_${"z".repeat(40)}`))
    ).resolves.toBeUndefined();
  });
});

describe("personal access token expiry options and errors", () => {
  it("the expired error links to the public origin when one is set", () => {
    Object.assign(env, { PUBLIC_APP_ORIGIN: "https://public.example.test" });
    try {
      expect(
        personalAccessTokenExpiryBody({
          code: "personal_access_token_expired",
          expiredAt: new Date("2026-12-01T10:00:00.000Z"),
        }).error
      ).toContain("https://public.example.test/account/tokens");
    } finally {
      Object.assign(env, { PUBLIC_APP_ORIGIN: undefined });
    }
  });

  it("the expired error names the date and the tokens page", () => {
    const body = personalAccessTokenExpiryBody({
      code: "personal_access_token_expired",
      expiredAt: new Date("2026-12-01T10:00:00.000Z"),
    });

    expect(body).toEqual({
      error:
        "This personal access token expired on 2026-12-01 (UTC). Create a new one at https://dashboard.example.test/account/tokens.",
      code: "personal_access_token_expired",
    });
    expect(personalAccessTokenExpiryOptions()).toEqual({
      options: [
        { value: 30, label: "30 days" },
        { value: 90, label: "90 days" },
        { value: 365, label: "1 year" },
      ],
      defaultDays: 90,
      maxDays: 365,
    });
  });

  // Catches: a hand-made create request getting a far-future or past expiry, or the dashboard's
  // last offered day being rejected.
  it("any expiry from now to the end of the UTC day a year from today is accepted", () => {
    const now = new Date("2026-11-11T10:00:00.000Z");
    const allowed = (iso: string) => isAllowedPersonalAccessTokenExpiry(new Date(iso), now);

    // The end of a chosen day, as the dashboard sends it: today, a custom date, the longest.
    expect(allowed("2026-11-12T00:00:00.000Z")).toBe(true);
    expect(allowed("2027-02-08T00:00:00.000Z")).toBe(true);
    expect(allowed("2027-11-12T00:00:00.000Z")).toBe(true);

    expect(allowed("2026-11-11T10:00:00.000Z")).toBe(false);
    expect(allowed("2026-11-10T00:00:00.000Z")).toBe(false);
    expect(allowed("2027-11-12T00:00:00.001Z")).toBe(false);
    expect(allowed("2099-01-01T00:00:00.000Z")).toBe(false);
    expect(isAllowedPersonalAccessTokenExpiry(new Date(Number.NaN), now)).toBe(false);
  });
});

describe("CLI login token idle expiry", () => {
  beforeEach(() => {
    db.client = null;
  });

  async function cliLoginToken(prisma: any) {
    const user = await createUser(prisma);
    const code = await createAuthorizationCode();
    const minted = await createPersonalAccessTokenFromAuthorizationCode(code.code, user.id);
    return { user, minted };
  }

  async function lastUsed(prisma: any, tokenId: string, daysAgo: number) {
    const lastAccessedAt = new Date(Date.now() - daysAgo * DAY_MS);
    await prisma.personalAccessToken.update({ where: { id: tokenId }, data: { lastAccessedAt } });
    return lastAccessedAt;
  }

  postgresTest(
    "a CLI login token gets the idle timeout and no fixed expiry",
    async ({ prisma }) => {
      db.client = prisma;
      const { minted } = await cliLoginToken(prisma);

      const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: minted.id } });
      expect(row.idleTimeoutSeconds).toBe(7 * 24 * 60 * 60);
      expect(row.expiresAt).toBeNull();

      const [listed] = await getValidPersonalAccessTokens(row.userId);
      expect(listed).toMatchObject({ idleTimeoutLabel: "7 days", isExpired: false });
    }
  );

  postgresTest(
    "a CLI login token unused for over 7 days stops working, and the request doesn't revive it",
    async ({ prisma }) => {
      db.client = prisma;
      const { minted } = await cliLoginToken(prisma);
      const lastAccessedAt = await lastUsed(prisma, minted.id, 8);

      await expect(authenticatePersonalAccessToken(minted.token)).resolves.toBeUndefined();
      await expect(getPersonalAccessTokenExpiry(bearerRequest(minted.token))).resolves.toEqual({
        code: "cli_login_expired",
        expiredAt: new Date(lastAccessedAt.getTime() + 7 * DAY_MS),
      });
      await expect(assertSourcePatActive({ pat: minted.id } as any)).resolves.toBe(false);

      const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: minted.id } });
      expect(row.lastAccessedAt).toEqual(lastAccessedAt);
    }
  );

  postgresTest("a CLI login token used within 7 days keeps working", async ({ prisma }) => {
    db.client = prisma;
    const { user, minted } = await cliLoginToken(prisma);
    await lastUsed(prisma, minted.id, 6);

    const authenticated = await authenticatePersonalAccessToken(minted.token);
    expect(authenticated).toMatchObject({ userId: user.id });
    // Using it moves the idle window forward, and the result reports the new end of the window.
    const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: minted.id } });
    expect(Date.now() - row.lastAccessedAt!.getTime()).toBeLessThan(60_000);
    expect(authenticated?.validUntil).toEqual(new Date(row.lastAccessedAt!.getTime() + 7 * DAY_MS));
  });

  postgresTest(
    "with the idle timeout set to 0, a CLI login token has no idle limit",
    async ({ prisma }) => {
      db.client = prisma;
      mockEnv.CLI_LOGIN_IDLE_TIMEOUT_DAYS = 0;
      try {
        const { user, minted } = await cliLoginToken(prisma);
        await lastUsed(prisma, minted.id, 365);

        const row = await prisma.personalAccessToken.findUniqueOrThrow({
          where: { id: minted.id },
        });
        expect(row.idleTimeoutSeconds).toBeNull();
        await expect(authenticatePersonalAccessToken(minted.token)).resolves.toMatchObject({
          userId: user.id,
        });
      } finally {
        mockEnv.CLI_LOGIN_IDLE_TIMEOUT_DAYS = 7;
      }
    }
  );

  postgresTest("a CLI token minted before idle expiry is unaffected", async ({ prisma }) => {
    db.client = prisma;
    const { user, minted } = await cliLoginToken(prisma);
    await prisma.personalAccessToken.update({
      where: { id: minted.id },
      data: { idleTimeoutSeconds: null },
    });
    await lastUsed(prisma, minted.id, 365);

    await expect(authenticatePersonalAccessToken(minted.token)).resolves.toMatchObject({
      userId: user.id,
    });
  });

  postgresTest("the login-expired error tells the user to log in again", async () => {
    expect(
      personalAccessTokenExpiryBody({ code: "cli_login_expired", expiredAt: new Date() })
    ).toEqual({
      error:
        "Your CLI login expired because it wasn't used for a while. Run `npx trigger.dev@latest login` to log in again (add `--profile <name>` if you use a named profile). With an older CLI version, run `trigger.dev logout` first.",
      code: "cli_login_expired",
    });
  });
});
