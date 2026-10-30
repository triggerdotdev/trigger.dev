import { registrationEvidence } from "./keys.js";
// Test the three-phase protocol with the real router, adapter, Redis and Postgres.
// Cover block identity, resume acknowledgement, cleanup and fanout.
// Restart tests reconstruct registration from saved data. They do not run production recovery jobs;
// those jobs are tested in the engine integration suite.

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
import { describe, expect } from "vitest";
import { StoreWaitpointBlockOperationIdentityRequired } from "../errors.js";

import { RoutingWaitpointCoordinator } from "./routingCoordinator.js";
import {
  StoreWaitpointBlockRefusedError,
  StoreWaitpointCoordinator,
} from "./storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
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
  await store.createIfAbsent({
    record: {
      id: waitpointId,
      friendlyId: WaitpointId.toFriendlyId(waitpointId),
      type: "MANUAL",
      environmentId: "env_1",
      projectId: "proj_1",
      createdAt: now,
      updatedAt: now,
      userProvidedIdempotencyKey: false,
      tags: [],
      completedByTaskRunId,
    },
    status: "PENDING",
  });
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
            await adapter.complete({ waitpointId: wp, output: { value: "ok", isError: false } });
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
});
