import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import {
  addDays,
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
