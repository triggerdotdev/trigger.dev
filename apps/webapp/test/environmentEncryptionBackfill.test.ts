import { randomUUID } from "node:crypto";
import { Redis, type RedisOptions } from "@internal/redis";
import { postgresAndRedisTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";
import { $transaction } from "~/db.server";
import { EnvironmentEncryptionBackfill } from "~/services/environmentEncryption/backfill.server";
import { EnvironmentEncryptionService } from "~/services/environmentEncryption/service.server";
import { environmentSecretPrefix } from "~/services/environmentEncryption/secretStore.server";
import { encryptValue, resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
function encryption(db: PrismaClient) {
  return new EnvironmentEncryptionService({
    db,
    keyring,
    transaction: (fn) => $transaction(db, fn),
    writesEnabled: true,
    defaultWrappingPolicy: {
      wrappingProvider: "PLATFORM_KEYRING",
      wrappingKeyReference: keyring.activeKeyId,
    },
  });
}
function backfill(db: PrismaClient, redisOptions: RedisOptions) {
  const redis = new Redis({ ...redisOptions, keyPrefix: randomUUID() });
  const create = () =>
    new EnvironmentEncryptionBackfill({
      db,
      redis,
      encryption: encryption(db),
      transaction: (fn) => $transaction(db, fn),
    });
  return { redis, create };
}
async function seed(db: PrismaClient) {
  const data = await createTestOrgProjectWithMember(db);
  await db.organization.update({
    where: { id: data.organization.id },
    data: { featureFlags: { environmentEncryptionEnabled: true } },
  });
  const environment = await createRuntimeEnvironment(db, {
    projectId: data.project.id,
    organizationId: data.organization.id,
    type: "PRODUCTION",
  });
  return { ...data, environment, prefix: environmentSecretPrefix(data.project.id, environment.id) };
}

// Catches: enrollment rewriting secrets, verification enrolling environments, missing build envelopes, or crossing cohort boundaries.
postgresAndRedisTest(
  "inspects, enrolls, migrates and cold-verifies only the selected cohort",
  async ({ prisma, redisOptions }) => {
    const target = await seed(prisma);
    const other = await seed(prisma);
    const original = encryptValue(JSON.stringify({ secret: "runtime" }), keyring);
    const build = encryptValue(JSON.stringify({ TOKEN: "build" }), keyring);
    await prisma.secretStore.createMany({
      data: [
        { key: `${target.prefix}LEGACY`, version: "2", value: original },
        { key: `${target.prefix}PLAIN`, version: "1", value: { secret: "plain" } },
        { key: `${other.prefix}UNTOUCHED`, version: "2", value: original },
      ],
    });
    const deployment = await prisma.workerDeployment.create({
      data: {
        projectId: target.project.id,
        environmentId: target.environment.id,
        version: "v1",
        shortCode: "source",
        friendlyId: randomUUID(),
        contentHash: "hash",
        buildEnvVars: build,
      },
    });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const ids = [target.organization.id];
      await expect(service.create("migrate", ids, target.user.id)).rejects.toThrow("Enroll");
      const inspect = await service.create("inspect", ids, target.user.id);
      await service.run(inspect.id);
      expect((await service.current())?.environments[0]?.progress).toMatchObject({
        scanned: 3,
        remaining: 3,
        rewritten: 0,
      });
      expect(await prisma.environmentEncryptionPolicy.count()).toBe(0);

      const enroll = await service.create("enroll", ids, target.user.id);
      await service.run(enroll.id);
      expect((await service.current())?.status).toBe("completed");
      expect(
        (await prisma.secretStore.findUniqueOrThrow({ where: { key: `${target.prefix}LEGACY` } }))
          .value
      ).toEqual(original);
      expect(
        (await prisma.workerDeployment.findUniqueOrThrow({ where: { id: deployment.id } }))
          .buildEnvVars
      ).toEqual(build);
      const keyCount = await prisma.environmentEncryptionKey.count();
      const enrollAgain = await service.create("enroll", ids, target.user.id);
      await service.run(enrollAgain.id);
      expect(await prisma.environmentEncryptionKey.count()).toBe(keyCount);

      const migrate = await service.create("migrate", ids, target.user.id);
      await service.run(migrate.id);
      expect((await service.current())?.environments[0]?.progress).toMatchObject({
        rewritten: 3,
        remaining: 0,
        runtimeValues: 2,
        buildEnvelopes: 1,
      });
      const cold = create();
      const verify = await cold.create("verify", ids, target.user.id);
      await cold.run(verify.id);
      expect((await cold.current())?.environments[0]?.progress).toMatchObject({
        scanned: 3,
        remaining: 0,
        rewritten: 0,
      });
      const row = await prisma.secretStore.findUniqueOrThrow({
        where: { key: `${target.prefix}LEGACY` },
      });
      const storedBuild = await prisma.workerDeployment.findUniqueOrThrow({
        where: { id: deployment.id },
      });
      expect(
        await encryption(prisma).decryptMany([
          {
            projectId: target.project.id,
            value: row.value,
            version: row.version,
            context: {
              environmentId: target.environment.id,
              purpose: "environment-variable",
              objectId: row.key,
            },
          },
          {
            projectId: target.project.id,
            value: storedBuild.buildEnvVars,
            context: {
              environmentId: target.environment.id,
              purpose: "build-env-vars",
              objectId: deployment.id,
            },
          },
        ])
      ).toEqual([JSON.stringify({ secret: "runtime" }), JSON.stringify({ TOKEN: "build" })]);
      expect(
        (await prisma.secretStore.findUniqueOrThrow({ where: { key: `${other.prefix}UNTOUCHED` } }))
          .value
      ).toEqual(original);
      expect(
        await prisma.environmentEncryptionPolicy.findUnique({
          where: { environmentId: other.environment.id },
        })
      ).toBeNull();
    } finally {
      await redis.quit();
    }
  },
  30_000
);

// Catches: Stop being ignored between batches, overlapping workers/cohorts, or a retry skipping unprocessed values.
postgresAndRedisTest(
  "stops at a batch boundary and safely rescans on retry",
  async ({ prisma, redisOptions }) => {
    const target = await seed(prisma);
    await prisma.secretStore.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        key: `${target.prefix}VALUE_${String(i).padStart(2, "0")}`,
        version: "1",
        value: { secret: `value-${i}` },
      })),
    });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const ids = [target.organization.id];
      const enroll = await service.create("enroll", ids, target.user.id);
      await service.run(enroll.id);
      const job = await service.create("migrate", ids, target.user.id);
      const running = service.run(job.id);
      try {
        await vi.waitFor(
          async () => {
            expect((await service.current())?.environments[0]?.progress?.rewritten).toBe(25);
          },
          { timeout: 15_000, interval: 20 }
        );
        await expect(service.create("verify", ids, target.user.id)).rejects.toThrow("active");
        await expect(create().run(job.id)).rejects.toThrow("already running");
        await service.stop(job.id);
      } finally {
        await running;
      }
      expect((await service.current())?.status).toBe("stopped");
      expect(await prisma.secretStore.count({ where: { version: "environment-v1" } })).toBe(25);
      const retry = await service.create("migrate", ids, target.user.id);
      await service.run(retry.id);
      expect((await service.current())?.environments[0]?.progress).toMatchObject({
        scanned: 30,
        rewritten: 5,
        conflicts: 0,
      });
      const verify = await create().create("verify", ids, target.user.id);
      await create().run(verify.id);
      expect((await service.current())?.environments[0]?.progress).toMatchObject({
        scanned: 30,
        remaining: 0,
      });
    } finally {
      await redis.quit();
    }
  },
  30_000
);

