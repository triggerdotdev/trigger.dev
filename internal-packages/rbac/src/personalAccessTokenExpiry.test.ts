import type { PrismaClient } from "@trigger.dev/database";
import type { PatAuthResult } from "@trigger.dev/plugins";
import {
  CLI_LOGIN_EXPIRED,
  PERSONAL_ACCESS_TOKEN_EXPIRED,
  personalAccessTokenExpiry,
  personalAccessTokenValidUntil,
} from "@trigger.dev/plugins";
import { postgresTest } from "@internal/testcontainers";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildJwtAbility } from "./ability.js";

// A stand-in for the cloud plugin, which isn't installed in this repo (as in
// apiKeyPolicyDefaults.test.ts). It's built against the contract from before PatAuthResult carried
// the expiry columns, so it accepts the token and returns none of them: only the host's recheck
// can reject an expired one. The tests below that use RoleBaseAccessFallback don't load it.
const olderPlugin = vi.hoisted(() => ({ tokenId: "", userId: "" }));

vi.mock("@triggerdotdev/plugins/rbac", async () => {
  const { buildJwtAbility } = await import("./ability.js");
  return {
    default: {
      create: () => ({
        isUsingPlugin: async () => true,
        authenticatePat: async () => ({
          ok: true,
          tokenId: olderPlugin.tokenId,
          userId: olderPlugin.userId,
          lastAccessedAt: null,
          subject: {
            type: "personalAccessToken",
            tokenId: olderPlugin.tokenId,
            organizationId: "",
          },
          ability: buildJwtAbility(["admin"]),
        }),
      }),
    },
  };
});

import { RoleBaseAccessFallback } from "./fallback.js";
import loader from "./index.js";
import { rejectExpiredPersonalAccessToken } from "./personalAccessTokenExpiry.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let tokenCounter = 0;

