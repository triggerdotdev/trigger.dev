import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { z } from "zod";
import { PrismaSecretStore } from "~/services/secrets/secretStore.server";
import { parseEncryptionKeyring } from "~/utils/encryptionKeyring.server";

// Catches: losing keyId during persistence or parsing makes B-encrypted values unreadable.
postgresTest("round-trips a stored secret without the legacy key", async ({ prisma }) => {
  const keyring = parseEncryptionKeyring(
    JSON.stringify({
      activeKeyId: "v2",
      keys: {
        legacy: "0123456789abcdef0123456789abcdef",
        v2: "abcdef0123456789abcdef0123456789",
      },
    })
  );
  const writer = new PrismaSecretStore(keyring, { prismaClient: prisma });
  const value = { token: "unchanged-secret" };
  await writer.setSecret("rotation/token", value);
  const reader = new PrismaSecretStore(
    {
      activeKeyId: "v2",
      keys: new Map([["v2", keyring.keys.get("v2")!]]),
    },
    { prismaClient: prisma }
  );
  expect(await reader.getSecret(z.object({ token: z.string() }), "rotation/token")).toEqual(value);
});
