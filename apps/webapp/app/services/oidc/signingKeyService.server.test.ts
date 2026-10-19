import { postgresTest } from "@internal/testcontainers";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  $transaction,
  type PrismaClient,
  type PrismaClientOrTransaction,
  type PrismaTransactionClient,
} from "@trigger.dev/database";
import { expect } from "vitest";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { OIDC_RETIRED_KEY_RETENTION_SECONDS } from "./constants";
import { verifyRs256Jwt } from "./crypto";
import { OidcSigningKeyService } from "./signingKeyService.server";

const issuer = "https://oidc.example.com";
const audience = "https://service.example.com";
const actor = "user_admin";
const migrationPath = fileURLToPath(
  new URL(
    "../../../../../internal-packages/database/prisma/migrations/20261009120000_oidc_signing_keys/migration.sql",
    import.meta.url
  )
);

// Test databases are built with `prisma db push`, which can't create the SQL-only partial index.
async function applyPartialUniqueIndex(prisma: PrismaClient) {
  const migration = await readFile(migrationPath, "utf8");
  const statement = migration
    .split("\n")
    .find((line) =>
      line.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS "OidcSigningKey_status_live_key"')
    );
  if (!statement) {
    throw new Error("Partial unique index not found in the OIDC migration");
  }
  await prisma.$executeRawUnsafe(statement);
}

function privateKeySecretCount(prisma: PrismaClient, kid: string) {
  return prisma.secretStore.count({ where: { key: `oidc-signing-key:${kid}` } });
}

function createService(prisma: PrismaClient, now: () => Date) {
  return new OidcSigningKeyService({
    db: prisma,
    issuer,
    now,
    secretStore: (db: PrismaClientOrTransaction) =>
      getSecretStore("DATABASE", { prismaClient: db }),
    runTransaction: async <Result>(
      _name: string,
      fn: (tx: PrismaTransactionClient) => Promise<Result>
    ) => {
      const result = await $transaction(
        prisma,
        async (tx) => ({ value: await fn(tx) }),
        () => {}
      );
      if (!result) {
        throw new Error("OIDC test transaction did not return a result");
      }
      return result.value;
    },
  });
}

