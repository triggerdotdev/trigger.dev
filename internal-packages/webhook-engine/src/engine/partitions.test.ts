import { randomUUID } from "node:crypto";
import {
  containerTestWithIsolatedRedisNoClickhouse,
  createStandalonePostgresContainer,
  postgresTest,
} from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { WebhookEngine } from "./index.js";
import {
  addDays,
  bootstrapPartitions,
  createPartition,
  dayBucket,
  detachPartitionConcurrently,
  dropPartition,
  ensurePartitions,
  floorDayUTC,
  listDatedPartitions,
  partitionExists,
  partitionName,
  recoverInterruptedDetaches,
} from "./partitions.js";

// `prisma db push` builds WebhookDelivery as a plain table (partitioning lives only in the migration
// SQL), so recreate it as the partitioned parent (no DEFAULT, matching the migration) before
// exercising the in-app partition manager.
async function makePartitioned(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "WebhookDelivery" CASCADE`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "WebhookDelivery" (
      "id" TEXT NOT NULL,
      "friendlyId" TEXT NOT NULL,
      "webhookEndpointId" TEXT NOT NULL,
      "organizationId" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "runtimeEnvironmentId" TEXT NOT NULL,
      "environmentType" "RuntimeEnvironmentType" NOT NULL,
      "externalDeliveryId" TEXT NOT NULL,
      "idempotencyKey" TEXT NOT NULL,
      "runId" TEXT,
      "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
      "isTest" BOOLEAN NOT NULL DEFAULT false,
      "filterReason" TEXT,
      "parsedEvent" JSONB,
      "headers" JSONB,
      "rawBodyHash" TEXT,
      "errorMessage" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      "processedAt" TIMESTAMP(3),
      CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id","createdAt")
    ) PARTITION BY RANGE ("createdAt")`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX "WebhookDelivery_webhookEndpointId_createdAt_idx" ON "WebhookDelivery"("webhookEndpointId","createdAt" DESC)`
  );
}

postgresTest("ensurePartitions creates the window and is idempotent", async ({ prisma }) => {
  await makePartitioned(prisma);
  const now = new Date(Date.UTC(2026, 6, 15));

  const first = await ensurePartitions(prisma, { now, lookaheadDays: 7, retentionDays: 3 });
  // retention(3) back .. lookahead(7) forward, inclusive of both ends = 11 day buckets.
  expect(first.created).toHaveLength(11);
  expect(await partitionExists(prisma, partitionName(floorDayUTC(now)))).toBe(true);

  const second = await ensurePartitions(prisma, { now, lookaheadDays: 7, retentionDays: 3 });
  expect(second.created).toHaveLength(0);
  expect(second.existing).toHaveLength(11);
});

postgresTest("createPartition is created-then-exists", async ({ prisma }) => {
  await makePartitioned(prisma);
  const bucket = dayBucket(new Date(Date.UTC(2026, 7, 1)));

  expect(await createPartition(prisma, bucket)).toBe("created");
  expect(await createPartition(prisma, bucket)).toBe("exists");
  expect(await partitionExists(prisma, bucket.name)).toBe(true);
});

postgresTest(
  "concurrent ensurePartitions runs all finish with the full window and claim each partition once",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    const now = new Date(Date.UTC(2026, 8, 17));

    const results = await Promise.all([
      ensurePartitions(prisma, { now, lookaheadDays: 7, retentionDays: 3 }),
      ensurePartitions(prisma, { now, lookaheadDays: 7, retentionDays: 3 }),
      ensurePartitions(prisma, { now, lookaheadDays: 7, retentionDays: 3 }),
    ]);

    for (const result of results) {
      expect(result.created.length + result.existing.length).toBe(11);
    }
    const claimed = results.flatMap((r) => r.created);
    expect(claimed).toHaveLength(11);
    expect(new Set(claimed).size).toBe(11);
    expect(await partitionExists(prisma, partitionName(floorDayUTC(now)))).toBe(true);
    expect(await listDatedPartitions(prisma)).toHaveLength(11);
  }
);

postgresTest("detachPartitionConcurrently then drop removes a partition", async ({ prisma }) => {
  await makePartitioned(prisma);
  const bucket = dayBucket(new Date(Date.UTC(2026, 0, 1)));
  await createPartition(prisma, bucket);
  expect(await partitionExists(prisma, bucket.name)).toBe(true);

  await detachPartitionConcurrently(prisma, bucket.name);
  await dropPartition(prisma, bucket.name);
  expect(await partitionExists(prisma, bucket.name)).toBe(false);
});

postgresTest("ensurePartitions drops children past the retention window", async ({ prisma }) => {
  await makePartitioned(prisma);
  const now = new Date(Date.UTC(2026, 6, 15));

  const old = dayBucket(addDays(floorDayUTC(now), -30));
  await createPartition(prisma, old);
  expect(await partitionExists(prisma, old.name)).toBe(true);

  const result = await ensurePartitions(prisma, { now, lookaheadDays: 7, retentionDays: 3 });
  expect(result.dropped).toContain(old.name);
  expect(result.deferred).toHaveLength(0);
  expect(await partitionExists(prisma, old.name)).toBe(false);
  expect((await listDatedPartitions(prisma)).some((p) => p.name === old.name)).toBe(false);
});

postgresTest(
  "recoverInterruptedDetaches drops a detached-but-not-dropped leftover",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    // A crash between DETACH and DROP leaves a standalone dated table that's no longer a partition.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "WebhookDelivery_2020_01_01" (LIKE "WebhookDelivery")`
    );
    expect(await partitionExists(prisma, "WebhookDelivery_2020_01_01")).toBe(true);
    // Not a partition, so the manager doesn't list it among dated partitions.
    expect(
      (await listDatedPartitions(prisma)).some((p) => p.name === "WebhookDelivery_2020_01_01")
    ).toBe(false);

    await recoverInterruptedDetaches(prisma);
    expect(await partitionExists(prisma, "WebhookDelivery_2020_01_01")).toBe(false);
  }
);

