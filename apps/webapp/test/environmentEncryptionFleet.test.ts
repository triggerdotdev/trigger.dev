import { randomBytes, randomUUID } from "node:crypto";
import { Redis, type RedisOptions } from "@internal/redis";
import { postgresAndRedisTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { $transaction } from "~/db.server";
import { EnvironmentEncryptionBackfill } from "~/services/environmentEncryption/backfill.server";
import { EnvironmentEncryptionService } from "~/services/environmentEncryption/service.server";
import { EnvironmentKeyWrapper } from "~/services/environmentEncryption/wrapping.server";
import { environmentSecretPrefix } from "~/services/environmentEncryption/secretStore.server";
import { encryptValue, resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
const wrapping = {
  wrappingProvider: "PLATFORM_KEYRING" as const,
  wrappingKeyReference: keyring.activeKeyId,
};
function encryption(db: PrismaClient) {
  return new EnvironmentEncryptionService({
    db,
    keyring,
    writesEnabled: true,
    defaultWrappingPolicy: wrapping,
    transaction: (fn) => $transaction(db, fn),
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
async function org(db: PrismaClient, enabled = true) {
  const data = await createTestOrgProjectWithMember(db);
  await db.organization.update({
    where: { id: data.organization.id },
    data: { featureFlags: { environmentEncryptionEnabled: enabled } },
  });
  return data;
}
function envData(id: string, data: Awaited<ReturnType<typeof org>>) {
  return {
    id,
    slug: id,
    projectId: data.project.id,
    organizationId: data.organization.id,
    apiKey: `api-${id}`,
    pkApiKey: `pk-${id}`,
    shortcode: `sc-${id}`,
    type: "PRODUCTION" as const,
  };
}
async function installKeys(db: PrismaClient, environments: Array<{ id: string }>) {
  const wrapper = new EnvironmentKeyWrapper(keyring);
  const keys = await Promise.all(
    environments.map(async (environment) => {
      const id = `key-${environment.id}`;
      const key = randomBytes(32);
      const wrapped = await wrapper.wrap(wrapping, environment.id, id, key);
      key.fill(0);
      return { id, environmentId: environment.id, ...wrapping, ...wrapped };
    })
  );
  await db.environmentEncryptionKey.createMany({ data: keys });
  await db.environmentEncryptionPolicy.createMany({
    data: keys.map((key) => ({
      environmentId: key.environmentId,
      activeKeyId: key.id,
      revision: 1,
      ...wrapping,
    })),
  });
}
async function finish(service: EnvironmentEncryptionBackfill, id: string) {
  const MAX_CONTINUATIONS = 20;
  for (let step = 0; step < MAX_CONTINUATIONS; step++) {
    if (!(await service.run(id))) return;
  }
  throw new Error("Fleet pass did not converge");
}

// Catches: overwriting existing keys/secrets, bypassing explicit org opt-outs, ignoring uninitialized policies, or chasing new environments indefinitely.
postgresAndRedisTest(
  "enrolls missing keys across orgs while respecting exclusions and the start boundary",
  async ({ prisma, redisOptions }) => {
    const target = await org(prisma);
    const excluded = await org(prisma, false);
    const already = await org(prisma);
    await prisma.runtimeEnvironment.createMany({
      data: [
        envData("a-uninitialized", target),
        envData("b-missing", target),
        envData("c-excluded", excluded),
        envData("d-already", already),
      ],
    });
    await prisma.environmentEncryptionPolicy.create({ data: { environmentId: "a-uninitialized" } });
    await installKeys(prisma, [{ id: "d-already" }]);
    const originalKey = await prisma.environmentEncryptionPolicy.findFirstOrThrow({
      where: { environmentId: "d-already" },
    });
    const original = encryptValue(JSON.stringify({ secret: "unchanged" }), keyring);
    const secretKey = `${environmentSecretPrefix(target.project.id, "a-uninitialized")}TOKEN`;
    await prisma.secretStore.create({ data: { key: secretKey, version: "2", value: original } });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const job = await service.createFleet("enroll", target.user.id, "");
      expect((await service.page())?.environments.map((env) => env.id)).toEqual([
        "a-uninitialized",
        "b-missing",
        "c-excluded",
      ]);
      await expect(service.createFleet("migrate", target.user.id, job.pageId)).rejects.toThrow(
        "active"
      );
      await expect(service.selectPage([target.organization.id], job.pageId)).rejects.toThrow(
        "active"
      );
      await prisma.runtimeEnvironment.create({ data: envData("zz-created-after-start", target) });
      await finish(service, job.id);
      const result = await service.current();
      expect(result?.status).toBe("completed");
      expect(result?.fleet).toMatchObject({
        completedPages: 1,
        completedEnvironments: 3,
        skippedEnvironments: 1,
        throughEnvironmentId: "d-already",
      });
      expect(await prisma.environmentEncryptionKey.count()).toBe(3);
      expect(
        (
          await prisma.environmentEncryptionPolicy.findFirstOrThrow({
            where: { environmentId: "d-already" },
          })
        ).activeKeyId
      ).toBe(originalKey.activeKeyId);
      expect(
        await prisma.environmentEncryptionPolicy.findFirst({
          where: { environmentId: "c-excluded", activeKeyId: { not: null } },
        })
      ).toBeNull();
      expect(
        await prisma.environmentEncryptionPolicy.findFirst({
          where: { environmentId: "zz-created-after-start" },
        })
      ).toBeNull();
      expect(
        (await prisma.secretStore.findFirstOrThrow({ where: { key: secretKey } })).value
      ).toEqual(original);
      await prisma.organization.update({
        where: { id: target.organization.id },
        data: { featureFlags: {} },
      });
      const disabled = await service.createFleet("enroll", target.user.id, result!.pageId);
      await finish(service, disabled.id);
      expect((await service.current())?.status).toBe("failed");
      expect((await service.current())?.fleet?.completedPages).toBe(0);
      expect(await prisma.environmentEncryptionKey.count()).toBe(3);
    } finally {
      await redis.quit();
    }
  }
);

// Catches: failing to auto-advance at 1,000 environments, advancing before verification, or missing retained build envelopes on later pages.
postgresAndRedisTest(
  "automatically applies and verifies successive enrolled-environment pages",
  async ({ prisma, redisOptions }) => {
    const target = await org(prisma);
    const rows = Array.from({ length: 1_001 }, (_, i) =>
      envData(`fleet-env-${String(i).padStart(4, "0")}`, target)
    );
    await prisma.runtimeEnvironment.createMany({ data: rows });
    await installKeys(prisma, rows);
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const key = `${environmentSecretPrefix(target.project.id, first.id)}TOKEN`;
    await prisma.secretStore.create({
      data: {
        key,
        version: "2",
        value: encryptValue(JSON.stringify({ secret: "runtime" }), keyring),
      },
    });
    const deployment = await prisma.workerDeployment.create({
      data: {
        projectId: target.project.id,
        environmentId: last.id,
        version: "v1",
        shortCode: "last",
        friendlyId: randomUUID(),
        contentHash: "hash",
        buildEnvVars: encryptValue(JSON.stringify({ TOKEN: "build" }), keyring),
      },
    });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const job = await service.createFleet("migrate", target.user.id, "");
      expect((await service.page())?.environments).toHaveLength(1_000);
      await expect(service.create("migrate", job.pageId, target.user.id)).rejects.toThrow(
        "fleet controls"
      );
      expect(await service.run(job.id)).toBe(true);
      expect((await service.current())?.fleet).toMatchObject({
        phase: "verify",
        completedPages: 0,
        pageProgress: { rewritten: 1 },
      });
      expect((await service.page())?.id).toBe(job.pageId);
      expect(await service.run(job.id)).toBe(true);
      expect((await service.current())?.fleet).toMatchObject({
        phase: "apply",
        completedPages: 1,
        completedEnvironments: 1_000,
        pageNumber: 2,
        pageSize: 1,
        rewritten: 1,
      });
      const secondPageId = (await service.page())!.id;
      expect(secondPageId).not.toBe(job.pageId);
      await service.stop(job.id);
      const resumed = await service.resumeFleet(job.id, target.user.id);
      expect(resumed.pageId).toBe(secondPageId);
      expect(resumed.fleet).toMatchObject({
        completedPages: 1,
        completedEnvironments: 1_000,
        rewritten: 1,
      });
      await finish(create(), job.id);
      expect((await service.current())?.status).toBe("completed");
      expect((await service.current())?.fleet).toMatchObject({
        completedPages: 2,
        completedEnvironments: 1_001,
        rewritten: 2,
        conflicts: 0,
      });
      expect(await service.run(job.id)).toBe(false);
      const stored = await prisma.secretStore.findFirstOrThrow({ where: { key } });
      const build = await prisma.workerDeployment.findFirstOrThrow({
        where: { id: deployment.id },
      });
      expect(
        await encryption(prisma).decryptMany([
          {
            projectId: target.project.id,
            value: stored.value,
            version: stored.version,
            context: { environmentId: first.id, purpose: "environment-variable", objectId: key },
          },
          {
            projectId: target.project.id,
            value: build.buildEnvVars,
            context: { environmentId: last.id, purpose: "build-env-vars", objectId: deployment.id },
          },
        ])
      ).toEqual([JSON.stringify({ secret: "runtime" }), JSON.stringify({ TOKEN: "build" })]);
    } finally {
      await redis.quit();
    }
  },
  120_000
);

// Catches: Stop losing its page checkpoint, resume generating new keys or skipping rows, or migration accidentally enrolling excluded candidates.
postgresAndRedisTest(
  "stops and resumes the current fleet page without touching unenrolled environments",
  async ({ prisma, redisOptions }) => {
    const target = await org(prisma);
    const rows = [
      envData("a-enrolled", target),
      envData("b-enrolled", target),
      envData("c-unenrolled", target),
    ];
    await prisma.runtimeEnvironment.createMany({ data: rows });
    await installKeys(prisma, rows.slice(0, 2));
    const prefix = environmentSecretPrefix(target.project.id, rows[0]!.id);
    const unownedKey = `${environmentSecretPrefix(target.project.id, rows[2]!.id)}UNCHANGED`;
    const original = encryptValue(JSON.stringify({ secret: "not-enrolled" }), keyring);
    await prisma.secretStore.createMany({
      data: [
        ...Array.from({ length: 30 }, (_, i) => ({
          key: `${prefix}${String(i).padStart(2, "0")}`,
          version: "1",
          value: { secret: `value-${i}` },
        })),
        { key: unownedKey, version: "2", value: original },
      ],
    });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const job = await service.createFleet("migrate", target.user.id, "");
      let writes = 0;
      const runner = create(async () => {
        if (++writes === 25) await service.stop(job.id);
      });
      expect(await runner.run(job.id)).toBe(false);
      expect((await service.current())?.status).toBe("stopped");
      expect((await service.page())?.id).toBe(job.pageId);
      expect(await prisma.secretStore.count({ where: { version: "environment-v1" } })).toBe(25);
      const resumed = await service.resumeFleet(job.id, target.user.id);
      expect(resumed.id).toBe(job.id);
      expect(resumed.pageId).toBe(job.pageId);
      await finish(create(), job.id);
      expect((await service.current())?.status).toBe("completed");
      expect((await service.current())?.fleet).toMatchObject({
        completedPages: 1,
        completedEnvironments: 2,
      });
      expect(await prisma.secretStore.count({ where: { version: "environment-v1" } })).toBe(30);
      expect(await prisma.environmentEncryptionKey.count()).toBe(2);
      expect(
        (await prisma.secretStore.findFirstOrThrow({ where: { key: unownedKey } })).value
      ).toEqual(original);
      await expect(service.resumeFleet(job.id, target.user.id)).rejects.toThrow(
        "stopped or failed"
      );
    } finally {
      await redis.quit();
    }
  }
);

// Catches: automatic advancement claiming success while a legacy write raced the preceding apply pass.
postgresAndRedisTest(
  "fails verification on late legacy writes and reapplies the same page on resume",
  async ({ prisma, redisOptions }) => {
    const target = await org(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: target.project.id,
      organizationId: target.organization.id,
      type: "PRODUCTION",
    });
    await installKeys(prisma, [environment]);
    const prefix = environmentSecretPrefix(target.project.id, environment.id);
    await prisma.secretStore.create({
      data: { key: `${prefix}ORIGINAL`, version: "1", value: { secret: "original" } },
    });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const job = await service.createFleet("migrate", target.user.id, "");
      expect(await service.run(job.id)).toBe(true);
      await prisma.secretStore.create({
        data: { key: `${prefix}LATE`, version: "1", value: { secret: "late" } },
      });
      expect(await service.run(job.id)).toBe(false);
      expect((await service.current())?.status).toBe("failed");
      expect((await service.current())?.progress.remaining).toBe(1);
      expect((await service.current())?.fleet?.completedPages).toBe(0);
      expect((await service.page())?.id).toBe(job.pageId);
      await service.resumeFleet(job.id, target.user.id);
      await finish(service, job.id);
      expect((await service.current())?.status).toBe("completed");
      expect((await service.current())?.fleet?.completedPages).toBe(1);
      expect(await prisma.secretStore.count({ where: { version: "environment-v1" } })).toBe(2);
    } finally {
      await redis.quit();
    }
  }
);

