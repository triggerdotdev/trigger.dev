import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import loader from "./index.js";

async function seedToken(prisma: PrismaClient, name: string) {
  const user = await prisma.user.create({
    data: { email: `${name}-${Date.now()}@example.test`, authenticationMethod: "MAGIC_LINK" },
  });
  const token = `tr_pat_${name}${"x".repeat(30)}`;
  await prisma.personalAccessToken.create({
    data: {
      name: "test",
      userId: user.id,
      encryptedToken: {},
      obfuscatedToken: "tr_pat_test",
      hashedToken: createHash("sha256").update(token).digest("hex"),
    },
  });
  return { token, userId: user.id };
}

function patRequest(token: string): Request {
  return new Request("https://example.test", { headers: { Authorization: `Bearer ${token}` } });
}

// Catches: a personal access token working for a user the host has denied.
postgresTest(
  "authenticatePat refuses a user the host denies, with its reason",
  async ({ prisma }) => {
    const p = prisma as PrismaClient;
    const denied = await seedToken(p, "denied");
    const allowed = await seedToken(p, "allowed");
    const controller = loader.create(p, {
      forceFallback: true,
      userAccessDenial: async (userId) => (userId === denied.userId ? "Set up MFA" : undefined),
    });

    await expect(controller.authenticatePat(patRequest(denied.token), {})).resolves.toEqual({
      ok: false,
      status: 403,
      error: "Set up MFA",
    });
    await expect(controller.authenticatePat(patRequest(allowed.token), {})).resolves.toMatchObject({
      ok: true,
      userId: allowed.userId,
    });
  }
);