// Catches: a job with no consuming worker permanently blocking new cohorts, or a late delivery reviving it.
postgresAndRedisTest(
  "stops an unclaimed job and ignores its late delivery",
  async ({ prisma, redisOptions }) => {
    const target = await seed(prisma);
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const ids = [target.organization.id];
      const abandoned = await service.create("enroll", ids, target.user.id);
      await service.stop(abandoned.id);
      expect((await service.current())?.status).toBe("stopped");
      await service.run(abandoned.id);
      expect(await prisma.environmentEncryptionPolicy.count()).toBe(0);
      const next = await service.create("inspect", ids, target.user.id);
      await service.run(abandoned.id);
      expect((await service.current())?.id).toBe(next.id);
      expect((await service.current())?.status).toBe("queued");
      await service.run(next.id);
      expect((await service.current())?.status).toBe("completed");
    } finally {
      await redis.quit();
    }
  }
);

// Catches: a crypto failure being treated as success or allowing the cohort to advance to another environment.
postgresAndRedisTest(
  "fails the cohort on unreadable ciphertext without changing it",
  async ({ prisma, redisOptions }) => {
    const target = await seed(prisma);
    await createRuntimeEnvironment(prisma, {
      projectId: target.project.id,
      organizationId: target.organization.id,
      type: "STAGING",
    });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const inspect = await service.create("inspect", [target.organization.id], target.user.id);
      const environment = inspect.environments[0]!;
      const key = `${environmentSecretPrefix(environment.projectId, environment.id)}BAD`;
      const original = encryptValue(JSON.stringify({ secret: "do-not-expose" }), keyring);
      const invalid = { ...original, tag: "00".repeat(16) };
      await prisma.secretStore.create({ data: { key, version: "2", value: invalid } });
      await service.run(inspect.id);
      const result = await service.current();
      expect(result?.status).toBe("failed");
      expect(result?.environments[1]?.status).toBe("pending");
      expect(JSON.stringify(result)).not.toContain("do-not-expose");
      expect((await prisma.secretStore.findUniqueOrThrow({ where: { key } })).value).toEqual(
        invalid
      );
    } finally {
      await redis.quit();
    }
  }
);
