// Property: convertRunListInputOptionsToFilterRunsOptions tolerates a batch friendlyId → id resolution
// miss under replica lag. Drives the REAL exported function (not a reimplementation) with a store whose
// replica is FROZEN via the shared `laggingReplica`, so the batch lookup misses the just-written row
// while the owning primary still holds it.
//
// The read (store.findBatchTaskRunByFriendlyId, no client → REPLICA) resolves a `batch_` friendlyId to
// an internal id for a ClickHouse list FILTER, behind an `if (batch)` guard. Under lag it returns null,
// the guard is skipped, and the returned FilterRunsOptions keeps `batchId` as the UNRESOLVED friendlyId
// (matches no ClickHouse batch_id this load; the next revalidation resolves it once replicated). The
// function does NOT throw and mutates nothing; the batch is live on the primary (internal id differs),
// proving the miss is pure lag.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Prevent the run-store / db singletons from constructing at import; the function under test is driven
// with an explicitly-injected store + prisma, so these module defaults are never used at runtime.
vi.mock("~/db.server", () => ({}));
vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));

import { convertRunListInputOptionsToFilterRunsOptions } from "~/services/runsRepository/runsRepository.server";

let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

describe("convertRunListInputOptionsToFilterRunsOptions under replica lag", () => {
  heteroPostgresTest(
    "leaves a not-yet-replicated batch friendlyId unresolved in the filter without throwing",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `convert_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // Seed the batch on the PRIMARY only. Internal id differs from the friendlyId.
      const batchId = `batchinternal_${suffix}`;
      const batchFriendlyId = `batch_${suffix}`;
      await prisma.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: batchFriendlyId,
          runtimeEnvironmentId: seed.environment.id,
          status: "PENDING",
          batchVersion: "v3",
        },
      });

      // batchTaskRun frozen-missing on the replica; the client-less read routes there.
      const replica = laggingReplica(prisma, [{ model: "batchTaskRun", mode: "missing" }]);
      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: replica.client as never,
        schemaVariant: "legacy",
      });

      const result = await convertRunListInputOptionsToFilterRunsOptions(
        {
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          environmentId: seed.environment.id,
          batchId: batchFriendlyId,
        },
        prisma as never,
        store
      );

      // The batch resolution really hit the (lagging) replica.
      expect(replica.wasHit("batchTaskRun")).toBe(true);

      // OBSERVABLE OUTPUT: the friendlyId is left UNRESOLVED (not swapped to the internal id) — the
      // ClickHouse batch_id filter matches nothing this load; the function did not throw.
      expect(result.batchId).toBe(batchFriendlyId);
      expect(result.batchId).not.toBe(batchId);

      // The miss is pure lag: the batch is live on the PRIMARY (and would resolve on revalidation).
      const onPrimary = await prisma.batchTaskRun.findFirst({
        where: { friendlyId: batchFriendlyId },
      });
      expect(onPrimary?.id).toBe(batchId);
    }
  );

  // Control: with a live replica the SAME function resolves the friendlyId to the internal id — proving
  // the unresolved result above is caused solely by the replica lag, not by the code path being dead.
  heteroPostgresTest(
    "control: resolves the batch friendlyId to the internal id with a caught-up replica",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `convert_ok_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const batchId = `batchinternal_${suffix}`;
      const batchFriendlyId = `batch_${suffix}`;
      await prisma.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: batchFriendlyId,
          runtimeEnvironmentId: seed.environment.id,
          status: "PENDING",
          batchVersion: "v3",
        },
      });

      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
        schemaVariant: "legacy",
      });

      const result = await convertRunListInputOptionsToFilterRunsOptions(
        {
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          environmentId: seed.environment.id,
          batchId: batchFriendlyId,
        },
        prisma as never,
        store
      );

      expect(result.batchId).toBe(batchId);
    }
  );
});
