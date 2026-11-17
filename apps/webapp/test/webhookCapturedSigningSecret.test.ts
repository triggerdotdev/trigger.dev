import { randomBytes } from "node:crypto";
import { postgresTest } from "@internal/testcontainers";
import { PrismaClient, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { WebhookEndpointId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { PrismaSecretStore, SecretStore } from "~/services/secrets/secretStore.server";
import { parseEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import { StoredSigningSecret } from "~/v3/webhookSigningSecret";
import {
  adoptCapturedWebhookSigningSecret,
  capturedWebhookSigningSecret,
  clearWebhookSigningSecret,
  hideCapturedWebhookSigningSecret,
  storeWebhookSigningSecret,
  webhookSigningSecretKey,
} from "~/v3/webhookSigningSecret.server";

const keyring = parseEncryptionKeyring(
  JSON.stringify({ activeKeyId: "v1", keys: { v1: "0123456789abcdef0123456789abcdef" } })
);

async function setup(prisma: PrismaClient) {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      friendlyId: WebhookEndpointId.generate().friendlyId,
      opaqueId: `op_${randomBytes(12).toString("hex")}`,
      organizationId: "org_test",
      projectId: "proj_test",
      runtimeEnvironmentId: "env_test",
      environmentType: "PRODUCTION",
      source: "notion",
      declaredId: "notion-events",
      routingTargets: [],
      verifierArtifact: {},
      status: "ACTIVE",
    },
  });
  // One client for both stores: the single-database install, where the secret-store writes share the
  // lock's transaction (and its one connection).
  const deps = {
    prisma,
    webhookPrisma: prisma,
    secretStoreFor: (client: PrismaClientOrTransaction) =>
      new SecretStore(new PrismaSecretStore(keyring, { prismaClient: client })),
  };
  const secretStore = deps.secretStoreFor(prisma);
  const key = webhookSigningSecretKey(endpoint.id);
  return {
    endpoint,
    deps,
    secretStore,
    key,
    storedSecret: async () => (await secretStore.getSecret(StoredSigningSecret, key))?.secret,
    secretKeyColumn: async () =>
      (await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }))
        .signingSecretKey,
  };
}

