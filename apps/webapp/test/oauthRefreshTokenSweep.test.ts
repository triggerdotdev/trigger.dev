import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { sweepOAuthRefreshTokens } from "~/services/oauth/refreshTokenSweep.server";

const NOW = new Date("2026-10-13T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const live = new Date(NOW.getTime() + DAY);
const idle = new Date(NOW.getTime() - DAY);
let counter = 0;

type Pat = { revokedAt?: Date; expiresAt?: Date };

// Handles are oldest first; the last one is the newest.
async function seedGrant(prisma: PrismaClient, pat: Pat, idleExpiries: Date[]) {
  counter += 1;
  const tag = `${counter}-${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `sweep-${tag}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const client = await prisma.oAuthClient.create({
    data: { kind: "DCR", clientId: `sweep-client-${tag}`, redirectUris: [] },
  });
  const token = await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: `sweep-pat-${tag}`,
      userId: user.id,
      oauthClientId: client.id,
      ...pat,
    },
  });
  const ids: string[] = [];
  for (const [i, idleExpiresAt] of idleExpiries.entries()) {
    const row = await prisma.oAuthRefreshToken.create({
      data: {
        hashedToken: `sweep-handle-${tag}-${i}`,
        personalAccessTokenId: token.id,
        oauthClientId: client.id,
        scope: [],
        resource: "https://mcp.example.com/mcp",
        idleExpiresAt,
        createdAt: new Date(NOW.getTime() - (idleExpiries.length - i) * 1000),
      },
    });
    ids.push(row.id);
  }
  return ids;
}

async function surviving(prisma: PrismaClient, ids: string[]) {
  const rows = await prisma.oAuthRefreshToken.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  return ids.filter((id) => rows.some((r) => r.id === id));
}

// Catches: deleting older idle handles of a live grant (kills reuse detection), keeping handles
// of a dead grant, or one grant's state leaking onto another's handles.
postgresTest.for([
  ["a live grant keeps older idle-expired handles", {}, [idle, idle, live], [0, 1, 2]],
  ["a grant whose newest handle is idle-expired loses all handles", {}, [live, idle, idle], []],
  ["a revoked grant loses all handles", { revokedAt: idle }, [live, live, live], []],
  ["an expired grant loses all handles", { expiresAt: idle }, [live, live], []],
] as const)("%s", async ([, pat, idleExpiries, kept], { prisma }) => {
  const dead = await seedGrant(prisma, { revokedAt: idle }, [live, live]);
  const ids = await seedGrant(prisma, pat, [...idleExpiries]);
  const healthy = await seedGrant(prisma, {}, [idle, live]);

  await sweepOAuthRefreshTokens(prisma, NOW);

  expect(await surviving(prisma, dead)).toEqual([]);
  expect(await surviving(prisma, ids)).toEqual(kept.map((i) => ids[i]));
  expect(await surviving(prisma, healthy)).toEqual(healthy);
});