async function seedToken(
  prisma: PrismaClient,
  expiresAt: Date | null,
  idle: { idleTimeoutSeconds: number; lastAccessedAt: Date | null; createdAt?: Date } | null = null
) {
  tokenCounter += 1;
  const user = await prisma.user.create({
    data: {
      email: `pat-expiry-${tokenCounter}-${Date.now()}@example.test`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  const token = `tr_pat_expiry${tokenCounter}${"x".repeat(30)}`;
  const row = await prisma.personalAccessToken.create({
    data: {
      name: "test",
      userId: user.id,
      encryptedToken: {},
      obfuscatedToken: "tr_pat_test",
      hashedToken: createHash("sha256").update(token).digest("hex"),
      expiresAt,
      idleTimeoutSeconds: idle?.idleTimeoutSeconds,
      lastAccessedAt: idle?.lastAccessedAt,
      createdAt: idle?.createdAt,
    },
  });
  return { token, row };
}

function patRequest(token: string): Request {
  return new Request("https://example.test", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** What a plugin built before `expiresAt` was part of the contract returns. */
function olderPluginResult(tokenId: string, userId: string): Extract<PatAuthResult, { ok: true }> {
  return {
    ok: true,
    tokenId,
    userId,
    lastAccessedAt: null,
    subject: { type: "personalAccessToken", tokenId, organizationId: "" },
    ability: buildJwtAbility(["admin"]),
  };
}

postgresTest("fallback authenticatePat rejects an expired token", async ({ prisma }) => {
  const p = prisma as PrismaClient;
  const controller = new RoleBaseAccessFallback(p).create();
  const expiresAt = new Date(Date.now() - DAY_MS);
  const { token } = await seedToken(p, expiresAt);

  const result = await controller.authenticatePat(patRequest(token), {});

  expect(result).toMatchObject({
    ok: false,
    status: 401,
    code: PERSONAL_ACCESS_TOKEN_EXPIRED,
    expiredAt: expiresAt,
  });
  expect(!result.ok && result.error).toContain("expired on");
});

postgresTest(
  "fallback authenticatePat accepts tokens without expiry or not yet expired",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const controller = new RoleBaseAccessFallback(p).create();
    const neverExpires = await seedToken(p, null);
    const expiresLater = await seedToken(p, new Date(Date.now() + DAY_MS));

    const withoutExpiry = await controller.authenticatePat(patRequest(neverExpires.token), {});
    const notYetExpired = await controller.authenticatePat(patRequest(expiresLater.token), {});

    expect(withoutExpiry).toMatchObject({ ok: true, expiresAt: null });
    expect(notYetExpired).toMatchObject({ ok: true, expiresAt: expiresLater.row.expiresAt });
  }
);

postgresTest(
  "host recheck rejects an expired token an older plugin accepted",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const expired = await seedToken(p, new Date(Date.now() - DAY_MS));
    const live = await seedToken(p, null);

    const expiredResult = await rejectExpiredPersonalAccessToken(
      olderPluginResult(expired.row.id, expired.row.userId),
      p
    );
    const liveResult = await rejectExpiredPersonalAccessToken(
      olderPluginResult(live.row.id, live.row.userId),
      p
    );

    expect(expiredResult).toMatchObject({ ok: false, code: PERSONAL_ACCESS_TOKEN_EXPIRED });
    expect(liveResult).toMatchObject({ ok: true, expiresAt: null });
  }
);

postgresTest(
  "host recheck uses returned expiry columns without reading the token",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    // No row exists for this id, so a lookup would find nothing and treat it as not expiring.
    const result = await rejectExpiredPersonalAccessToken(
      {
        ...olderPluginResult("pat_missing", "user_missing"),
        expiresAt: new Date(0),
        idleTimeoutSeconds: null,
        createdAt: new Date(0),
      },
      p
    );

    expect(result).toMatchObject({ ok: false, code: PERSONAL_ACCESS_TOKEN_EXPIRED });
  }
);

const WEEK_SECONDS = 7 * 24 * 60 * 60;

postgresTest(
  "fallback authenticatePat rejects a CLI login token unused for longer than its idle timeout",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const controller = new RoleBaseAccessFallback(p).create();
    const lastAccessedAt = new Date(Date.now() - 8 * DAY_MS);
    const idle = await seedToken(p, null, { idleTimeoutSeconds: WEEK_SECONDS, lastAccessedAt });
    const neverUsed = await seedToken(p, null, {
      idleTimeoutSeconds: WEEK_SECONDS,
      lastAccessedAt: null,
      createdAt: new Date(Date.now() - 8 * DAY_MS),
    });

    const idleResult = await controller.authenticatePat(patRequest(idle.token), {});
    const neverUsedResult = await controller.authenticatePat(patRequest(neverUsed.token), {});

    expect(idleResult).toMatchObject({
      ok: false,
      status: 401,
      code: CLI_LOGIN_EXPIRED,
      expiredAt: new Date(lastAccessedAt.getTime() + WEEK_SECONDS * 1000),
    });
    expect(neverUsedResult).toMatchObject({ ok: false, code: CLI_LOGIN_EXPIRED });
  }
);

postgresTest(
  "fallback authenticatePat accepts a CLI login token used within its idle timeout",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const controller = new RoleBaseAccessFallback(p).create();
    const recent = await seedToken(p, null, {
      idleTimeoutSeconds: WEEK_SECONDS,
      lastAccessedAt: new Date(Date.now() - 6 * DAY_MS),
    });
    // Tokens minted before idle expiry existed have no idle timeout, however long unused.
    const legacy = await seedToken(p, null);
    await p.personalAccessToken.update({
      where: { id: legacy.row.id },
      data: { lastAccessedAt: new Date(Date.now() - 365 * DAY_MS) },
    });

    await expect(controller.authenticatePat(patRequest(recent.token), {})).resolves.toMatchObject({
      ok: true,
      idleTimeoutSeconds: WEEK_SECONDS,
    });
    await expect(controller.authenticatePat(patRequest(legacy.token), {})).resolves.toMatchObject({
      ok: true,
      idleTimeoutSeconds: null,
    });
  }
);

postgresTest(
  "host recheck rejects an idle CLI login token an older plugin accepted",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const idle = await seedToken(p, null, {
      idleTimeoutSeconds: WEEK_SECONDS,
      lastAccessedAt: new Date(Date.now() - 8 * DAY_MS),
    });

    // An older plugin returns no idle columns, so the host reads them.
    const result = await rejectExpiredPersonalAccessToken(
      { ...olderPluginResult(idle.row.id, idle.row.userId), expiresAt: null },
      p
    );

    expect(result).toMatchObject({ ok: false, code: CLI_LOGIN_EXPIRED });
  }
);

