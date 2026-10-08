import { randomUUID } from "node:crypto";
import {
  containerTestWithIsolatedRedisNoClickhouse,
  createStandalonePostgresContainer,
  postgresTest,
} from "@internal/testcontainers";
import {
  WEBHOOK_DELIVERY_RETENTION_CLASSES,
  webhookDeliveryRetentionClass,
} from "@trigger.dev/core/v3/isomorphic";
import { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { WebhookEngine } from "./index.js";
import {
  addDays,
  bootstrapPartitions,
  bucketFor,
  classParentName,
  createClassParent,
  createPartition,
  detachPartitionConcurrently,
  dropPartition,
  ensurePartitions,
  floorDayUTC,
  listDatedPartitions,
  partitionExists,
  partitionName,
  partitionsCoveredUntil,
  recoverInterruptedDetaches,
} from "./partitions.js";

const THREE_DAYS = webhookDeliveryRetentionClass(3)!;
const THIRTY_DAYS = webhookDeliveryRetentionClass(30)!;
const NINETY_DAYS = webhookDeliveryRetentionClass(90)!;

/**
 * `prisma db push` builds WebhookDelivery as a plain table (partitioning lives only in the migration
 * SQL), so recreate it as the LIST-partitioned root (no DEFAULT, matching the migration) before
 * exercising the in-app partition manager.
 */
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
      "targets" JSONB NOT NULL DEFAULT '[]',
      "parsedEvent" JSONB,
      "headers" JSONB,
      "rawBodyHash" TEXT,
      "errorMessage" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      "processedAt" TIMESTAMP(3),
      "retentionDays" INTEGER NOT NULL DEFAULT 30,
      CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id","createdAt","retentionDays")
    ) PARTITION BY LIST ("retentionDays")`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX "WebhookDelivery_webhookEndpointId_createdAt_idx" ON "WebhookDelivery"("webhookEndpointId","createdAt" DESC)`
  );
}

describe("bucketFor", () => {
  it("puts day classes in UTC day leaves and week classes in Monday-to-Monday leaves", () => {
    const thursday = new Date("2026-10-08T15:00:00.000Z");
    expect(bucketFor(THIRTY_DAYS, thursday)).toEqual({
      retentionDays: 30,
      lo: new Date("2026-10-08T00:00:00.000Z"),
      hi: new Date("2026-10-09T00:00:00.000Z"),
      name: "WebhookDelivery_r30_2026_10_08",
    });
    expect(bucketFor(NINETY_DAYS, thursday)).toEqual({
      retentionDays: 90,
      lo: new Date("2026-10-05T00:00:00.000Z"),
      hi: new Date("2026-10-12T00:00:00.000Z"),
      name: "WebhookDelivery_r90_2026_10_05",
    });
    expect(bucketFor(NINETY_DAYS, new Date("2026-10-11T23:59:59.999Z")).lo).toEqual(
      new Date("2026-10-05T00:00:00.000Z")
    );
  });
});

describe("partitionsCoveredUntil", () => {
  it("is when the first class runs out, and undefined when a class has no leaves", () => {
    const now = new Date("2026-10-08T00:00:00.000Z");
    const leaves = [
      bucketFor(THREE_DAYS, addDays(now, 9)),
      bucketFor(THIRTY_DAYS, addDays(now, 4)),
      bucketFor(NINETY_DAYS, addDays(now, 20)),
    ];
    expect(partitionsCoveredUntil(leaves, [THREE_DAYS, THIRTY_DAYS, NINETY_DAYS])).toEqual(
      addDays(now, 5)
    );
    expect(partitionsCoveredUntil(leaves.slice(1), [THREE_DAYS, THIRTY_DAYS])).toBeUndefined();
  });
});

postgresTest(
  "ensurePartitions creates every class's window and is idempotent",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    const now = new Date(Date.UTC(2026, 6, 15));
    const classes = [THREE_DAYS, NINETY_DAYS];

    const first = await ensurePartitions(prisma, { now, lookaheadDays: 7, classes });
    expect(first.created).toEqual([
      ...Array.from({ length: 8 }, (_, i) => partitionName(3, addDays(now, i))),
      "WebhookDelivery_r90_2026_07_13",
      "WebhookDelivery_r90_2026_07_20",
    ]);
    expect(await partitionExists(prisma, partitionName(3, addDays(now, -1)))).toBe(false);

    const second = await ensurePartitions(prisma, { now, lookaheadDays: 7, classes });
    expect(second.created).toHaveLength(0);
    expect(second.existing).toEqual(first.created);
  }
);

postgresTest("bootstrap covers every registered class by default", async ({ prisma }) => {
  await makePartitioned(prisma);
  const now = new Date(Date.UTC(2026, 9, 8));

  await bootstrapPartitions(prisma, { now, lookaheadDays: 0 });
  const leaves = await listDatedPartitions(prisma);
  expect(new Set(leaves.map((p) => p.retentionDays))).toEqual(
    new Set(WEBHOOK_DELIVERY_RETENTION_CLASSES.map((c) => c.days))
  );
  for (const c of WEBHOOK_DELIVERY_RETENTION_CLASSES) {
    expect(await partitionExists(prisma, classParentName(c.days))).toBe(true);
    expect(await partitionExists(prisma, bucketFor(c, now).name)).toBe(true);
  }
});

