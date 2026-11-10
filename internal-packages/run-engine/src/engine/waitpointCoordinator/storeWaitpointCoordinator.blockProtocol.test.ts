import { registrationEvidence } from "./keys.js";
// Test the three-phase protocol with the real router, adapter, Redis and Postgres.
// Cover block identity, resume acknowledgement, cleanup and fanout.
// Restart tests reconstruct registration from saved data. They do not run production recovery jobs;
// those jobs are tested in the engine integration suite.

import { createRedisClient } from "@internal/redis";
import { containerTest } from "@internal/testcontainers";
import { generateWaitpointId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { PostgresRunStore } from "@internal/run-store";
import { Logger } from "@trigger.dev/core/logger";
import { LegacyPostgresWaitpointCoordinator } from "./legacyPostgresCoordinator.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
} from "../../../../run-store/src/testFixtures/snapshotIdFixture.js";
import { describe, expect, vi } from "vitest";
import { StoreWaitpointBlockOperationIdentityRequired } from "../errors.js";
import { WaitpointFanoutWorker } from "./fanoutWorker.js";
import { RoutingWaitpointCoordinator } from "./routingCoordinator.js";
import {
  StoreWaitpointBlockRefusedError,
  StoreWaitpointCoordinator,
} from "./storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import { RUN_CLEANUP_PAGE_SIZE } from "./scripts.js";
import type {
  AbsorbBlockersParams,
  BlockerRegistration,
  StoreBlockerRegistration,
} from "./types.js";

function buildRouting(
  store: WaitpointStoreCoordinator,
  prisma: PrismaClient,
  opts?: { clock?: () => number; markStoreWaitpoints?: () => Promise<void> }
) {
  const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const legacy = new LegacyPostgresWaitpointCoordinator({
    runStore: () => runStore,
    prisma,
    logger: new Logger("block-protocol-test"),
  });
  const adapter = new StoreWaitpointCoordinator({ store, clock: opts?.clock });
  const routing = new RoutingWaitpointCoordinator({
    legacy,
    store: adapter,
    mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
    mightHaveStoreBlockers: () => true,
    markStoreWaitpoints: opts?.markStoreWaitpoints,
  });
  return { routing, adapter };
}

// Count live watchers. Fanout queue length is not a watcher count.
async function liveWatchers(
  store: WaitpointStoreCoordinator,
  waitpointId: string
): Promise<number> {
  const d = await store.describeWaitpoint(waitpointId);
  return d.outcome === "exists" ? d.liveWatchers : 0;
}

// Create a pending waitpoint before registering its watcher.
async function seedPending(
  store: WaitpointStoreCoordinator,
  waitpointId: string,
  completedByTaskRunId?: string
): Promise<void> {
  const now = new Date().toISOString();
  const record = {
    id: waitpointId,
    friendlyId: WaitpointId.toFriendlyId(waitpointId),
    type: "MANUAL" as const,
    environmentId: "env_1",
    projectId: "proj_1",
    organizationId: ORG,
    createdAt: now,
    updatedAt: now,
    userProvidedIdempotencyKey: false,
    tags: [],
    completedByTaskRunId,
  };
  // Preserve caller-selected protocol identities while honoring the MANUAL mint contract.
  await store.manualCatalog.publish(record, Date.now() + 300_000);
  await store.createIfAbsent({ record, status: "PENDING" });
}

const ORG = "org_1";

const absorbArgs = (
  client: PrismaClient,
  runId: string,
  blockId: string,
  waitpointIds: string[],
  over: Partial<AbsorbBlockersParams> = {}
): AbsorbBlockersParams => ({
  runId,
  blockId,
  absorptionId: blockId,
  organizationId: ORG,
  waitpointIds,
  projectId: "proj_1",
  client,
  parentResidency: "redis-primary",
  ...over,
});

// Test helper: rebuild registration from saved data after a simulated crash.
// Production recovery jobs are covered by the engine integration tests.
async function reconstructFromDurableState(
  store: WaitpointStoreCoordinator,
  runId: string,
  organizationId?: string
): Promise<BlockerRegistration> {
  const state = await store.readBlockState(runId);
  if (!state.blockId) throw new Error(`no durable block state to reconstruct for ${runId}`);
  const registration: StoreBlockerRegistration = {
    kind: "store",
    registrationEvidence: registrationEvidence(
      state.edges.map((e) => e.waitpointId),
      state.edges[0]?.batchIndex ?? undefined
    ),
    runId,
    blockId: state.blockId,
    absorptionId: state.blockId,
    organizationId,
    edges: state.edges.map((e) => ({
      waitpointId: e.waitpointId,
      batchId: e.batchId ?? undefined,
      batchIndex: e.batchIndex ?? undefined,
      spanIdToComplete: e.spanIdToComplete,
      createdAt: e.createdAt,
      type: e.type,
    })),
    storePendingTotal: state.pendingIds.length,
    alreadyDelivered: [],
  };
  return { kind: "routing", parts: [registration] };
}