// Catches: crypto failures being hidden as deleted environments, or a genuinely deleted preview preventing fleet continuation forever.
postgresAndRedisTest(
  "stops on corrupt live data but safely skips a deleted environment on resume",
  async ({ prisma, redisOptions }) => {
    const target = await org(prisma);
    const rows = [envData("a-corrupt", target), envData("b-valid", target)];
    await prisma.runtimeEnvironment.createMany({ data: rows });
    await installKeys(prisma, rows);
    const corruptKey = `${environmentSecretPrefix(target.project.id, rows[0]!.id)}CORRUPT`;
    const original = encryptValue(JSON.stringify({ secret: "unchanged" }), keyring);
    const invalid = { ...original, tag: "00".repeat(16) };
    await prisma.secretStore.createMany({
      data: [
        { key: corruptKey, version: "2", value: invalid },
        {
          key: `${environmentSecretPrefix(target.project.id, rows[1]!.id)}VALID`,
          version: "1",
          value: { secret: "valid" },
        },
      ],
    });
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const job = await service.createFleet("migrate", target.user.id, "");
      expect(await service.run(job.id)).toBe(false);
      expect((await service.current())?.status).toBe("failed");
      expect((await service.current())?.fleet?.completedPages).toBe(0);
      expect(await prisma.secretStore.count({ where: { version: "environment-v1" } })).toBe(0);
      expect(
        (await prisma.secretStore.findFirstOrThrow({ where: { key: corruptKey } })).value
      ).toEqual(invalid);
      await prisma.runtimeEnvironment.delete({ where: { id: rows[0]!.id } });
      await service.resumeFleet(job.id, target.user.id);
      await finish(service, job.id);
      expect((await service.current())?.status).toBe("completed");
      expect((await service.current())?.fleet?.skippedEnvironments).toBeGreaterThan(0);
      expect(await prisma.secretStore.count({ where: { version: "environment-v1" } })).toBe(1);
      expect(
        (await prisma.secretStore.findFirstOrThrow({ where: { key: corruptKey } })).value
      ).toEqual(invalid);
    } finally {
      await redis.quit();
    }
  }
);

// Catches: a fleet pass spinning forever or leaving the global tool locked when no candidates exist.
postgresAndRedisTest(
  "completes empty enrollment and migration passes",
  async ({ prisma, redisOptions }) => {
    const { redis, create } = backfill(prisma, redisOptions);
    try {
      const service = create();
      const enrollment = await service.createFleet("enroll", "admin", "");
      expect(await service.run(enrollment.id)).toBe(false);
      expect((await service.current())?.status).toBe("completed");
      expect((await service.current())?.fleet?.completedPages).toBe(0);
      const migration = await service.createFleet("migrate", "admin", enrollment.pageId);
      expect(await service.run(migration.id)).toBe(false);
      expect((await service.current())?.status).toBe("completed");
      expect((await service.current())?.fleet?.completedEnvironments).toBe(0);
    } finally {
      await redis.quit();
    }
  }
);
