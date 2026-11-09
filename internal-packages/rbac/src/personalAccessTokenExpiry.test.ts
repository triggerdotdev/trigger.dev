import type { PrismaClient } from "@trigger.dev/database";
import type { PatAuthResult } from "@trigger.dev/plugins";
import { PERSONAL_ACCESS_TOKEN_EXPIRED, personalAccessTokenExpiry } from "@trigger.dev/plugins";
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

async function seedToken(prisma: PrismaClient, expiresAt: Date | null) {
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
  "host recheck uses a returned expiresAt without reading the token",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    // No row exists for this id, so a lookup would find nothing and treat it as not expiring.
    const result = await rejectExpiredPersonalAccessToken(
      { ...olderPluginResult("pat_missing", "user_missing"), expiresAt: new Date(0) },
      p
    );

    expect(result).toMatchObject({ ok: false, code: PERSONAL_ACCESS_TOKEN_EXPIRED });
  }
);

it("a token expires at the instant of its expiresAt", () => {
  const expiresAt = new Date("2026-12-01T00:00:00.000Z");

  expect(personalAccessTokenExpiry({ expiresAt }, new Date(expiresAt.getTime() - 1))).toBe(
    undefined
  );
  expect(personalAccessTokenExpiry({ expiresAt }, expiresAt)).toEqual({
    code: PERSONAL_ACCESS_TOKEN_EXPIRED,
    expiredAt: expiresAt,
  });
  expect(personalAccessTokenExpiry({ expiresAt: null }, new Date(8.64e15))).toBe(undefined);
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

/** Catches: the host no longer rechecking a plugin's PAT result, so an older plugin's "ok" for an
 * expired token gets through. */
postgresTest(
  "rbac.authenticatePat rejects an expired token that an older plugin accepted",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const expired = await seedToken(p, new Date(Date.now() - DAY_MS));
    const live = await seedToken(p, null);
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

    Object.assign(olderPlugin, { tokenId: live.row.id, userId: live.row.userId });
    await expect(controller.authenticatePat(patRequest(live.token), {})).resolves.toMatchObject({
      ok: true,
      expiresAt: null,
    });
  }
);