postgresTest("stages, rotates, retires and disables real RSA signing keys", async ({ prisma }) => {
  await applyPartialUniqueIndex(prisma);
  let currentTime = new Date("2026-01-01T00:00:00.000Z");
  const service = createService(prisma, () => currentTime);

  await expect(
    service.signJwt({}, { audience, subject: "run_before", expiresInSeconds: 900 })
  ).rejects.toMatchObject({ code: "NO_ACTIVE_KEY" });
  await expect(service.getPublicJwks()).resolves.toEqual({ keys: [] });

  const firstStaged = await service.generateStagedKey(actor);
  expect(firstStaged).toMatchObject({
    status: "STAGED",
    generatedByUserId: actor,
    activatedAt: null,
  });
  await expect(service.activateKey(firstStaged.id, actor)).rejects.toMatchObject({
    code: "KEY_NOT_READY",
    readyAt: firstStaged.readyAt,
  });

  const storedSecret = await prisma.secretStore.findFirst({
    where: { key: `oidc-signing-key:${firstStaged.kid}` },
    select: { value: true, version: true },
  });
  expect(storedSecret?.version).toBe("2");
  expect(JSON.stringify(storedSecret?.value)).not.toContain("PRIVATE KEY");

  const stagedJwks = await service.getPublicJwks();
  expect(stagedJwks.keys).toHaveLength(1);
  expect(stagedJwks.keys[0]).toMatchObject({ kid: firstStaged.kid, use: "sig", alg: "RS256" });
  expect(stagedJwks.keys[0]).not.toHaveProperty("d");

  currentTime = firstStaged.readyAt;
  const firstActive = await service.activateKey(firstStaged.id, "user_activator_one");
  expect(firstActive).toMatchObject({
    status: "ACTIVE",
    activatedByUserId: "user_activator_one",
  });
  const firstToken = await service.signJwt(
    { workload: "first" },
    { audience, subject: "run_first", expiresInSeconds: 3_600 }
  );

  const secondStaged = await service.generateStagedKey("user_generator_two");
  const beforeRotationJwks = await service.getPublicJwks();
  expect(beforeRotationJwks.keys.map(({ kid }) => kid).sort()).toEqual(
    [firstStaged.kid, secondStaged.kid].sort()
  );

  currentTime = secondStaged.readyAt;
  const secondActive = await service.activateKey(secondStaged.id, "user_activator_two");
  const secondToken = await service.signJwt(
    { workload: "second" },
    { audience, subject: "run_second", expiresInSeconds: 3_600 }
  );
  const rotatedJwks = await service.getPublicJwks();

  await expect(
    verifyRs256Jwt({ token: firstToken, jwks: rotatedJwks, issuer, audience, now: currentTime })
  ).resolves.toMatchObject({ payload: { workload: "first", sub: "run_first" } });
  await expect(
    verifyRs256Jwt({ token: secondToken, jwks: rotatedJwks, issuer, audience, now: currentTime })
  ).resolves.toMatchObject({ payload: { workload: "second", sub: "run_second" } });
  for (const key of rotatedJwks.keys) {
    expect(Object.keys(key).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  }

  const rotatedStatus = await service.getSigningStatus();
  expect(rotatedStatus.activeKey).toMatchObject({
    id: secondActive.id,
    generatedByUserId: "user_generator_two",
    activatedByUserId: "user_activator_two",
  });
  expect(rotatedStatus.stagedKey).toBeNull();
  expect(rotatedStatus.retiredKeys[0]).toMatchObject({
    id: firstActive.id,
    retiredByUserId: "user_activator_two",
    publicUntil: new Date(currentTime.getTime() + OIDC_RETIRED_KEY_RETENTION_SECONDS * 1_000),
  });
  expect(await privateKeySecretCount(prisma, firstStaged.kid)).toBe(0);
  expect(await privateKeySecretCount(prisma, secondStaged.kid)).toBe(1);

  await service.disableSigning("user_disabler");
  await expect(
    service.signJwt({}, { audience, subject: "run_after", expiresInSeconds: 900 })
  ).rejects.toMatchObject({ code: "NO_ACTIVE_KEY" });
  const disabledStatus = await service.getSigningStatus();
  expect(disabledStatus.activeKey).toBeNull();
  expect(disabledStatus.retiredKeys).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: secondActive.id, retiredByUserId: "user_disabler" }),
      expect.objectContaining({ id: firstActive.id }),
    ])
  );
  expect((await service.getPublicJwks()).keys).toHaveLength(2);
  expect(await privateKeySecretCount(prisma, secondStaged.kid)).toBe(0);

  currentTime = new Date(currentTime.getTime() + OIDC_RETIRED_KEY_RETENTION_SECONDS * 1_000 + 1);
  await expect(service.getPublicJwks()).resolves.toEqual({ keys: [] });
});

postgresTest(
  "database rejects concurrent staged keys and a second active key",
  async ({ prisma }) => {
    await applyPartialUniqueIndex(prisma);

    let currentTime = new Date("2026-01-01T00:00:00.000Z");
    const service = createService(prisma, () => currentTime);

    const stagedResults = await Promise.allSettled([
      service.generateStagedKey("user_one"),
      service.generateStagedKey("user_two"),
    ]);
    expect(stagedResults.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = stagedResults.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "STAGED_KEY_EXISTS" }),
    });
    expect(await prisma.oidcSigningKey.count({ where: { status: "STAGED" } })).toBe(1);
    expect(
      await prisma.secretStore.count({
        where: { key: { startsWith: "oidc-signing-key:" } },
      })
    ).toBe(1);

    const staged = await prisma.oidcSigningKey.findFirst({
      where: { status: "STAGED" },
      select: { id: true, readyAt: true },
    });
    expect(staged).not.toBeNull();
    currentTime = staged!.readyAt;
    await service.activateKey(staged!.id, actor);

    await expect(
      prisma.oidcSigningKey.create({
        data: {
          kid: "duplicate-active",
          status: "ACTIVE",
          publicJwk: {},
          readyAt: currentTime,
          generatedByUserId: actor,
          activatedAt: currentTime,
          activatedByUserId: actor,
        },
      })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.oidcSigningKey.count({ where: { status: "ACTIVE" } })).toBe(1);
  }
);