it("a token expires at the instant of its expiresAt", () => {
  const expiresAt = new Date("2026-12-01T00:00:00.000Z");

  const token = {
    expiresAt,
    idleTimeoutSeconds: null,
    lastAccessedAt: null,
    createdAt: new Date(0),
  };

  expect(personalAccessTokenExpiry(token, new Date(expiresAt.getTime() - 1))).toBe(undefined);
  expect(personalAccessTokenExpiry(token, expiresAt)).toEqual({
    code: PERSONAL_ACCESS_TOKEN_EXPIRED,
    expiredAt: expiresAt,
  });
  expect(personalAccessTokenExpiry({ ...token, expiresAt: null }, new Date(8.64e15))).toBe(
    undefined
  );
});

postgresTest(
  "host recheck denies a token an older plugin accepted but the host can't find",
  async ({ prisma }) => {
    const result = await rejectExpiredPersonalAccessToken(
      olderPluginResult("pat_missing", "user_missing"),
      prisma as PrismaClient
    );

    expect(result).toMatchObject({ ok: false, status: 401 });
  }
);

it("a token is valid until the earlier of its fixed and idle expiry", () => {
  const lastAccessedAt = new Date("2026-12-01T00:00:00.000Z");
  const idleEnd = new Date(lastAccessedAt.getTime() + 7 * DAY_MS);
  const cli = {
    expiresAt: null,
    idleTimeoutSeconds: WEEK_SECONDS,
    lastAccessedAt,
    createdAt: new Date(0),
  };

  expect(personalAccessTokenValidUntil(cli)).toEqual(idleEnd);
  expect(
    personalAccessTokenValidUntil({ ...cli, lastAccessedAt: null, createdAt: lastAccessedAt })
  ).toEqual(idleEnd);
  const earlierFixed = new Date(idleEnd.getTime() - DAY_MS);
  expect(personalAccessTokenValidUntil({ ...cli, expiresAt: earlierFixed })).toEqual(earlierFixed);
  expect(
    personalAccessTokenValidUntil({ ...cli, expiresAt: earlierFixed, idleTimeoutSeconds: null })
  ).toEqual(earlierFixed);
  expect(personalAccessTokenValidUntil({ ...cli, idleTimeoutSeconds: null })).toBeUndefined();
});

/** Catches: the host no longer rechecking a plugin's PAT result, so an older plugin's "ok" for an
 * expired token gets through. */
postgresTest(
  "rbac.authenticatePat rejects an expired or idle token that an older plugin accepted",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const expired = await seedToken(p, new Date(Date.now() - DAY_MS));
    const live = await seedToken(p, null);
    const idle = await seedToken(p, null, {
      idleTimeoutSeconds: WEEK_SECONDS,
      lastAccessedAt: new Date(Date.now() - 8 * DAY_MS),
    });
    const controller = loader.create(p);
    // Guard against a silent fallback: if the stand-in didn't load, the real fallback would
    // reject the expired token itself and this test would prove nothing about the host.
    await expect(controller.isUsingPlugin()).resolves.toBe(true);

    Object.assign(olderPlugin, { tokenId: expired.row.id, userId: expired.row.userId });
    await expect(controller.authenticatePat(patRequest(expired.token), {})).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: PERSONAL_ACCESS_TOKEN_EXPIRED,
    });

    Object.assign(olderPlugin, { tokenId: idle.row.id, userId: idle.row.userId });
    await expect(controller.authenticatePat(patRequest(idle.token), {})).resolves.toMatchObject({
      ok: false,
      status: 401,
      code: CLI_LOGIN_EXPIRED,
    });

    Object.assign(olderPlugin, { tokenId: live.row.id, userId: live.row.userId });
    await expect(controller.authenticatePat(patRequest(live.token), {})).resolves.toMatchObject({
      ok: true,
      expiresAt: null,
    });
  }
);
