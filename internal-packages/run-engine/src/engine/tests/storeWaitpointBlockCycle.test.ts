import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { hasStoreWaitpoints, RedisSnapshotStore } from "@internal/run-store";
import { describe, expect, vi } from "vitest";
import { StoreWaitpointBlockCycleAdvanced } from "../errors.js";
import { getLatestExecutionSnapshot } from "../systems/executionSnapshotSystem.js";
import { cycleAnchorSnapshotId } from "../systems/waitpointSystem.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  createTestStore,
  quitTestStore,
  restoreStoreAccess,
  disableStoreAccess,
  rejectStoreCommand,
  rejectRegistration,
} from "./utils/storeTestAccess.js";
import {
  makeEngine,
  seedStoreWaitpoint,
  runToExecuting,
  describeLiveWatchers,
  captureAnchor,
  blockStore,
} from "./utils/storeWaitpointBlockCycle.setup.js";

describe("Store waitpoint block cycle: identity", () => {
  containerTestWithIsolatedRedis(
    "RUN MARKER: rollback restores the legacy path without touching existing store state",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      let enabled = true;
      const coordinator = new StoreWaitpointCoordinator({ store });
      const engine = makeEngine(
        prisma,
        redisOptions,
        store,
        snapshotStore,
        coordinator,
        () => enabled
      );
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_marked");
        const other = await runToExecuting(engine, env, "test-task", prisma, "run_unmarked");
        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId); // MANUAL, no deadline
        expect(
          hasStoreWaitpoints(
            (await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).annotations
          )
        ).toBe(false);
        const block = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
          waitpoints: [wp],
          blockOperation: { id: "marker_block", cycleAnchor: await captureAnchor(engine, run.id) },
        };
        await rejectStoreCommand(store, "hset", () => blockStore(engine, block));
        expect(
          hasStoreWaitpoints(
            (await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).annotations
          )
        ).toBe(true);
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();
        await blockStore(engine, block);
        expect(
          hasStoreWaitpoints(
            (await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).annotations
          )
        ).toBe(true);
        const beforeRollback = await store.readBlockState(run.id);
        enabled = false;
        await disableStoreAccess(store);
        await engine.waitpointSystem.continueRunIfUnblocked({
          runId: other.id,
          organizationId: env.organization.id,
        });
        await engine.waitpointSystem.continueRunIfUnblocked({
          runId: run.id,
          organizationId: env.organization.id,
        });
        await expect(
          engine.waitpointSystem.completeWaitpoint({
            id: wp,
            organizationId: env.organization.id,
          })
        ).rejects.toThrow("Waitpoint not found");
        await expect(blockStore(engine, block)).rejects.toThrow("foreign key constraint");
        expect(await prisma.waitpoint.count({ where: { id: wp } })).toBe(0);
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
        await restoreStoreAccess(store);
        expect(await store.readBlockState(run.id)).toEqual(beforeRollback);
        // Retain existing data, but disabled routing does not drain it or mark unrelated runs.
        expect(
          hasStoreWaitpoints(
            (await prisma.taskRun.findFirstOrThrow({ where: { id: other.id } })).annotations
          )
        ).toBe(false);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "IDENTITY: additive registration and a retry in one cycle share the block id; a later cycle gets a fresh id",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_ident");

        const wp1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const wp2 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        // Capture cycle 1's anchor when the operation begins; the caller carries it across the cycle.
        const anchor1 = await captureAnchor(engine, run.id);
        const args = (waitpoints: string[], id: string, cycleAnchor: string) => ({
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints,
          blockOperation: { id, cycleAnchor },
        });

        // First block of cycle 1 under the caller's own operation id.
        await blockStore(engine, args([wp1], "op_c1", anchor1));
        expect((await store.readBlockState(run.id)).blockId).toBe("op_c1");
        expect((await store.readBlockState(run.id)).pendingIds.sort()).toEqual([wp1].sort());

        // Additive registration in the SAME cycle: the caller carries the SAME operation id and anchor.
        await blockStore(engine, args([wp2], "op_c1", anchor1));
        expect((await store.readBlockState(run.id)).blockId).toBe("op_c1");
        expect((await store.readBlockState(run.id)).pendingIds.sort()).toEqual([wp1, wp2].sort());

        // A retry of the operation (same id, same anchor) converges on the same block, idempotent.
        await blockStore(engine, args([wp1], "op_c1", anchor1));
        expect((await store.readBlockState(run.id)).blockId).toBe("op_c1");
        expect((await store.readBlockState(run.id)).pendingIds.sort()).toEqual([wp1, wp2].sort());

        // Complete both blockers, deliver, and resume through the REAL continueRunIfUnblocked (which
        // observes the exact block and acknowledges it), returning the run to EXECUTING.
        for (const wp of [wp1, wp2]) {
          await engine.waitpointSystem.completeWaitpoint({ id: wp, organizationId: orgId });
          await store.deliverCompletion({
            runId: run.id,
            blockId: "op_c1",
            waitpointId: wp,
            completion: {
              completedAt: new Date().toISOString(),
              outputType: "application/json",
              outputIsError: false,
              output: null,
            },
          });
        }
        await engine.waitpointSystem.continueRunIfUnblocked({
          runId: run.id,
          organizationId: orgId,
        });
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined(); // acknowledged + cleared

        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("EXECUTING");
          },
          { timeout: 10_000, interval: 100 }
        );

        // A NEW cycle carries a DIFFERENT caller operation id AND a freshly captured anchor.
        const wp3 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const anchor2 = await captureAnchor(engine, run.id);
        expect(anchor2).not.toBe(anchor1);
        await blockStore(engine, args([wp3], "op_c2", anchor2));
        expect((await store.readBlockState(run.id)).blockId).toBe("op_c2");
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "STALE ACK: a stale acknowledgement of an older block cannot clear a newer cycle",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_staleack");

        const wp1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp1],
          blockOperation: { id: "sa_c1", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        const oldBlockId = (await store.readBlockState(run.id)).blockId!;
        expect(oldBlockId).toBe("sa_c1");

        // Resume cycle 1 fully.
        await engine.waitpointSystem.completeWaitpoint({ id: wp1, organizationId: orgId });
        await store.deliverCompletion({
          runId: run.id,
          blockId: oldBlockId,
          waitpointId: wp1,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        await engine.waitpointSystem.continueRunIfUnblocked({
          runId: run.id,
          organizationId: orgId,
        });
        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("EXECUTING");
          },
          { timeout: 10_000, interval: 100 }
        );

        // Cycle 2 installs a fresh block under a new caller operation id.
        const wp2 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp2],
          blockOperation: { id: "sa_c2", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        const newBlockId = (await store.readBlockState(run.id)).blockId!;
        expect(newBlockId).toBe("sa_c2");

        // A STALE acknowledgement carrying cycle 1's block id must NOT clear cycle 2's block.
        await store.acknowledgeResumeHandoff({ runId: run.id, blockId: oldBlockId });
        const state = await store.readBlockState(run.id);
        expect(state.blockId).toBe(newBlockId);
        expect(state.pendingIds).toEqual([wp2]);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "DELAYED REPLAY (newer cycle installed): replaying cycle 1's original operation is refused by the cycle-anchor precondition and leaves cycle 2 untouched",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_replay");

        const wp1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        // 1. Capture cycle 1's complete block operation — id AND cycle anchor — the way a delayed retry
        // would carry it verbatim.
        const cycle1Operation = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp1],
          blockOperation: { id: "replay_c1", cycleAnchor: await captureAnchor(engine, run.id) },
        };
        await blockStore(engine, cycle1Operation);
        expect((await store.readBlockState(run.id)).blockId).toBe("replay_c1");

        // 2. Complete and resume cycle 1.
        await engine.waitpointSystem.completeWaitpoint({ id: wp1, organizationId: orgId });
        await store.deliverCompletion({
          runId: run.id,
          blockId: "replay_c1",
          waitpointId: wp1,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        await engine.waitpointSystem.continueRunIfUnblocked({
          runId: run.id,
          organizationId: orgId,
        });
        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("EXECUTING");
          },
          { timeout: 10_000, interval: 100 }
        );

        // 3. Establish cycle 2 with a different blocker, operation id and freshly captured anchor.
        const wp2 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp2],
          blockOperation: { id: "replay_c2", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        const cycle2Before = await store.readBlockState(run.id);
        expect(cycle2Before.blockId).toBe("replay_c2");
        expect(cycle2Before.pendingIds).toEqual([wp2]);
        expect(await describeLiveWatchers(store, wp2)).toBe(1);
        const wp1WatchersBefore = await describeLiveWatchers(store, wp1);

        // 4. Replay the ORIGINAL cycle-1 operation through the production blockRunWithWaitpoint seam. Its
        // captured cycle anchor no longer matches the run's advanced cycle, so it is refused BEFORE any
        // MemoryDB mutation.
        await expect(blockStore(engine, cycle1Operation)).rejects.toBeInstanceOf(
          StoreWaitpointBlockCycleAdvanced
        );

        // 5. The refused replay mutated nothing: cycle 2's block id, pending set, edges and watcher are
        // unchanged, and it added no watcher on cycle 1's waitpoint.
        const cycle2After = await store.readBlockState(run.id);
        expect(cycle2After.blockId).toBe("replay_c2");
        expect(cycle2After.pendingIds).toEqual([wp2]);
        expect(cycle2After.edges).toHaveLength(1);
        expect(await describeLiveWatchers(store, wp2)).toBe(1);
        expect(await describeLiveWatchers(store, wp1)).toBe(wp1WatchersBefore);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "DELAYED REPLAY (after non-terminal abandon, no block installed): replaying cycle 1's operation is refused before any MemoryDB mutation, and the next attempt can block",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_abandonreplay");

        const wp1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        // 1. Block using cycle 1's complete operation.
        const cycle1Operation = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp1],
          blockOperation: { id: "ab_c1", cycleAnchor: await captureAnchor(engine, run.id) },
        };
        const blocked = await blockStore(engine, cycle1Operation);
        expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // 2. Fail the attempt retryably: the block is abandoned and MemoryDB now holds NO current block.
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: blocked.id,
          completion: {
            ok: false,
            id: run.id,
            error: {
              type: "BUILT_IN_ERROR" as const,
              name: "Error",
              message: "retry",
              stackTrace: "",
            },
            retry: { timestamp: Date.now() + 50, delay: 50 },
          },
        });
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();

        // 3+4. Replay the COMPLETE original operation. The store's CAS alone would classify it isFirst
        // (previous == ""); the caller-owned cycle-anchor precondition refuses it BEFORE any mutation.
        await expect(blockStore(engine, cycle1Operation)).rejects.toBeInstanceOf(
          StoreWaitpointBlockCycleAdvanced
        );
        const untouched = await store.readBlockState(run.id);
        expect(untouched.blockId).toBeUndefined();
        expect(untouched.pendingIds).toEqual([]);
        expect(untouched.edges).toEqual([]);
        expect(untouched.deliveredIds).toEqual([]);
        expect(await describeLiveWatchers(store, wp1)).toBe(0);

        // 5. The next attempt can establish a fresh block cycle normally.
        await vi.waitFor(
          async () => {
            const dequeued = await engine.dequeueFromWorkerQueue({
              consumerId: "c_abandon_replay2",
              workerQueue: "main",
              blockingPopTimeoutSeconds: 1,
            });
            if (dequeued.length === 1) {
              const attempt = await engine.startRunAttempt({
                runId: dequeued[0]!.run.id,
                snapshotId: dequeued[0]!.snapshot.id,
              });
              expect(attempt.snapshot.executionStatus).toBe("EXECUTING");
            } else {
              const ed = await engine.getRunExecutionData({ runId: run.id });
              expect(
                ed?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
            }
          },
          { timeout: 15_000, interval: 200 }
        );
        const wp2 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp2],
          blockOperation: { id: "ab_c2", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        expect((await store.readBlockState(run.id)).blockId).toBe("ab_c2");
        expect((await store.readBlockState(run.id)).pendingIds).toEqual([wp2]);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "SUSPENDED-BLOCK RETRY: a phase-3 failure of a block that transitioned to SUSPENDED retries without a false cycle-advance",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const coordinator = new StoreWaitpointCoordinator({ store });
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore, coordinator);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;

        // 1. A triggered-but-not-started run is QUEUED: blocking it transitions to SUSPENDED (not
        // EXECUTING_WITH_WAITPOINTS), which is the shape this test exercises.
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_suspblk",
            environment: env,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_suspblk",
            spanId: "s_suspblk",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );
        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("QUEUED");
          },
          { timeout: 10_000, interval: 100 }
        );

        // 2. Capture the operation anchor from the pre-block (QUEUED) snapshot.
        const anchor = await captureAnchor(engine, run.id);

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const operation = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "susp_op", cycleAnchor: anchor },
        };

        // 3. Fail first registration AFTER the durable SUSPENDED transition, using a real pending
        // source so pre-absorption validation succeeds. Absorb and phase 2 must already have committed.
        await rejectRegistration(store, wp, () => blockStore(engine, operation));
        const afterPhase2 = await engine.getRunExecutionData({ runId: run.id });
        expect(afterPhase2?.snapshot.executionStatus).toBe("SUSPENDED");
        expect((await store.readBlockState(run.id)).blockId).toBe("susp_op");
        expect(await describeLiveWatchers(store, wp)).toBe(0); // registration did not finish

        // 4. Retry the SAME complete operation after the one-shot registration fault is exhausted.

        // 5. The original anchor is still valid (no false StoreWaitpointBlockCycleAdvanced), the same
        // block id is reused, and registration converges.
        await blockStore(engine, operation);
        const state = await store.readBlockState(run.id);
        expect(state.blockId).toBe("susp_op");
        expect(state.pendingIds).toEqual([wp]);
        expect(await describeLiveWatchers(store, wp)).toBe(1);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  for (const enabled of [true, false])
    containerTestWithIsolatedRedis(
      `checkpoint registration recovery keeps enabled=${enabled} cycle metadata fenced`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = await createTestStore(redisOptions);
        const coordinator = new StoreWaitpointCoordinator({ store });
        const engine = makeEngine(
          prisma,
          redisOptions,
          store,
          snapshotStore,
          coordinator,
          () => enabled
        );
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, "test-task");
          const run = await runToExecuting(
            engine,
            env,
            "test-task",
            prisma,
            `run_checkpoint${enabled}`
          );
          const legacy = await engine.createManualWaitpoint({
            environmentId: env.id,
            projectId: env.projectId,
            organizationId: env.organizationId,
          });
          await engine.blockRunWithWaitpoint({
            runId: run.id,
            waitpoints: legacy.waitpoint.id,
            projectId: env.projectId,
            organizationId: env.organizationId,
          });
          const id = await seedStoreWaitpoint(store, env.id, env.projectId, env.organizationId);
          const operation = {
            id: `checkpoint_${enabled}`,
            cycleAnchor: cycleAnchorSnapshotId(
              await getLatestExecutionSnapshot(prisma, run.id, engine.runStore)
            ),
          };
          const args = {
            runId: run.id,
            projectId: env.projectId,
            organizationId: env.organizationId,
            waitpoints: [id],
            blockOperation: operation,
          };
          if (enabled) await rejectRegistration(store, id, () => blockStore(engine, args));
          const blocked = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
          const checkpoint = await engine.createCheckpoint({
            runId: run.id,
            snapshotId: blocked.id,
            checkpoint: { type: "DOCKER", reason: "test", location: "test", imageRef: "test" },
          });
          expect(checkpoint.ok).toBe(true);
          const suspended = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
          if (enabled) {
            expect(cycleAnchorSnapshotId(suspended)).toBe(operation.cycleAnchor);
            await blockStore(engine, args);
            expect((await store.describeWaitpoint(id)).outcome).toBe("exists");
            expect(await describeLiveWatchers(store, id)).toBe(1);
            await expect(
              blockStore(engine, {
                ...args,
                blockOperation: { ...operation, cycleAnchor: "prior_attempt" },
              })
            ).rejects.toThrow();
            expect(await describeLiveWatchers(store, id)).toBe(1);
          } else {
            expect(suspended.metadata).toEqual(blocked.metadata);
            expect(cycleAnchorSnapshotId(suspended)).toBe(suspended.id);
          }
        } finally {
          await engine.quit();
          await quitTestStore(store);
          await snapshotStore.quit();
        }
      }
    );
});