postgresTest(
  "bootstrap targets the webhook database, preserves old partitions, and hands off to cron",
  async ({ prisma }) => {
    const { container, url } = await createStandalonePostgresContainer();
    const webhookDb = new PrismaClient({ datasources: { db: { url } } });
    try {
      await makePartitioned(prisma);
      await makePartitioned(webhookDb);
      const now = new Date(Date.UTC(2026, 8, 18));
      const old = dayBucket(addDays(now, -30));
      await createPartition(webhookDb, old);
      const opts = { now, lookaheadDays: 10, retentionDays: 3 };

      const first = await bootstrapPartitions(webhookDb, opts);
      expect(first.created).toHaveLength(14);
      expect(await partitionExists(webhookDb, old.name)).toBe(true);
      expect(await listDatedPartitions(prisma)).toEqual([]);

      const second = await bootstrapPartitions(webhookDb, opts);
      expect(second.created).toEqual([]);
      expect(second.existing).toEqual(first.created);

      const maintained = await ensurePartitions(webhookDb, opts);
      expect(maintained.created).toEqual([]);
      expect(maintained.existing).toEqual(first.created);
      expect(maintained.dropped).toEqual([old.name]);
      expect(await listDatedPartitions(prisma)).toEqual([]);
    } finally {
      await webhookDb.$disconnect();
      await container.stop();
    }
  },
  120_000
);

postgresTest(
  "bootstrap rejects a standalone table with the requested partition name",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    const now = new Date(Date.UTC(2026, 8, 18));
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "WebhookDelivery_2026_09_18" (LIKE "WebhookDelivery")`
    );
    await expect(
      bootstrapPartitions(prisma, { now, lookaheadDays: 0, retentionDays: 0 })
    ).rejects.toThrow("WebhookDelivery_2026_09_18 is not attached");
    // Bootstrap reports the conflict without deleting the operator's existing table.
    expect(await partitionExists(prisma, partitionName(now))).toBe(true);
  }
);

postgresTest("bootstrap rejects an attached child with incorrect bounds", async ({ prisma }) => {
  await makePartitioned(prisma);
  const now = new Date(Date.UTC(2026, 8, 18));
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "WebhookDelivery_2026_09_18" PARTITION OF "WebhookDelivery"
      FOR VALUES FROM ('2026-09-19') TO ('2026-09-20')`
  );
  await expect(
    bootstrapPartitions(prisma, { now, lookaheadDays: 0, retentionDays: 0 })
  ).rejects.toThrow("expected UTC bounds");
  expect(await partitionExists(prisma, partitionName(now))).toBe(true);
});