postgresTest("createPartition is created-then-exists", async ({ prisma }) => {
  await makePartitioned(prisma);
  await createClassParent(prisma, 7);
  const bucket = bucketFor(webhookDeliveryRetentionClass(7)!, new Date(Date.UTC(2026, 7, 1)));

  expect(await createPartition(prisma, bucket)).toBe("created");
  expect(await createPartition(prisma, bucket)).toBe("exists");
  expect(await partitionExists(prisma, bucket.name)).toBe(true);
});

postgresTest(
  "concurrent ensurePartitions runs all finish with the full window and claim each partition once",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    const now = new Date(Date.UTC(2026, 8, 17));
    const classes = [THREE_DAYS, THIRTY_DAYS];

    const results = await Promise.all([
      ensurePartitions(prisma, { now, lookaheadDays: 7, classes }),
      ensurePartitions(prisma, { now, lookaheadDays: 7, classes }),
      ensurePartitions(prisma, { now, lookaheadDays: 7, classes }),
    ]);

    for (const result of results) {
      expect(result.created.length + result.existing.length).toBe(16);
    }
    const claimed = results.flatMap((r) => r.created);
    expect(claimed).toHaveLength(16);
    expect(new Set(claimed).size).toBe(16);
    expect(await listDatedPartitions(prisma)).toHaveLength(16);
  }
);

postgresTest("detachPartitionConcurrently then drop removes a leaf", async ({ prisma }) => {
  await makePartitioned(prisma);
  await createClassParent(prisma, 30);
  const bucket = bucketFor(THIRTY_DAYS, new Date(Date.UTC(2026, 0, 1)));
  await createPartition(prisma, bucket);
  expect(await partitionExists(prisma, bucket.name)).toBe(true);

  await detachPartitionConcurrently(prisma, bucket);
  await dropPartition(prisma, bucket.name);
  expect(await partitionExists(prisma, bucket.name)).toBe(false);
});

postgresTest(
  "ensurePartitions drops each class's leaves past its own retention",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    const now = new Date(Date.UTC(2026, 9, 8));
    const classes = [THREE_DAYS, THIRTY_DAYS, NINETY_DAYS];
    await bootstrapPartitions(prisma, { now, lookaheadDays: 0, classes });

    const expiredShort = bucketFor(THREE_DAYS, addDays(now, -5));
    const keptShort = bucketFor(THREE_DAYS, addDays(now, -3));
    const keptLong = bucketFor(THIRTY_DAYS, addDays(now, -5));
    const expiredWeek = bucketFor(NINETY_DAYS, addDays(now, -100));
    const keptWeek = bucketFor(NINETY_DAYS, addDays(now, -60));
    for (const b of [expiredShort, keptShort, keptLong, expiredWeek, keptWeek]) {
      await createPartition(prisma, b);
    }

    const result = await ensurePartitions(prisma, { now, lookaheadDays: 0, classes });
    expect(result.dropped.sort()).toEqual([expiredShort.name, expiredWeek.name].sort());
    expect(result.deferred).toHaveLength(0);
    for (const b of [keptShort, keptLong, keptWeek]) {
      expect(await partitionExists(prisma, b.name)).toBe(true);
    }
    expect(await partitionExists(prisma, expiredShort.name)).toBe(false);
    expect(await partitionExists(prisma, expiredWeek.name)).toBe(false);
  }
);

postgresTest(
  "partitions outside every registered class are reported and never dropped",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    const now = new Date(Date.UTC(2026, 9, 8));
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "WebhookDelivery_r60" PARTITION OF "WebhookDelivery" FOR VALUES IN (60) PARTITION BY RANGE ("createdAt")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "WebhookDelivery_r60_2020_01_01" PARTITION OF "WebhookDelivery_r60" FOR VALUES FROM ('2020-01-01') TO ('2020-01-02')`
    );

    const result = await ensurePartitions(prisma, { now, lookaheadDays: 0, classes: [THREE_DAYS] });
    expect(result.unmanaged.sort()).toEqual([
      "WebhookDelivery_r60",
      "WebhookDelivery_r60_2020_01_01",
    ]);
    expect(result.dropped).toEqual([]);
    expect(await partitionExists(prisma, "WebhookDelivery_r60_2020_01_01")).toBe(true);
    expect(
      (await listDatedPartitions(prisma)).some((p) => p.name.startsWith("WebhookDelivery_r60"))
    ).toBe(false);
  }
);

postgresTest(
  "recoverInterruptedDetaches drops a detached-but-not-dropped leftover",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "WebhookDelivery_r7_2020_01_01" (LIKE "WebhookDelivery")`
    );
    expect(await partitionExists(prisma, "WebhookDelivery_r7_2020_01_01")).toBe(true);
    expect(
      (await listDatedPartitions(prisma)).some((p) => p.name === "WebhookDelivery_r7_2020_01_01")
    ).toBe(false);

    await recoverInterruptedDetaches(prisma);
    expect(await partitionExists(prisma, "WebhookDelivery_r7_2020_01_01")).toBe(false);
  }
);