const completionOf = (value: string) => ({
  completedAt: new Date().toISOString(),
  outputType: "application/json",
  outputIsError: false,
  output: { inline: value },
});

// Publish a real Postgres blocked snapshot between the two store protocol phases.
function transitionMarker(prisma: PrismaClient, runId: string) {
  return {
    async publish() {
      const env = await seedSnapshotEnvironment(prisma);
      await new PostgresRunStore({ prisma, readOnlyPrisma: prisma }).createRun({
        data: buildCreateRunData(runId, env),
        snapshot: {
          engine: "V2",
          executionStatus: "SUSPENDED",
          description: "blocked transition",
          runStatus: "PENDING",
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      });
      return env;
    },
    async published() {
      return (await prisma.taskRunExecutionSnapshot.count({ where: { runId } })) > 0;
    },
  };
}

describe("Three-phase block protocol and lifecycle (real store adapter through the routing seam)", () => {
  containerTest(
    "compensation preserves a later registration of the same edge and releases failed claims",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { adapter } = buildRouting(store, prisma);
      try {
        for (const laterSucceeds of [true, false]) {
          const runId = `run_shared_claim_${laterSucceeds}`;
          const wp = generateWaitpointId("MANUAL");
          await seedPending(store, wp);
          const request = (absorptionId: string) =>
            absorbArgs(prisma, runId, "B1", [wp], { absorptionId });

          // A1's store write survives a failed legacy write and failed inline compensation.
          await adapter.absorbBlockers(request("A1"));
          // A lost reply must not add a second claim for the same operation.
          await adapter.absorbBlockers(request("A1"));
          const second = await adapter.absorbBlockers(request("A2"));
          if (laterSucceeds) {
            await adapter.registerBlockers(second.registration);
            await adapter.finalizeBlockers({ ...request("A2"), blockId: "B1", absorptionId: "A2" });
          }

          await adapter.compensateAbsorption({ runId, blockId: "B1", absorptionId: "A1" });
          await adapter.compensateAbsorption({ runId, blockId: "B1", absorptionId: "A1" });
          const retained = await store.readBlockState(runId);
          expect(retained.blockId).toBe("B1");
          expect(retained.edges).toHaveLength(1);
          expect(retained.pendingIds).toEqual([wp]);

          if (laterSucceeds) {
            await adapter.complete({
              waitpointId: wp,
              organizationId: ORG,
              output: { value: "ok", isError: false },
            });
            const delivered = await store.registerAndDeliver({
              runId,
              blockId: "B1",
              edges: second.registration.kind === "store" ? second.registration.edges : [],
              absorbed: { storePendingTotal: 1, alreadyDelivered: [] },
            });
            expect(delivered.pendingOfRequested).toBe(0);
            expect((await store.readBlockState(runId)).pendingIds).toEqual([]);
          } else {
            await adapter.compensateAbsorption({ runId, blockId: "B1", absorptionId: "A2" });
            const cleared = await store.readBlockState(runId);
            expect(cleared.blockId).toBeUndefined();
            expect(cleared.edges).toEqual([]);
            expect(cleared.pendingIds).toEqual([]);
          }
        }
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "recovery rejects an unaccepted mixed request sharing a native edge and retains accepted duplicate tail proof",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      let failMarker = false;
      const { routing } = buildRouting(store, prisma, {
        markStoreWaitpoints: async () => {
          if (failMarker) throw new Error("marker unavailable");
        },
      });
      const runId = "run_exact_registration";
      try {
        // Add the existing production partial index. The Prisma-only fixture omits it.
        // Nonbatch retries must use the same uniqueness rule as production.
        await prisma.$executeRaw`
          CREATE UNIQUE INDEX IF NOT EXISTS "TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_null_key"
          ON "TaskRunWaitpoint"("taskRunId", "waitpointId") WHERE "batchIndex" IS NULL
        `;
        const env = await transitionMarker(prisma, runId).publish();
        const legacyWp = (
          await prisma.waitpoint.create({
            data: {
              friendlyId: "waitpoint_exact_registration",
              type: "MANUAL",
              status: "PENDING",
              projectId: env.projectId,
              environmentId: env.id,
              idempotencyKey: "exact_registration",
              userProvidedIdempotencyKey: false,
            },
          })
        ).id;
        const native = generateWaitpointId("RUN");
        await seedPending(store, native);
        const request = (absorptionId: string, ids = [native, legacyWp]) =>
          absorbArgs(prisma, runId, "B1", ids, {
            absorptionId,
            projectId: env.projectId,
          });
        const accepted = await routing.absorbBlockers(request("A", [native]));
        await routing.registerBlockers(accepted.registration);
        await routing.finalizeBlockers({
          ...request("A", [native]),
          blockId: "B1",
          absorptionId: "A",
        });
        failMarker = true;
        await expect(routing.absorbBlockers(request("C"))).rejects.toThrow("marker unavailable");
        const recovery = { ...request("C"), blockId: "B1", absorptionId: "C" };
        failMarker = false;
        // Use the recovery check. A rejected request must not add the Postgres wait L.
        if (await routing.hasAbsorbedBlockers(recovery)) {
          await routing.absorbBlockers(request("C"));
        }
        expect(await routing.hasAbsorbedBlockers(recovery)).toBe(false);
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: runId, waitpointId: legacyWp },
          })
        ).toBe(0);

        failMarker = false;
        // Accepting an existing edge still needs proof for this request.
        const duplicate = await routing.absorbBlockers(request("D"));
        await routing.registerBlockers(duplicate.registration);
        const duplicateRecovery = { ...request("D"), blockId: "B1", absorptionId: "D" };
        expect(await routing.hasAbsorbedBlockers(duplicateRecovery)).toBe(true);
        expect(
          await routing.hasAbsorbedBlockers({ ...duplicateRecovery, waitpointIds: [native] })
        ).toBe(false);
        // Late cleanup must not revoke proof after phase 3 succeeds.
        await routing.compensateAbsorption(duplicateRecovery);
        expect(await routing.hasAbsorbedBlockers(duplicateRecovery)).toBe(true);
        await routing.registerBlockers((await routing.absorbBlockers(request("D"))).registration);
        expect(await liveWatchers(store, native)).toBe(1);
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: runId, waitpointId: legacyWp },
          })
        ).toBe(1);
        await routing.finalizeBlockers(duplicateRecovery);
        expect(await routing.hasAbsorbedBlockers(duplicateRecovery)).toBe(false);

        // An undone request stays rejected even if another operation has the same edge.
        await routing.absorbBlockers(request("compensated", [native]));
        await routing.compensateAbsorption({ ...recovery, absorptionId: "compensated" });
        await routing.absorbBlockers(request("other", [native]));
        expect(
          await routing.hasAbsorbedBlockers({
            ...recovery,
            absorptionId: "compensated",
            waitpointIds: [native],
          })
        ).toBe(false);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "ORDERING: absorb installs run-side pending but registers NO watcher until phase 3",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_order";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);
        const marker = transitionMarker(prisma, runId);

        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp])
        );
        expect((await store.readBlockState(runId)).pendingIds).toEqual([wp]);
        expect(await marker.published()).toBe(false);
        expect(await liveWatchers(store, wp)).toBe(0);

        await marker.publish();
        const { pendingCount } = await routing.registerBlockers(registration);
        expect(pendingCount).toBe(1);
        expect(await liveWatchers(store, wp)).toBe(1);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "ORG THREADING: the run's org lands on the store watcher, for the async continuation",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_org";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);

        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp])
        );
        await routing.registerBlockers(registration);

        // Check that the watcher carries its organisation for later routing.
        const claim = await store.claimFanoutPage({
          waitpointId: wp,
          workerId: "probe",
          pageSize: 10,
          leaseMs: 10_000,
        });
        // Complete the pending waitpoint to read the watcher from the fanout result.
        expect(claim.outcome).toBe("pending-record");
        await store.complete({ waitpointId: wp, completion: completionOf("1") });
        const claimed = await store.claimFanoutPage({
          waitpointId: wp,
          workerId: "probe",
          pageSize: 10,
          leaseMs: 10_000,
        });
        expect(claimed.outcome).toBe("claimed");
        if (claimed.outcome === "claimed") {
          expect(claimed.page[0]?.watcher?.organizationId).toBe(ORG);
        }
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "EARLY COMPLETION: a completion in the absorb→register gap is reported and delivered",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_early";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);

        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp])
        );
        const completed = await routing.complete({
          waitpointId: wp,
          output: { value: '{"ok":true}', isError: false },
        });
        expect(completed.waitpoint.output).toBe('{"ok":true}');

        const { pendingCount } = await routing.registerBlockers(registration);
        expect(pendingCount).toBe(0); // reported complete and delivered, not stuck
        const state = await store.readBlockState(runId);
        expect(state.pendingIds).toEqual([]);
        expect(state.deliveredIds).toEqual([wp]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "MIXED RESIDENCY: legacy + store blockers combine counts and route by shape",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_mixed";
        const env = await transitionMarker(prisma, runId).publish();
        const legacyWp = (
          await prisma.waitpoint.create({
            data: {
              friendlyId: "waitpoint_legacy_mixed",
              type: "MANUAL",
              status: "PENDING",
              projectId: env.projectId,
              environmentId: env.id,
              idempotencyKey: "legacy_mixed",
              userProvidedIdempotencyKey: false,
            },
          })
        ).id;
        const storeWp = generateWaitpointId("MANUAL"); // b32hexW → store
        await seedPending(store, storeWp);

        const { pendingCount, registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [legacyWp, storeWp], {
            client: prisma,
            projectId: env.projectId,
          })
        );
        expect(pendingCount).toBe(2);
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: runId, waitpointId: legacyWp },
          })
        ).toBe(1);
        expect((await store.readBlockState(runId)).pendingIds).toEqual([storeWp]);

        await routing.registerBlockers(registration);
        await routing.complete({ waitpointId: storeWp, output: { value: "x", isError: false } });
        const diag = await store.describeWaitpoint(storeWp);
        expect(diag.outcome === "exists" && diag.status).toBe("COMPLETED");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "CAS: block1 drains, block2 gets a fresh id; a delayed block1 absorb is refused stale without mutating block2",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_cas";
        const wp1 = generateWaitpointId("MANUAL");
        const wp2 = generateWaitpointId("MANUAL");
        await seedPending(store, wp1);
        await seedPending(store, wp2);

        // Retry the same operation on block 1. Do not add duplicate edges.
        await routing.absorbBlockers(absorbArgs(prisma, runId, "B1", [wp1]));
        await routing.absorbBlockers(absorbArgs(prisma, runId, "B1", [wp1]));
        let state = await store.readBlockState(runId);
        expect(state.blockId).toBe("B1");
        expect(state.pendingIds).toEqual([wp1]);

        // Complete block 1 and acknowledge its resume.
        const { registration: reg1 } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp1])
        );
        await routing.registerBlockers(reg1);
        await routing.complete({ waitpointId: wp1, output: { value: "1", isError: false } });
        await store.deliverCompletion({
          runId,
          blockId: "B1",
          waitpointId: wp1,
          completion: completionOf("1"),
        });
        const obs = await routing.currentStoreBlockId(runId, { organizationId: ORG });
        await routing.acknowledgeResume({ runId, blockId: obs, organizationId: ORG });
        expect((await store.readBlockState(runId)).blockId).toBeUndefined(); // drained

        // Create block 2 with a new ID after block 1 has drained.
        await routing.absorbBlockers(absorbArgs(prisma, runId, "B2", [wp2]));
        state = await store.readBlockState(runId);
        expect(state.blockId).toBe("B2");
        expect(state.pendingIds).toEqual([wp2]);

        // Reject a delayed block-1 request without changing block 2.
        await expect(
          routing.absorbBlockers(absorbArgs(prisma, runId, "B1", [wp1]))
        ).rejects.toBeInstanceOf(StoreWaitpointBlockRefusedError);
        state = await store.readBlockState(runId);
        expect(state.blockId).toBe("B2");
        expect(state.pendingIds).toEqual([wp2]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "HANDOFF: resume acknowledgement drives hs owed → acked, drains under the fence, and a second cycle blocks again",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_handoff";
        const wp1 = generateWaitpointId("MANUAL");
        const wp2 = generateWaitpointId("MANUAL");
        await seedPending(store, wp1);
        await seedPending(store, wp2);

        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp1])
        );
        await routing.registerBlockers(registration);
        await routing.complete({ waitpointId: wp1, output: { value: "1", isError: false } });
        const delivered = await store.deliverCompletion({
          runId,
          blockId: "B1",
          waitpointId: wp1,
          completion: completionOf("1"),
        });
        expect(delivered.resumable).toBe(true);
        expect((await store.readBlockState(runId)).handoff).toBe("owed");

        // Before the resume is durable, terminal retention MUST NOT arm (a resume cleanup is retained).
        const early = await store.cleanupRunBlockState({ runId, reason: "resume" });
        expect(early).toMatchObject({ outcome: "retained" });

        // TRES has now durably accepted the resume: acknowledge + drain under the block-id fence.
        const edgeIds = (await store.readBlockState(runId)).edges.map((e) => e.edgeId);
        await store.acknowledgeResumeHandoff({ runId, blockId: "B1", edgeIds });
        const acked = await store.readBlockState(runId);
        expect(acked.handoff).toBe("acked");
        expect(acked.pendingIds).toEqual([]);
        expect(acked.edges).toEqual([]);

        // Terminal retention can now arm (handoff no longer owed).
        expect(await store.cleanupRunBlockState({ runId, reason: "terminal" })).toMatchObject({
          outcome: "armed",
        });

        // And a fresh cycle blocks again — but this run is now terminal, so a NEW run proves the cycle.
        const runId2 = "run_handoff_2";
        await routing.absorbBlockers(absorbArgs(prisma, runId2, "C1", [wp2]));
        expect((await store.readBlockState(runId2)).blockId).toBe("C1");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "FANOUT → RESUME: a completion after registration drives the REAL worker, which requests the run's continuation with its org",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      const continuations = createRedisClient(redisOptions);
      const continuationKey = "test:continuations";
      const worker = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "wpfan-test",
        onResumable: async (ctx) => {
          await continuations.rpush(continuationKey, JSON.stringify(ctx));
        },
      });
      try {
        const runId = "run_fanout";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);

        // Register the watcher, THEN complete — so delivery must go through the async fanout worker.
        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp])
        );
        await routing.registerBlockers(registration);
        await routing.complete({ waitpointId: wp, output: { value: "done", isError: false } });
        expect((await store.readBlockState(runId)).pendingIds).toEqual([wp]); // still blocked

        // Drive the real worker: it claims the page, delivers to the run shard, and — because the
        // delivery empties the pending set — bridges to the run's continuation with the org off the
        // watcher.
        const summary = await worker.visit(wp);
        expect(summary.delivered).toBe(1);
        expect(
          (await continuations.lrange(continuationKey, 0, -1)).map((item) => JSON.parse(item))
        ).toEqual([{ runId, organizationId: ORG, waitpointId: wp }]);

        // The receipt is durable and the run is resumable; the continuation acknowledges the resume and
        // the parent is no longer blocked.
        const beforeAck = await store.readBlockState(runId);
        expect(beforeAck.pendingIds).toEqual([]);
        expect(beforeAck.deliveredIds).toEqual([wp]);
        expect(beforeAck.handoff).toBe("owed");
        const obs = await routing.currentStoreBlockId(runId, { organizationId: ORG });
        await routing.acknowledgeResume({ runId, blockId: obs, organizationId: ORG });
        expect((await store.readBlockState(runId)).blockId).toBeUndefined();
      } finally {
        await worker.dispose();
        await continuations.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "FANOUT RETRY-SAFE: a failed Redis continuation enqueue is retried on the next visit (via the duplicate), then drains; the resume is acknowledged exactly once",
    async ({ prisma, redisOptions }) => {
      // An advancing clock so the failed entry's retry backoff can be stepped past between visits.
      vi.useFakeTimers({ toFake: ["Date"] });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      const continuations = createRedisClient(redisOptions);
      const continuationKey = "test:continuations";
      const worker = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "wpfan-retry",
        retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000 },
        // The continuation appends a real durable Redis request, then by acknowledging the resume handoff — after which the run no longer owes one.
        onResumable: async ({ runId }) => {
          await continuations.rpush(continuationKey, runId);
          const blockId = (await store.readBlockState(runId)).blockId!;
          await store.acknowledgeResumeHandoff({ runId, blockId });
        },
      });
      try {
        const runId = "run_retry_fanout";
        await continuations.set(continuationKey, "wrong-type");
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);
        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp])
        );
        await routing.registerBlockers(registration);
        await routing.complete({ waitpointId: wp, output: { value: "done", isError: false } });

        // First visit: delivery commits (run-side receipt durable), but the continuation throws — so the
        // page is NOT retired, and the run is still owed a continuation.
        const first = await worker.visit(wp);
        expect(first.outcome).not.toBe("drained");
        expect(await continuations.type(continuationKey)).toBe("string");
        expect((await store.readBlockState(runId)).handoff).toBe("owed");

        // Step past the failed entry's retry backoff.
        await continuations.del(continuationKey);
        vi.setSystemTime(Date.now() + 5_000);

        // Second visit: the redelivery is a DUPLICATE (resumable=false), yet the still-owed handoff
        // re-drives the continuation. It succeeds and acknowledges the resume, and the page drains.
        const second = await worker.visit(wp);
        expect(await continuations.lrange(continuationKey, 0, -1)).toEqual([runId]);
        expect(second.outcome).toBe("drained");
        expect((await store.readBlockState(runId)).handoff).toBe("acked");

        // Third visit: the handoff is acknowledged, so the continuation is NOT re-armed — no duplicate
        // durable resume.
        await worker.visit(wp);
        expect(await continuations.lrange(continuationKey, 0, -1)).toEqual([runId]);
      } finally {
        await worker.dispose();
        await continuations.quit();
        vi.useRealTimers();
        await store.quit();
      }
    }
  );

  containerTest(
    "TERMINAL-FIRST: release installs the terminal fence before withdrawing watchers, so an in-flight delivery cannot resume a cancelled run",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_cancel";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);
        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp])
        );
        await routing.registerBlockers(registration);

        // Cancel the run: terminal-first release fences the run shard and withdraws the watcher.
        await routing.releaseRunBlockers({ runId, reason: "cancelled", organizationId: ORG });
        expect((await store.readBlockState(runId)).terminal).toBe(true);
        expect(await liveWatchers(store, wp)).toBe(0);

        // A completion + delivery that races in AFTER the fence cannot publish a resume: the run shard
        // refuses it as terminal.
        await store.complete({ waitpointId: wp, completion: completionOf("late") });
        const late = await store.deliverCompletion({
          runId,
          blockId: "B1",
          waitpointId: wp,
          completion: completionOf("late"),
        });
        expect(late.outcome).toBe("terminal");
        expect(late.resumable).toBe(false);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "RESTART after absorb, before the transition: recovery reconstructs the block from durable records and converges",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_restart1";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);
        const marker = transitionMarker(prisma, runId);

        // Simulate a crash after absorption. Discard the in-memory registration.
        await routing.absorbBlockers(absorbArgs(prisma, runId, "B1", [wp]));
        // (registration deliberately dropped)

        // Only the pending block is saved. No blocked snapshot or watcher exists.
        expect((await store.readBlockState(runId)).pendingIds).toEqual([wp]);
        expect(await marker.published()).toBe(false);
        expect(await liveWatchers(store, wp)).toBe(0);

        // Rebuild from saved data, publish the snapshot, then register watchers.
        const recovered = await reconstructFromDurableState(store, runId, ORG);
        await marker.publish();
        const { pendingCount } = await routing.registerBlockers(recovered);
        expect(pendingCount).toBe(1);
        expect(await liveWatchers(store, wp)).toBe(1);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "RESTART after the transition, before registration: recovery reconstructs from durable records and registers",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_restart2";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);
        const marker = transitionMarker(prisma, runId);

        await routing.absorbBlockers(absorbArgs(prisma, runId, "B1", [wp]));
        await marker.publish();
        // Simulate a crash after the snapshot write, before watcher registration.

        expect(await marker.published()).toBe(true);
        expect((await store.readBlockState(runId)).pendingIds).toEqual([wp]);
        expect(await liveWatchers(store, wp)).toBe(0);

        const recovered = await reconstructFromDurableState(store, runId, ORG);
        const { pendingCount } = await routing.registerBlockers(recovered);
        expect(pendingCount).toBe(1);
        expect(await liveWatchers(store, wp)).toBe(1);

        // A later completion delivers through the durable watcher.
        await routing.complete({ waitpointId: wp, output: { value: "ok", isError: false } });
        const diag = await store.describeWaitpoint(wp);
        expect(diag.outcome === "exists" && diag.status).toBe("COMPLETED");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "FAIL LOUD: a store-format blocker with no caller-owned identity is refused before any coordinator is mutated",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_noidentity";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp);

        // Call without the required block identity.
        const { blockId: _drop, ...noIdentity } = absorbArgs(prisma, runId, "unused", [wp]);
        await expect(
          routing.absorbBlockers(noIdentity as AbsorbBlockersParams)
        ).rejects.toBeInstanceOf(StoreWaitpointBlockOperationIdentityRequired);
        expect((await store.readBlockState(runId)).blockId).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );
  containerTest(
    "CONTRIBUTION: compensation releases failed claims and preserves a prior operation's edge",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_contrib";
        const s1 = generateWaitpointId("MANUAL");
        const s2 = generateWaitpointId("MANUAL");
        await seedPending(store, s1);
        await seedPending(store, s2);

        // a1 installs s1; a2 additively requests s1 (already present) + s2 (new).
        await routing.absorbBlockers(absorbArgs(prisma, runId, "B1", [s1], { absorptionId: "a1" }));
        await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [s1, s2], { absorptionId: "a2" })
        );
        expect((await store.readBlockState(runId)).pendingIds.sort()).toEqual([s1, s2].sort());
        // A same-absorption retry must preserve its original contribution instead of replacing it.
        await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [s1, s2], { absorptionId: "a2" })
        );

        // a2 claims both requested edges; a1 independently claims s1.
        expect(
          await store.readContribution({ runId, blockId: "B1", absorptionId: "a2" })
        ).toHaveLength(2);
        expect(
          await store.readContribution({ runId, blockId: "B1", absorptionId: "a1" })
        ).toHaveLength(1);

        // Compensate a2: removes only s2; s1 (from a1), a1's contribution AND blk=B1 all survive.
        await routing.compensateAbsorption({ runId, blockId: "B1", absorptionId: "a2" });
        expect((await store.readBlockState(runId)).pendingIds).toEqual([s1]);
        expect((await store.readBlockState(runId)).blockId).toBe("B1");
        expect(await store.readContribution({ runId, blockId: "B1", absorptionId: "a2" })).toEqual(
          []
        );
        expect(
          await store.readContribution({ runId, blockId: "B1", absorptionId: "a1" })
        ).toHaveLength(1);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "CONTRIBUTION: a mixed absorption whose ONLY store edge is compensated leaves NO phantom block identity, so a fresh operation with no predecessor is accepted",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      const marker = transitionMarker(prisma, "run_phantom");
      try {
        const runId = "run_phantom";
        const s1 = generateWaitpointId("MANUAL");
        const l1 = "legacy_wp_phantom"; // Missing parent/waitpoint rows cause a real Postgres foreign-key rejection.
        const s2 = generateWaitpointId("MANUAL");
        await seedPending(store, s1);
        await seedPending(store, s2);

        // B1 is a MIXED operation: the store half installs blk=B1 (with s1), then the legacy half throws and
        // inline compensation of a1 runs. No blocked transition is ever published (absorb is phase 1).
        await expect(
          routing.absorbBlockers(
            absorbArgs(prisma, runId, "B1", [s1, l1], { absorptionId: "a1", client: prisma })
          )
        ).rejects.toThrow();
        expect(await marker.published()).toBe(false);

        // Compensation removed B1's only edge AND its phantom identity: no edge, no contribution, no
        // pend/done residue, and no active block.
        const state = await store.readBlockState(runId);
        expect(state.blockId).toBeUndefined();
        expect(state.pendingIds).toEqual([]);
        expect(state.deliveredIds).toEqual([]);
        expect(state.edges).toEqual([]);
        expect(await store.readContribution({ runId, blockId: "B1", absorptionId: "a1" })).toEqual(
          []
        );

        // A fresh operation B2 from the SAME unchanged cycle, naming NO predecessor, is accepted (against
        // the phantom-B1 bug it would be rejected as stale). It registers normally.
        const b2 = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B2", [s2], { absorptionId: "a2" })
        );
        expect(b2.pendingCount).toBe(1);
        await marker.publish();
        await routing.registerBlockers(b2.registration);
        const after = await store.readBlockState(runId);
        expect(after.blockId).toBe("B2");
        expect(after.pendingIds).toEqual([s2]);
        expect(await liveWatchers(store, s2)).toBe(1);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "EARLY-DELIVERY SPAN: registering against an already-completed blocker reports its cached-span completion while the run stays blocked on another",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_span_early";
        const done = generateWaitpointId("MANUAL");
        const pending = generateWaitpointId("MANUAL");
        // `done` is a RUN waitpoint completed by run_child.
        await seedPending(store, done, "run_child");
        await seedPending(store, pending);

        // Complete `done` BEFORE the block, so registration finds it already completed (early delivery).
        await store.complete({
          waitpointId: done,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });

        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [done, pending], { spanIdToComplete: "span_x" })
        );
        const result = await routing.registerBlockers(registration);

        // The run stays blocked on `pending`, but `done`'s cached span is reported once with the completed
        // run identity as cachedRunId.
        expect(result.pendingCount).toBe(1);
        expect(result.cachedSpanCompletions).toEqual([
          {
            spanId: "span_x",
            spanCreatedAt: expect.any(String),
            blockedRunId: runId,
            hasError: false,
            cachedRunId: "run_child",
          },
        ]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "RACING SPAN: a completion landing between absorb and registration reports the cached-span completion with the completed run identity",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_span_race";
        const wp = generateWaitpointId("MANUAL");
        await seedPending(store, wp, "run_child");

        // Absorb sees the waitpoint still pending; the completion then RACES in before registration.
        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [wp], { spanIdToComplete: "span_r" })
        );
        await store.complete({
          waitpointId: wp,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        const result = await routing.registerBlockers(registration);

        expect(result.cachedSpanCompletions).toEqual([
          {
            spanId: "span_r",
            spanCreatedAt: expect.any(String),
            blockedRunId: runId,
            hasError: false,
            cachedRunId: "run_child",
          },
        ]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "FENCE FLOW: an owed cleanup refuses a rollover through the routing seam; abandon lifts the fence, then the rollover installs; a delayed B1 abandon cannot touch B2",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const { routing } = buildRouting(store, prisma);
      try {
        const runId = "run_fenceflow";
        const s1 = generateWaitpointId("MANUAL");
        const s2 = generateWaitpointId("MANUAL");
        const otherTargets = Array.from({ length: RUN_CLEANUP_PAGE_SIZE }, () =>
          generateWaitpointId("MANUAL")
        );
        for (const id of [s1, s2, ...otherTargets]) await seedPending(store, id);

        // More than one page must converge through the real adapter before it lifts the fence.
        const { registration } = await routing.absorbBlockers(
          absorbArgs(prisma, runId, "B1", [s1, ...otherTargets], { absorptionId: "B1" })
        );
        await routing.registerBlockers(registration);
        await routing.armCleanupFence({ runId, blockId: "B1", organizationId: ORG });

        // A rolled-over B2 is REFUSED while B1's cleanup is owed — and nothing was mutated.
        await expect(
          routing.absorbBlockers(
            absorbArgs(prisma, runId, "B2", [s2], {
              expectedPreviousBlockId: "B1",
              absorptionId: "B2",
            })
          )
        ).rejects.toBeInstanceOf(StoreWaitpointBlockRefusedError);
        expect((await store.readBlockState(runId)).blockId).toBe("B1");
        expect(await liveWatchers(store, s2)).toBe(0);

        // Re-arming the same fence is idempotent (a retried failed-attempt operation).
        await routing.armCleanupFence({ runId, blockId: "B1", organizationId: ORG });

        // Cleanup abandons B1 (legacy delete, then store retain-and-clear/withdrawal) and lifts the fence
        // LAST. The non-terminal abandon cleared the active block, so the next attempt's B2 installs fresh.
        expect(
          (await routing.abandonRunBlockers({ runId, blockId: "B1", organizationId: ORG })).count
        ).toBe(RUN_CLEANUP_PAGE_SIZE + 1);
        expect(await liveWatchers(store, s1)).toBe(0);
        expect(await liveWatchers(store, otherTargets[otherTargets.length - 1]!)).toBe(0);
        expect(await store.readWithdrawalPage({ runId, blockId: "B1" })).toBeUndefined();
        await routing.absorbBlockers(absorbArgs(prisma, runId, "B2", [s2], { absorptionId: "B2" }));
        const afterB2 = await store.readBlockState(runId);
        expect(afterB2.blockId).toBe("B2");
        expect(afterB2.pendingIds).toEqual([s2]);

        // A DELAYED B1 abandon (an obligation redelivery arriving after B2 installed) is fenced to B1 and
        // cannot drain or withdraw B2's state — nor can its fence-clear lift B2's absence of a fence.
        await routing.abandonRunBlockers({ runId, blockId: "B1", organizationId: ORG });
        await routing.resumeRetainedWithdrawal({ runId, blockId: "B1", organizationId: ORG });
        const b2Intact = await store.readBlockState(runId);
        expect(b2Intact.blockId).toBe("B2");
        expect(b2Intact.pendingIds).toEqual([s2]);
      } finally {
        await store.quit();
      }
    }
  );
});
