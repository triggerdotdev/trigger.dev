import { randomUUID } from "node:crypto";
import { Redis, type RedisOptions } from "@internal/redis";
import { postgresAndRedisTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
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
  const create = (afterWrite?: () => Promise<void>) =>
    new EnvironmentEncryptionBackfill({
      db,
      redis,
      encryption: encryption(db),
      transaction: async (fn) => {
        const result = await $transaction(db, fn);
        await afterWrite?.();
        return result;
      },
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

// Catches: enrollment changing values, verification losing earlier environments' remaining counts, premature advancement, or rewrites crossing page scope.
postgresAndRedisTest(
  "inspects, enrolls, migrates and cold-verifies the same selected page",
  async ({ prisma, redisOptions }) => {
    const target = await seed(prisma);
    const other = await seed(prisma);
    await prisma.runtimeEnvironment.create({
      data: {
        id: "zz-empty-after-values",
        slug: "empty",
        projectId: target.project.id,
        organizationId: target.organization.id,
        type: "STAGING",
        apiKey: randomUUID(),
        pkApiKey: randomUUID(),
        shortcode: "empty",
      },
    });
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
      const page = await service.selectPage([target.organization.id]);
      await expect(service.create("migrate", page.id, target.user.id)).rejects.toThrow("enrolled");
      const inspect = await service.create("inspect", page.id, target.user.id);
      await service.run(inspect.id);
      expect((await service.current())?.progress).toMatchObject({
        scanned: 3,
        remaining: 3,
        rewritten: 0,
      });
      expect(await prisma.environmentEncryptionPolicy.count()).toBe(0);
      const earlyVerify = await service.create("verify", page.id, target.user.id);
      await service.run(earlyVerify.id);
      expect(await service.pageVerified()).toBe(false);
      await expect(service.nextPage(page.id)).rejects.toThrow("Verify");

      const enroll = await service.create("enroll", page.id, target.user.id);
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
      const again = await service.create("enroll", page.id, target.user.id);
      await service.run(again.id);
      expect(await prisma.environmentEncryptionKey.count()).toBe(keyCount);
      const migrate = await service.create("migrate", page.id, target.user.id);
      await service.run(migrate.id);
      expect((await service.current())?.progress).toMatchObject({
        rewritten: 3,
        remaining: 0,
        runtimeValues: 2,
        buildEnvelopes: 1,
      });
      expect(await service.pageVerified()).toBe(false);
      const cold = create();
      const verify = await cold.create("verify", page.id, target.user.id);
      await cold.run(verify.id);
      expect((await cold.current())?.progress).toMatchObject({
        scanned: 3,
        remaining: 0,
        rewritten: 0,
      });
      expect(await cold.pageVerified()).toBe(true);
      expect((await cold.current())?.completedEnvironments).toBe(2);
      expect((await cold.page())?.id).toBe(page.id);
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

// Catches: Stop being ignored between batches, overlapping workers/pages, or retry changing the selected page/skipping unprocessed rows.
postgresAndRedisTest(
  "stops after a committed batch and safely retries the fixed page",
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
      const page = await service.selectPage([target.organization.id]);
      const enroll = await service.create("enroll", page.id, target.user.id);
      await service.run(enroll.id);
      const job = await service.create("migrate", page.id, target.user.id);
      let writes = 0;
      const runner = create(async () => {
        if (++writes !== 25) return;
        await expect(create().run(job.id)).rejects.toThrow("already running");
        await service.stop(job.id);
      });
      await expect(service.create("verify", page.id, target.user.id)).rejects.toThrow("active");
      await expect(service.selectPage([target.organization.id])).rejects.toThrow("active");
      await runner.run(job.id);
      expect((await service.current())?.status).toBe("stopped");
      expect((await service.current())?.completedEnvironments).toBe(0);
      expect(await service.pageVerified()).toBe(false);
      expect(await prisma.secretStore.count({ where: { version: "environment-v1" } })).toBe(25);
      const retry = await service.create("migrate", page.id, target.user.id);
      await service.run(retry.id);
      expect((await service.current())?.progress).toMatchObject({
        scanned: 30,
        rewritten: 5,
        conflicts: 0,
      });
      expect((await service.page())?.id).toBe(page.id);
      const verify = await create().create("verify", page.id, target.user.id);
      await create().run(verify.id);
      expect((await service.current())?.progress).toMatchObject({ scanned: 30, remaining: 0 });
      expect(await service.pageVerified()).toBe(true);
    } finally {
      await redis.quit();
    }
  },
  30_000
);

// Catches: unclaimed jobs blocking the tool permanently, or stale queue deliveries reviving them.
postgresAndRedisTest(
  "stops an unclaimed job and ignores its late delivery",
  async ({ prisma, redisOptions }) => {
    const target = await seed(prisma);
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const page = await service.selectPage([target.organization.id]);
      const abandoned = await service.create("enroll", page.id, target.user.id);
      await service.stop(abandoned.id);
      expect((await service.current())?.status).toBe("stopped");
      await service.run(abandoned.id);
      expect(await prisma.environmentEncryptionPolicy.count()).toBe(0);
      const next = await service.create("inspect", page.id, target.user.id);
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

// Catches: crypto failures being marked verified or advancing past the failing environment.
postgresAndRedisTest(
  "fails the page on unreadable ciphertext without changing it",
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
      const page = await service.selectPage([target.organization.id]);
      const environment = page.environments[0]!;
      const key = `${environmentSecretPrefix(environment.projectId, environment.id)}BAD`;
      const original = encryptValue(JSON.stringify({ secret: "do-not-expose" }), keyring);
      const invalid = { ...original, tag: "00".repeat(16) };
      await prisma.secretStore.create({ data: { key, version: "2", value: invalid } });
      const verify = await service.create("verify", page.id, target.user.id);
      await service.run(verify.id);
      const result = await service.current();
      expect(result?.status).toBe("failed");
      expect(result?.completedEnvironments).toBe(0);
      expect(result?.currentEnvironment?.id).toBe(environment.id);
      expect(JSON.stringify(result)).not.toContain("do-not-expose");
      expect((await prisma.secretStore.findUniqueOrThrow({ where: { key } })).value).toEqual(
        invalid
      );
      expect(await service.pageVerified()).toBe(false);
      await expect(service.nextPage(page.id)).rejects.toThrow("Verify");
    } finally {
      await redis.quit();
    }
  }
);

// Catches: large org rejection/truncation, unstable page scope, duplicate/skipped environments, or stale actions advancing a different page.
postgresAndRedisTest(
  "advances verified fixed pages without omissions and rejects stale page actions",
  async ({ prisma, redisOptions }) => {
    const firstOrg = await seed(prisma);
    const secondOrg = await seed(prisma);
    const [target, selectedOther] =
      firstOrg.organization.id < secondOrg.organization.id
        ? [firstOrg, secondOrg]
        : [secondOrg, firstOrg];
    const other = await seed(prisma);
    const envData = (id: string) => ({
      id,
      slug: id,
      projectId: target.project.id,
      organizationId: target.organization.id,
      apiKey: `api-${id}`,
      pkApiKey: `pk-${id}`,
      shortcode: `sc-${id}`,
      type: "PRODUCTION" as const,
    });
    await prisma.runtimeEnvironment.createMany({
      data: Array.from({ length: 1_000 }, (_, i) =>
        envData(`page-env-${String(i).padStart(4, "0")}`)
      ),
    });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const first = await service.selectPage([
        target.organization.id,
        selectedOther.organization.id,
      ]);
      expect(first.number).toBe(1);
      expect(first.environments).toHaveLength(1_000);
      expect(first.nextCursor).not.toBeNull();
      await expect(service.nextPage(first.id)).rejects.toThrow("Verify");
      await prisma.runtimeEnvironment.create({ data: envData("zz-new-environment") });
      const verify = await service.create("verify", first.id, target.user.id);
      await service.run(verify.id);
      expect((await service.current())?.completedEnvironments).toBe(1_000);
      expect(await service.pageVerified()).toBe(true);
      expect((await service.page())?.environments.map((env) => env.id)).toEqual(
        first.environments.map((env) => env.id)
      );
      const second = await service.nextPage(first.id);
      expect(second.number).toBe(2);
      expect(second.after).toEqual(first.nextCursor);
      expect(second.environments.map((env) => env.id)).toEqual([
        "page-env-0999",
        "zz-new-environment",
        selectedOther.environment.id,
      ]);
      expect(second.nextCursor).toBeNull();
      expect(
        [...first.environments, ...second.environments].some(
          (env) => env.id === other.environment.id
        )
      ).toBe(false);
      expect(await service.pageVerified()).toBe(false);
      await expect(service.create("enroll", first.id, target.user.id)).rejects.toThrow(
        "Page changed"
      );
      await expect(service.nextPage(first.id)).rejects.toThrow("Page changed");
      await expect(service.selectPage([target.organization.id], first.id)).rejects.toThrow(
        "Page changed"
      );
      await service.run(verify.id);
      expect((await service.page())?.id).toBe(second.id);
      const finalVerify = await service.create("verify", second.id, target.user.id);
      await service.run(finalVerify.id);
      expect((await service.current())?.completedEnvironments).toBe(3);
      expect(await service.pageVerified()).toBe(true);
      await expect(service.nextPage(second.id)).rejects.toThrow("No more pages");
    } finally {
      await redis.quit();
    }
  },
  60_000
);