postgresTest(
  "bootstrap targets the webhook database, preserves old leaves, and hands off to cron",
  async ({ prisma }) => {
    const { container, url } = await createStandalonePostgresContainer();
    const webhookDb = new PrismaClient({ datasources: { db: { url } } });
    try {
      await makePartitioned(prisma);
      await makePartitioned(webhookDb);
      const now = new Date(Date.UTC(2026, 8, 18));
      const opts = { now, lookaheadDays: 10, classes: [THREE_DAYS] };
      await createClassParent(webhookDb, 3);
      const old = bucketFor(THREE_DAYS, addDays(now, -30));
      await createPartition(webhookDb, old);

      const first = await bootstrapPartitions(webhookDb, opts);
      expect(first.created).toHaveLength(11);
      expect(first.created[0]).toBe(partitionName(3, now));
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
      `CREATE TABLE "WebhookDelivery_r3_2026_09_18" (LIKE "WebhookDelivery")`
    );
    await expect(
      bootstrapPartitions(prisma, { now, lookaheadDays: 0, classes: [THREE_DAYS] })
    ).rejects.toThrow("WebhookDelivery_r3_2026_09_18 is not attached");
    expect(await partitionExists(prisma, partitionName(3, now))).toBe(true);
  }
);

postgresTest("bootstrap rejects an attached leaf with incorrect bounds", async ({ prisma }) => {
  await makePartitioned(prisma);
  const now = new Date(Date.UTC(2026, 8, 18));
  await createClassParent(prisma, 3);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "WebhookDelivery_r3_2026_09_18" PARTITION OF "WebhookDelivery_r3"
      FOR VALUES FROM ('2026-09-19') TO ('2026-09-20')`
  );
  await expect(
    bootstrapPartitions(prisma, { now, lookaheadDays: 0, classes: [THREE_DAYS] })
  ).rejects.toThrow("expected bounds");
  expect(await partitionExists(prisma, partitionName(3, now))).toBe(true);
});

postgresTest(
  "bootstrap rejects a class sub-parent with the wrong list value",
  async ({ prisma }) => {
    await makePartitioned(prisma);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "WebhookDelivery_r3" PARTITION OF "WebhookDelivery" FOR VALUES IN (4) PARTITION BY RANGE ("createdAt")`
    );
    await expect(
      bootstrapPartitions(prisma, {
        now: new Date(Date.UTC(2026, 8, 18)),
        lookaheadDays: 0,
        classes: [THREE_DAYS],
      })
    ).rejects.toThrow("WebhookDelivery_r3 is not attached");
  }
);

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
      const opts = { now, lookaheadDays: 0 };
      await expect(bootstrapPartitions(app, opts)).rejects.toThrow(
        /permission denied|must be owner/i
      );
      await expect(owner.webhookEndpoint.findFirst()).rejects.toThrow(/permission denied/i);
      const bootstrapped = await bootstrapPartitions(owner, opts);
      expect(bootstrapped.created).toContain(partitionName(30, now));
      expect((await bootstrapPartitions(owner, opts)).existing).toEqual(bootstrapped.created);

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
      expect(delivery.retentionDays).toBe(30);
      const old = bucketFor(THREE_DAYS, addDays(now, -30));
      await createPartition(owner, old);
      await expect(detachPartitionConcurrently(app, old)).rejects.toThrow(/must be owner/i);

      engine = new WebhookEngine({
        prisma: app,
        partitionPrisma: owner,
        redis: redisOptions,
        worker: { concurrency: 1, pollIntervalMs: 10 },
        partitions: {
          ensureSchedule: "* * * * * *",
          ensureJitterInMs: 0,
          lookaheadDays: 1,
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
            tomorrow: await partitionExists(owner, partitionName(30, addDays(now, 1))),
            oldExists: await partitionExists(owner, old.name),
          }),
          { timeout: 15_000 }
        )
        .toEqual({ tomorrow: true, oldExists: false });
      expect(await app.webhookDelivery.findFirst({ where: { id: delivery.id } })).toMatchObject({
        id: delivery.id,
      });
      const next = await app.webhookDelivery.create({
        data: {
          ...delivery,
          id: "delivery_after_maintenance",
          createdAt: addDays(now, 1),
          retentionDays: 3,
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
      },
      triggerTask: async () => ({ success: true }),
      resolveSigningSecret: async () => undefined,
      logLevel: "error",
    });
    try {
      await expect
        .poll(() => partitionExists(prisma, partitionName(30, floorDayUTC(new Date()))), {
          timeout: 15_000,
        })
        .toBe(true);
    } finally {
      await engine.quit();
    }
  },
  120_000
);
