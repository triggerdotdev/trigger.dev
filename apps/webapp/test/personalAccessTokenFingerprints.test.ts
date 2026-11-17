import { afterEach, beforeEach, describe, expect, vi } from "vitest";

// Points the global client at the fixture's database; nothing else is replaced.
const db = vi.hoisted(() => ({ client: null as any }));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));
vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-for-pat-fingerprints",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      CLI_LOGIN_LEGACY_UNTIL: "2999-01-01T00:00:00.000Z",
    }),
  };
});

import { postgresTest } from "@internal/testcontainers";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import {
  createAuthorizationCode,
  createPersonalAccessToken,
  createPersonalAccessTokenFromAuthorizationCode,
  revokePersonalAccessToken,
} from "~/services/personalAccessToken.server";
import { hashToken } from "~/utils/tokens.server";
import { installAuditLogPlugin, uninstallAuditLogPlugin } from "./helpers/auditLogPlugin";

vi.setConfig({ testTimeout: 60_000 });

let userCounter = 0;

async function createUser(prisma: any) {
  userCounter += 1;
  return prisma.user.create({
    data: {
      email: `pat-fingerprints-${userCounter}-${Date.now()}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
}

describe("personal access token fingerprints", () => {
  beforeEach(() => {
    db.client = null;
  });
  afterEach(uninstallAuditLogPlugin);

  postgresTest(
    "creating a token saves it with no organization, and revoking marks it revoked",
    async ({ prisma }) => {
      db.client = prisma;
      const { saved, revoked } = installAuditLogPlugin();
      const user = await createUser(prisma);

      const created = await createPersonalAccessToken({
        name: "deploys",
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      await revokePersonalAccessToken(created.id, user.id);
      await auditLogs.flush();

      expect(saved).toEqual([
        {
          hash: hashToken(created.token),
          kind: "pat",
          organizationId: null,
          projectId: null,
          environmentId: null,
          credentialId: created.id,
          name: "deploys",
          last4: created.token.slice(-4),
          createdBy: { type: "user", id: user.id },
          createdAt: expect.any(Date),
          expiresAt: created.expiresAt,
        },
      ]);
      const stored = await prisma.personalAccessToken.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(revoked).toEqual([
        expect.objectContaining({
          hash: hashToken(created.token),
          reason: "revoked",
          revokedBy: { type: "user", id: user.id },
          revokedAt: stored.revokedAt,
        }),
      ]);
    }
  );

  // Catches: a token going live without a fingerprint.
  postgresTest("a failed fingerprint write creates no token", async ({ prisma }) => {
    db.client = prisma;
    installAuditLogPlugin({ failSaves: true });
    const user = await createUser(prisma);

    await expect(createPersonalAccessToken({ name: "deploys", userId: user.id })).rejects.toThrow(
      "Something went wrong. Please try again."
    );

    expect(await prisma.personalAccessToken.count({ where: { userId: user.id } })).toBe(0);
  });

  postgresTest("a CLI login saves the token it mints", async ({ prisma }) => {
    db.client = prisma;
    const { saved } = installAuditLogPlugin();
    const user = await createUser(prisma);
    const code = await createAuthorizationCode();

    const minted = await createPersonalAccessTokenFromAuthorizationCode(code.code, user.id);

    expect(saved).toEqual([
      expect.objectContaining({
        hash: hashToken(minted.token),
        kind: "pat",
        credentialId: minted.id,
        name: "cli",
      }),
    ]);
  });
});
