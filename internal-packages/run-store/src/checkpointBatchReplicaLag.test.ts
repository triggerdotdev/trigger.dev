// Repro for the checkpoint WAIT_FOR_BATCH replica-lag stall (createCheckpoint.server.ts:148-181).
//
// The service resolves the batch via `runStore.findBatchTaskRunByFriendlyId(friendlyId, envId)` with
// NO client, so the read is served from the REPLICA. Its decision hinges on `batchRun.resumedAt`:
//   resumedAt set  -> return keepRunAlive:true  (batch already resumed; the run must keep executing)
//   resumedAt null -> fall through -> create the checkpoint -> SUSPEND the run
// If the batch just resumed (primary has resumedAt), but the replica still lags (resumedAt null), the
// service suspends a run whose batch already completed -> it stalls until a sweep. The sibling
// WAIT_FOR_TASK arm reads the primary (this._prisma); only the batch arm defaults to the replica.
//
// This is invisible to the normal single-DB harness (no lag). We reintroduce the lag with the shared
// `laggingReplica` primitive: the store's replica is frozen at the pre-resume snapshot while the
// primary advances. RED = the current (client-less, replica) read -> SUSPEND. GREEN = threading the
// primary (the one-line fix) -> KEEP_ALIVE.

import { laggingReplica, postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { ReadClient } from "./types.js";

type BatchRow = { resumedAt: Date | null } | null;

// A line-for-line mirror of the service's WAIT_FOR_BATCH pre-check. `readClient` models the fix: the
// buggy code passes nothing (replica default); the fix threads the primary.
async function precheckWaitForBatch(
  store: PostgresRunStore,
  batchFriendlyId: string,
  environmentId: string,
  readClient?: ReadClient
): Promise<"DROP_RUN" | "KEEP_ALIVE" | "SUSPEND"> {
  const batchRun = (await store.findBatchTaskRunByFriendlyId(
    batchFriendlyId,
    environmentId,
    undefined,
    readClient
  )) as BatchRow;
  if (!batchRun) return "DROP_RUN"; // keepRunAlive:false
  if (batchRun.resumedAt) return "KEEP_ALIVE"; // batch already resumed -> run continues
  return "SUSPEND"; // falls through -> checkpoint created -> run suspended
}

async function seedEnvironment(prisma: PrismaClient, suffix: string) {
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

describe("checkpoint WAIT_FOR_BATCH under replica lag", () => {
  postgresTest(
    "a batch resumed on the primary but stale on the replica suspends an already-resumed run",
    async ({ prisma }) => {
      const { environment } = await seedEnvironment(prisma, "ckpt_lag");
      const friendlyId = "batch_ckpt_lag";
      const batch = await prisma.batchTaskRun.create({
        data: { friendlyId, runtimeEnvironmentId: environment.id },
      });

      // Snapshot the batch as the replica still sees it (pre-resume: resumedAt = null).
      const staleBatch = await prisma.batchTaskRun.findFirstOrThrow({ where: { id: batch.id } });
      expect(staleBatch.resumedAt).toBeNull();

      // The batch completes and resumes the parent: primary now has resumedAt set...
      await prisma.batchTaskRun.update({
        where: { id: batch.id },
        data: { resumedAt: new Date() },
      });

      // ...but the replica lags, frozen at the pre-resume snapshot.
      const replica = laggingReplica(prisma, [
        { model: "batchTaskRun", mode: "frozen", rows: [staleBatch] },
      ]);
      const store = new PostgresRunStore({
        prisma,
        readOnlyPrisma: replica.client,
        schemaVariant: "legacy",
      });

      // RED - the current service call (no client -> replica): stale null -> SUSPEND an already-resumed run.
      const buggy = await precheckWaitForBatch(store, friendlyId, environment.id);
      expect(replica.wasHit("batchTaskRun")).toBe(true); // proves it read the (stale) replica
      expect(buggy).toBe("SUSPEND"); // the stall bug

      // GREEN - the fix (thread the primary): sees resumedAt -> keep the run alive.
      const fixed = await precheckWaitForBatch(store, friendlyId, environment.id, prisma);
      expect(fixed).toBe("KEEP_ALIVE");
    }
  );
});