// Catches: a second verification request (another sender, or a retry with a new token) replacing
// the signing secret the endpoint already adopted.
postgresTest("adopts the first token and never replaces it", async ({ prisma }) => {
  const { endpoint, deps, key, storedSecret, secretKeyColumn } = await setup(prisma);

  expect(await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_first", deps)).toBe(true);
  expect(await secretKeyColumn()).toBe(key);
  expect(await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_second", deps)).toBe(false);
  expect(await storedSecret()).toBe("secret_first");
  expect((await capturedWebhookSigningSecret(endpoint.id, deps))?.secret).toBe("secret_first");
});

// Catches: a capture that stopped after storing the secret but before pointing the endpoint at it
// leaving every later request answered as if no secret were set.
postgresTest("recovers a capture interrupted before the endpoint update", async ({ prisma }) => {
  const { endpoint, deps, key, storedSecret, secretKeyColumn, secretStore } = await setup(prisma);
  await secretStore.createSecret(key, { secret: "secret_first", capturedAt: "x" });
  expect(await secretKeyColumn()).toBeNull();

  // The provider's retry of the same request succeeds and repairs the pointer.
  expect(await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_first", deps)).toBe(true);
  expect(await secretKeyColumn()).toBe(key);

  // A different token still can't replace it.
  expect(await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_other", deps)).toBe(false);
  expect(await storedSecret()).toBe("secret_first");
});

// Catches: a capture overwriting a secret the user set while the verification request was in
// flight.
postgresTest("never overwrites a secret set before the capture lands", async ({ prisma }) => {
  const { endpoint, deps, key, storedSecret, secretKeyColumn, secretStore } = await setup(prisma);
  await secretStore.setSecret(key, { secret: "manual_secret" });

  expect(await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_captured", deps)).toBe(false);
  expect(await storedSecret()).toBe("manual_secret");
  expect(await secretKeyColumn()).toBe(key);
  expect(await capturedWebhookSigningSecret(endpoint.id, deps)).toBeNull();
});

// Catches: hiding the captured token rewriting the signing secret, which restores the old secret
// when a rotation lands between the hide's read and write.
postgresTest("hiding the token leaves the signing secret untouched", async ({ prisma }) => {
  const { endpoint, deps, key, storedSecret, secretStore } = await setup(prisma);
  await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_captured", deps);

  await hideCapturedWebhookSigningSecret(endpoint.id, deps);
  expect(await capturedWebhookSigningSecret(endpoint.id, deps)).toBeNull();
  expect(await storedSecret()).toBe("secret_captured");

  // A rotation followed by a late hide keeps the rotated secret.
  await secretStore.setSecret(key, { secret: "secret_rotated" });
  await hideCapturedWebhookSigningSecret(endpoint.id, deps);
  expect(await storedSecret()).toBe("secret_rotated");
});

// Catches: an endpoint whose provider subscription was re-created staying locked to the old token,
// because a set secret refuses every new verification request.
postgresTest("clearing the secret lets the next token be captured", async ({ prisma }) => {
  const { endpoint, deps, storedSecret, secretKeyColumn } = await setup(prisma);
  await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_old", deps);
  await hideCapturedWebhookSigningSecret(endpoint.id, deps);

  await clearWebhookSigningSecret(endpoint.id, deps);
  expect(await secretKeyColumn()).toBeNull();
  expect(await storedSecret()).toBeUndefined();
  // Clearing twice is harmless, so an interrupted clear can be finished.
  await clearWebhookSigningSecret(endpoint.id, deps);

  expect(await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_new", deps)).toBe(true);
  expect(await storedSecret()).toBe("secret_new");
  expect((await capturedWebhookSigningSecret(endpoint.id, deps))?.secret).toBe("secret_new");
});

// Catches: overlapping clears, sets and captures leaving the endpoint pointing at a deleted secret
// (deliveries rejected, capture refused) or a stored secret it doesn't point at (the set reported
// success but deliveries are answered as if no secret were set).
postgresTest(
  "overlapping clears, sets and captures leave the endpoint cleared or using its stored secret",
  async ({ prisma }) => {
    const { endpoint, deps, key, storedSecret, secretKeyColumn } = await setup(prisma);

    for (let round = 0; round < 15; round++) {
      await Promise.all([
        clearWebhookSigningSecret(endpoint.id, deps),
        storeWebhookSigningSecret(endpoint, `secret_set_${round}`, {}, deps),
        clearWebhookSigningSecret(endpoint.id, deps),
        adoptCapturedWebhookSigningSecret(endpoint.id, `secret_captured_${round}`, deps),
      ]);
      const secret = await storedSecret();
      const pointer = await secretKeyColumn();
      expect(secret === undefined ? pointer === null : pointer === key).toBe(true);
    }
  }
);

// Catches: the lock's transaction holding the only pooled connection while a secret-store write on
// the same database waits for another, so every set, capture and clear times out on a
// single-database install with a one-connection pool.
postgresTest(
  "set, capture and clear complete with a one-connection pool",
  async ({ prisma, postgresContainer }) => {
    const { endpoint } = await setup(prisma);
    const uri = postgresContainer.getConnectionUri();
    const single = new PrismaClient({
      datasources: {
        db: { url: `${uri}${uri.includes("?") ? "&" : "?"}connection_limit=1&pool_timeout=5` },
      },
    });
    try {
      const deps = {
        prisma: single,
        webhookPrisma: single,
        secretStoreFor: (client: PrismaClientOrTransaction) =>
          new SecretStore(new PrismaSecretStore(keyring, { prismaClient: client })),
      };
      expect(await adoptCapturedWebhookSigningSecret(endpoint.id, "secret_captured", deps)).toBe(
        true
      );
      await storeWebhookSigningSecret(
        endpoint,
        "secret_set",
        { previousSecretTtlSeconds: 60 },
        deps
      );
      await clearWebhookSigningSecret(endpoint.id, deps);
      expect(
        (await single.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }))
          .signingSecretKey
      ).toBeNull();
    } finally {
      await single.$disconnect();
    }
  }
);
