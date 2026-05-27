import type { PrismaClient } from "@trigger.dev/database";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

// Must match ENCRYPTION_KEY in internal-packages/testcontainers/src/webapp.ts
const ENCRYPTION_KEY = "test-encryption-key-for-e2e!!!!!";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function encryptToken(value: string, key: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");
  return {
    nonce: nonce.toString("hex"),
    ciphertext: encrypted,
    tag: cipher.getAuthTag().toString("hex"),
  };
}

function obfuscate(token: string): string {
  return `${token.slice(0, 11)}${"•".repeat(20)}${token.slice(-4)}`;
}

export async function seedTestUser(prisma: PrismaClient, overrides?: { admin?: boolean }) {
  const suffix = randomBytes(6).toString("hex");
  return prisma.user.create({
    data: {
      email: `pat-user-${suffix}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      admin: overrides?.admin ?? false,
    },
  });
}

// Seeds a PersonalAccessToken row using the same hashing/encryption scheme as
// webapp's services/personalAccessToken.server.ts so the webapp subprocess can
// authenticate against it.
export async function seedTestPAT(
  prisma: PrismaClient,
  userId: string,
  opts: { revoked?: boolean } = {}
): Promise<{ token: string; id: string }> {
  const token = `tr_pat_${randomBytes(20).toString("hex")}`;
  const encrypted = encryptToken(token, ENCRYPTION_KEY);
  const row = await prisma.personalAccessToken.create({
    data: {
      name: "e2e-test-pat",
      userId,
      encryptedToken: encrypted,
      hashedToken: hashToken(token),
      obfuscatedToken: obfuscate(token),
      revokedAt: opts.revoked ? new Date() : null,
    },
  });
  return { token, id: row.id };
}