containerTestWithIsolatedRedisNoClickhouse(
  "bootstrap and scheduled maintenance use the owner connection while app queries use the data role",
  async ({ prisma, postgresContainer, redisOptions }) => {
    await makePartitioned(prisma);
    const suffix = randomUUID().replace(/-/g, "");
    const appRole = `webhook_app_${suffix}`;
    const ownerRole = `webhook_owner_${suffix}`;
    const password = randomUUID();
    const clientFor = (role: string) => {
      const url = new URL(postgresContainer.getConnectionUri());
      url.username = role;
      url.password = password;
      url.searchParams.set("connection_limit", "1");
      return new PrismaClient({ datasources: { db: { url: url.href } } });
    };
    const app = clientFor(appRole);
    const owner = clientFor(ownerRole);
    let engine: WebhookEngine | undefined;
    try {
      await prisma.$executeRawUnsafe(`CREATE ROLE "${appRole}" LOGIN PASSWORD '${password}'`);
      await prisma.$executeRawUnsafe(`CREATE ROLE "${ownerRole}" LOGIN PASSWORD '${password}'`);
      await prisma.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await prisma.$executeRawUnsafe(
        `GRANT USAGE ON SCHEMA public TO "${appRole}", "${ownerRole}"`
      );
      await prisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${ownerRole}"`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "WebhookDelivery" OWNER TO "${ownerRole}"`);
      await prisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "WebhookEndpoint", "WebhookDelivery" TO "${appRole}"`
      );

      const now = floorDayUTC(new Date());
      const opts = { now, lookaheadDays: 0, retentionDays: 0 };
      await expect(bootstrapPartitions(app, opts)).rejects.toThrow(
        /permission denied|must be owner/i
      );
      // The owner cannot read endpoints, so an engine using it for normal queries will fail below.
      await expect(owner.webhookEndpoint.findFirst()).rejects.toThrow(/permission denied/i);
      expect((await bootstrapPartitions(owner, opts)).created).toEqual([partitionName(now)]);
      expect((await bootstrapPartitions(owner, opts)).existing).toEqual([partitionName(now)]);

      const delivery = await app.webhookDelivery.create({
        data: {
          friendlyId: "whd_split_roles",
          webhookEndpointId: "endpoint_split_roles",
          organizationId: "org_test",
          projectId: "proj_test",
          runtimeEnvironmentId: "env_test",
          environmentType: "PRODUCTION",
          externalDeliveryId: "split_roles",
          idempotencyKey: "split_roles",
          createdAt: now,
        },
      });
      const old = dayBucket(addDays(now, -30));
      await createPartition(owner, old);
      await expect(detachPartitionConcurrently(app, old.name)).rejects.toThrow(/must be owner/i);

      engine = new WebhookEngine({
        prisma: app,
        partitionPrisma: owner,
        redis: redisOptions,
        worker: { concurrency: 1, pollIntervalMs: 10 },
        partitions: {
          ensureSchedule: "* * * * * *",
          ensureJitterInMs: 0,
          lookaheadDays: 1,
          retentionDays: 1,
        },
        triggerTask: async () => ({ success: true }),
        resolveSigningSecret: async () => undefined,
        logLevel: "error",
      });
      await expect(
        engine.ingest({
          opaqueId: "missing",
          rawBytes: new TextEncoder().encode("{}"),
          headers: {},
          url: "https://example.com/webhooks/v1/ingest/missing",
        })
      ).resolves.toEqual({ outcome: "endpoint_not_found" });

      await expect
        .poll(
          async () => ({
            partitions: (await listDatedPartitions(owner)).map((p) => p.name),
            oldExists: await partitionExists(owner, old.name),
          }),
          { timeout: 15_000 }
        )
        .toEqual({
          partitions: [
            partitionName(addDays(now, -1)),
            partitionName(now),
            partitionName(addDays(now, 1)),
          ],
          oldExists: false,
        });
      expect(await app.webhookDelivery.findFirst({ where: { id: delivery.id } })).toMatchObject({
        id: delivery.id,
      });
      const next = await app.webhookDelivery.create({
        data: {
          ...delivery,
          id: "delivery_after_maintenance",
          createdAt: addDays(now, 1),
          parsedEvent: undefined,
          headers: undefined,
        },
      });
      expect(next.createdAt).toEqual(addDays(now, 1));
    } finally {
      await engine?.quit();
      await app.$disconnect();
      await owner.$disconnect();
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${appRole}", "${ownerRole}" CASCADE`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${appRole}", "${ownerRole}"`);
    }
  },
  120_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "scheduled partition maintenance falls back to the writer when no owner connection is supplied",
  async ({ prisma, redisOptions }) => {
    await makePartitioned(prisma);
    const engine = new WebhookEngine({
      prisma,
      redis: redisOptions,
      worker: { concurrency: 1, pollIntervalMs: 10 },
      partitions: {
        ensureSchedule: "* * * * * *",
        ensureJitterInMs: 0,
        lookaheadDays: 0,
        retentionDays: 0,
      },
      triggerTask: async () => ({ success: true }),
      resolveSigningSecret: async () => undefined,
      logLevel: "error",
    });
    try {
      await expect
        .poll(() => listDatedPartitions(prisma), { timeout: 15_000 })
        .toEqual([expect.objectContaining({ name: partitionName(floorDayUTC(new Date())) })]);
    } finally {
      await engine.quit();
    }
  },
  120_000
);
