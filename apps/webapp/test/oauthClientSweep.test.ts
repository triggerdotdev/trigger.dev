import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { sweepOAuthClients } from "~/services/oauth/clientSweep.server";

const NOW = new Date("2026-10-13T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const old = new Date(NOW.getTime() - 40 * DAY);

// Catches: dropping the grant or pending-code guard (the FK restrict then fails the sweep), sweeping fresh or non-DCR clients.
postgresTest("deletes only expired DCR clients without a grant", async ({ prisma }) => {
  const mk = (clientId: string, data: object) =>
    prisma.oAuthClient.create({
      data: { kind: "DCR", clientId, redirectUris: [], createdAt: old, updatedAt: old, ...data },
    });
  await mk("expired-unused", {});
  await mk("metadata-expired", { metadataExpiresAt: new Date(NOW.getTime() - DAY) });
  await mk("fresh", { updatedAt: new Date(NOW.getTime() - DAY) });
  await mk("metadata-live", { metadataExpiresAt: new Date(NOW.getTime() + DAY) });
  const pending = await mk("pending-code", {});
  await prisma.authorizationCode.create({
    data: { code: "pending-code-hash", oauthClientId: pending.id },
  });
  await mk("preregistered", { kind: "PREREGISTERED" });
  const granted = await mk("granted", {});
  const user = await prisma.user.create({
    data: { email: "client-sweep@example.com", authenticationMethod: "MAGIC_LINK" },
  });
  await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: "client-sweep-pat",
      userId: user.id,
      oauthClientId: granted.id,
    },
  });

  expect(await sweepOAuthClients(prisma, NOW)).toEqual({ deleted: 2, failedChunks: 0 });

  const left = await prisma.oAuthClient.findMany({ select: { clientId: true } });
  expect(left.map((c) => c.clientId).sort()).toEqual([
    "fresh",
    "granted",
    "metadata-live",
    "pending-code",
    "preregistered",
  ]);
});
