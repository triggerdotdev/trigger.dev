import { createRedisClient } from "@internal/redis";
import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { hasStoreWaitpoints, PostgresRunStore, RedisSnapshotStore } from "@internal/run-store";
import { generateRunOpsId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import {
  runContributionKey,
  runBlockKeys,
  runResultKey,
  organizationRunIndexKey,
  fanoutPartition,
} from "../waitpointCoordinator/keys.js";
import { describe, expect, vi } from "vitest";
import type { RunEngine } from "../index.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { storeCommandBarrier } from "./utils/storeCommandBarrier.js";
import {
  createTestStore,
  quitTestStore,
  rejectStoreCommand,
  rejectRegistration,
} from "./utils/storeTestAccess.js";
import {
  boundedBarrier,
  deferred,
  makeEngine,
  seedStoreWaitpoint,
  runToExecuting,
  describeLiveWatchers,
  captureAnchor,
  blockStore,
} from "./utils/storeWaitpointBlockCycle.setup.js";

describe("Store waitpoint block cycle: admission", () => {
  containerTestWithIsolatedRedis(
    "saved old operation cannot recreate unindexed state after terminal cleanup and native tombstone expiry",
    async ({ prisma, redisOptions }) => {
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
      const store = await createTestStore(redisOptions),
        redis = createRedisClient(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshots);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_oldoperation");
        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const operation = {
          runId: run.id,
          organizationId: env.organization.id,
          projectId: env.project.id,
          waitpoints: [wp],
          blockOperation: {
            id: "saved-cycle",
            absorptionId: "saved-absorb",
            cycleAnchor: await captureAnchor(engine, run.id),
          },
        };
        await blockStore(engine, operation);
        const registry = organizationRunIndexKey(env.organization.id, fanoutPartition(run.id));
        expect(await redis.zscore(registry, run.id)).toBe("0");
        await engine.cancelRun({ runId: run.id });
        expect(await redis.zscore(registry, run.id)).toBeNull();
        const keys = runBlockKeys(run.id);
        // Exercise the real Redis expiry boundary after successful terminal cleanup.
        await redis.pexpire(keys.state, 1);
        await redis.pexpire(runResultKey(run.id), 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await redis.exists(keys.state, runResultKey(run.id))).toBe(0);
        await expect(blockStore(engine, operation)).rejects.toThrow();
        expect(await redis.zscore(registry, run.id)).toBeNull();
        expect(await redis.exists(...Object.values(keys), runResultKey(run.id))).toBe(0);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshots.quit();
        redis.disconnect();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "COMPENSATION RACE: a compensation paused before its atomic Redis command cannot drain a same-absorptionId retry's freshly-registered edge (run-lock serialized); a second absorption is untouched",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      const barrier = await storeCommandBarrier(redisOptions);
      const compensationStore = await createTestStore(barrier.redisOptions);
      const compensationEngine = makeEngine(
        prisma,
        redisOptions,
        compensationStore,
        snapshotStore,
        undefined,
        undefined,
        undefined,
        undefined,
        true
      );
      let compensation: Promise<void> | undefined;
      let retry: Promise<unknown> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_comprace");
        const anchor = await captureAnchor(engine, run.id);

        // wp1 is absorption "a1": its FIRST registration is faulted with a real pending source,
        // so block B and a1's contribution survive with no watcher — exactly the residue a mixed-
        // residency absorption leaves when the store half committed but the operation did not complete.
        const wp1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const wp2 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const opA1 = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp1],
          blockOperation: { id: "B", absorptionId: "a1", cycleAnchor: anchor },
        };

        // 1. a1's first attempt fails in phase 3 AFTER absorb wrote block B + the a1 contribution.
        // Both survive; no watcher was registered.
        await rejectRegistration(store, wp1, () => blockStore(engine, opA1));
        expect((await store.readBlockState(run.id)).blockId).toBe("B");
        expect(
          (await store.readContribution({ runId: run.id, blockId: "B", absorptionId: "a1" })).length
        ).toBeGreaterThan(0);
        expect(await describeLiveWatchers(store, wp1)).toBe(0);

        // 2. A DIFFERENT additive absorption "a2" (wp2) succeeds on the same block, registering wp2.
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp2],
          blockOperation: { id: "B", absorptionId: "a2", cycleAnchor: anchor },
        });
        expect(await describeLiveWatchers(store, wp2)).toBe(1);

        // 3. The one-shot registration fault is exhausted; a1's retry can register the existing source.

        // 4. Fire a1's compensation and let it read the contribution, then delay its actual atomic Redis request.
        await compensationStore.compensateAbsorption({
          runId: "warm",
          blockId: "warm",
          absorptionId: "warm",
        });
        const started = barrier.pauseNextRequest();
        compensation = compensationEngine.waitpointSystem.ensureAbsorptionCompensated({
          runId: run.id,
          organizationId: env.organization.id,
          blockId: "B",
          absorptionId: "a1",
        });
        await boundedBarrier(started, "compensation never reached its Redis request barrier");
        expect(barrier.request()).toContain(runContributionKey(run.id, "B", "a1")); // compensation holds the run lock, paused before its atomic Redis command

        // 5. Retry a1 while compensation is paused. Under the shared run lock it BLOCKS behind the
        // compensation; without it, it would run to completion here and re-register wp1's edge — which
        // the released compensation would then drain, stranding wp1's watcher.
        let retrySettled = false;
        retry = blockStore(engine, opA1).finally(() => {
          retrySettled = true;
        });

        // Give a lock-less retry ample time to finish before we release.
        await new Promise((r) => setTimeout(r, 100));
        expect(retrySettled, "same-absorption retry crossed the compensation run lock").toBe(false);
        barrier.release();
        await compensation;
        await retry;

        // 6. Final state is the retry's correct registered block: wp1 pending with a live watcher, and
        // the a2 additive edge (wp2) untouched by a1's compensation or acknowledgement.
        const state = await store.readBlockState(run.id);
        expect(state.blockId).toBe("B");
        expect(state.pendingIds.sort()).toEqual([wp1, wp2].sort());
        expect(state.edges).toHaveLength(2);
        expect(await describeLiveWatchers(store, wp1)).toBe(1);
        expect(await describeLiveWatchers(store, wp2)).toBe(1);
        expect(
          (await store.readContribution({ runId: run.id, blockId: "B", absorptionId: "a1" })).length
        ).toBe(0);
      } finally {
        barrier.release();
        await Promise.allSettled([compensation, retry]);
        await compensationEngine.quit();
        await quitTestStore(compensationStore);
        await barrier.close();
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "COMPENSATION FIRST: a compensation that fully drains an absorption before the run retries it leaves the retry free to re-establish a correct registered block",
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
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_compfirst");
        const anchor = await captureAnchor(engine, run.id);

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const op = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "B", absorptionId: "a1", cycleAnchor: anchor },
        };

        // 1. Fault first registration of the real pending source: block B + a1 contribution survive
        // phase 3 with no watcher.
        await rejectRegistration(store, wp, () => blockStore(engine, op));
        expect(
          (await store.readContribution({ runId: run.id, blockId: "B", absorptionId: "a1" })).length
        ).toBeGreaterThan(0);

        // 2. Compensation runs to completion FIRST: a1's edge is drained and its contribution retired.
        await engine.waitpointSystem.ensureAbsorptionCompensated({
          runId: run.id,
          organizationId: env.organization.id,
          blockId: "B",
          absorptionId: "a1",
        });
        expect(
          (await store.readContribution({ runId: run.id, blockId: "B", absorptionId: "a1" })).length
        ).toBe(0);
        expect((await store.readBlockState(run.id)).pendingIds).not.toContain(wp);

        // 3. Retry the SAME operation with the fault exhausted; it restores a correct registered block.
        await blockStore(engine, op);

        const state = await store.readBlockState(run.id);
        expect(state.blockId).toBe("B");
        expect(state.pendingIds).toEqual([wp]);
        expect(state.edges).toHaveLength(1);
        expect(await describeLiveWatchers(store, wp)).toBe(1);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "ABSORPTION FENCE: a real failed attempt whose store cleanup is lost keeps its block cleanup-owed, refusing a newer block until the obligation converges",
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
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_absfence");

        const s1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const blocked = await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [s1],
          blockOperation: { id: "B1", cycleAnchor: await captureAnchor(engine, run.id) },
        });

        // A helper that tries to install a DIFFERENT store block B2 directly through the low-level absorb
        // (the store half of what attempt two's blockRunWithWaitpoint would do).
        const s2 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const tryInstallB2 = () =>
          store.absorbBlockers({
            runId: run.id,
            blockId: "B2",
            edges: [{ waitpointId: s2, createdAt: new Date().toISOString(), type: "MANUAL" }],
            expectedPreviousBlockId: "B1",
            absorptionId: "B2",
          });

        // The attempt fails retryably, but the inline store cleanup is LOST — so B1's cross-store cleanup
        // stays owed after the retry transition commits (models a crash between the transition and cleanup).
        await rejectStoreCommand(store, "set", () =>
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: blocked.id,
            completion: {
              ok: false,
              id: run.id,
              error: { type: "BUILT_IN_ERROR", name: "Error", message: "retry", stackTrace: "" },
              retry: { timestamp: Date.now() + 50, delay: 50 },
            },
          })
        );

        // B1 is still owed: the fence armed before the transition refuses a rolled-over B2.
        expect((await tryInstallB2()).outcome).toBe("cleanupOwed");
        expect((await store.readBlockState(run.id)).blockId).toBe("B1");

        // The committed retry transition (its id is stamped as the current snapshot) is the obligation's
        // proof. The obligation re-drives B1's cleanup (the fault is gone) and lifts the fence LAST.
        const retryTransitionId = (await engine.getRunExecutionData({ runId: run.id }))!.snapshot
          .id;
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "B1",
          transitionId: retryTransitionId,
        });

        // With cleanup converged, a fresh B2 (the abandon cleared the active block) installs normally.
        const b2 = await store.absorbBlockers({
          runId: run.id,
          blockId: "B2",
          edges: [{ waitpointId: s2, createdAt: new Date().toISOString(), type: "MANUAL" }],
          absorptionId: "B2",
        });
        expect(b2.outcome).toBe("absorbed");
        expect((await store.readBlockState(run.id)).blockId).toBe("B2");
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "CLEANUP FENCE: a queued retry refuses legacy-only waits until the previous block cleanup converges",
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
        () => true,
        1,
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma })
      );
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_cleanupretry");
        const common = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        };
        const source = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const blocked = await blockStore(engine, {
          ...common,
          waitpoints: [source],
          blockOperation: { id: "B1", cycleAnchor: await captureAnchor(engine, run.id) },
        });

        await rejectStoreCommand(store, "set", () =>
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: blocked.id,
            completion: {
              ok: false,
              id: run.id,
              error: { type: "BUILT_IN_ERROR", name: "Error", message: "retry", stackTrace: "" },
              retry: { timestamp: Date.now() + 50, delay: 50 },
            },
          })
        );
        const retry = (await engine.getRunExecutionData({ runId: run.id }))!.snapshot;
        expect(retry.executionStatus).toBe("QUEUED");
        const dequeued = await vi.waitFor(
          async () => {
            const rows = await engine.dequeueFromWorkerQueue({
              consumerId: "cleanup-retry",
              workerQueue: "main",
              blockingPopTimeoutSeconds: 1,
            });
            expect(rows, "retry never reached the worker queue").toHaveLength(1);
            return rows;
          },
          { timeout: 10_000, interval: 100 }
        );
        const started = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });
        const legacy = await engine.createManualWaitpoint({
          ...common,
          runId: undefined,
          environmentId: env.id,
        });
        const batch = await prisma.batchTaskRun.create({
          data: {
            id: "cleanup_retry_batch",
            friendlyId: "batch_cleanup_retry",
            runtimeEnvironmentId: env.id,
          },
        });
        const header = { ...common, environmentId: env.id, batchId: batch.id };
        const childParams = {
          number: 1,
          friendlyId: `run_${generateRunOpsId()}`,
          environment: env,
          taskIdentifier: "test-task",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "cleanup_child_trace",
          spanId: "cleanup_child_span",
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
          parentTaskRunId: run.id,
          resumeParentOnCompletion: true,
          idempotencyKey: "cleanup_child_key",
          // BATCH creation deliberately retains the legacy admission contract after native RUN rollout.
          batch: { id: batch.id, index: 0 },
        };
        const failedParams = {
          friendlyId: `run_${generateRunOpsId()}`,
          environment: env,
          taskIdentifier: "test-task",
          parentTaskRunId: run.id,
          resumeParentOnCompletion: true,
          error: { type: "STRING_ERROR" as const, raw: "failed at creation" },
          batch: { id: batch.id, index: 1 },
        };
        const debounce = {
          key: "cleanup_cached_child",
          delay: "1h",
          mode: "leading" as const,
        };
        const debouncedChild = await engine.trigger(
          {
            ...childParams,
            friendlyId: `run_${generateRunOpsId()}`,
            parentTaskRunId: undefined,
            resumeParentOnCompletion: false,
            idempotencyKey: undefined,
            delayUntil: new Date(Date.now() + 3_600_000),
            debounce,
          },
          prisma
        );
        const cachedAssociation = await engine.getOrCreateRunWaitpoint({
          runId: debouncedChild.id,
          projectId: env.project.id,
          environmentId: env.id,
        });
        expect(
          await prisma.waitpoint.count({
            where: { id: cachedAssociation.id, completedByTaskRunId: debouncedChild.id },
          })
        ).toBe(1);
        let publishedCachedSpans = 0;
        const cachedSpanId = "cleanup_cached_span";
        const cachedParams = {
          ...childParams,
          friendlyId: `run_${generateRunOpsId()}`,
          idempotencyKey: undefined,
          debounce,
          onDebounced: async ({
            waitpoint,
            blockRun,
          }: Parameters<NonNullable<Parameters<RunEngine["trigger"]>[0]["onDebounced"]>>[0]) => {
            expect(blockRun).toBeUndefined();
            // Preserve legacy trace-before-registration ordering once admission is safe.
            expect(
              await prisma.taskRunWaitpoint.count({
                where: { taskRunId: run.id, waitpointId: waitpoint.id },
              })
            ).toBe(0);
            publishedCachedSpans++;
            return cachedSpanId;
          },
        };

        await expect(engine.trigger(cachedParams, prisma)).rejects.toMatchObject({
          outcome: "cleanupOwed",
        });
        expect(publishedCachedSpans).toBe(0);

        // These explicit legacy batch producers must still pass admission before child/key commit.
        // The cached child likewise reuses its existing PostgreSQL association.
        await expect(engine.trigger(childParams, prisma)).rejects.toMatchObject({
          outcome: "cleanupOwed",
        });
        await expect(engine.createFailedTaskRun(failedParams)).rejects.toMatchObject({
          outcome: "cleanupOwed",
        });
        expect(
          await prisma.taskRun.count({
            where: { friendlyId: { in: [childParams.friendlyId, failedParams.friendlyId] } },
          })
        ).toBe(0);

        await expect(engine.blockRunWithCreatedBatch(header)).rejects.toMatchObject({
          outcome: "cleanupOwed",
          currentBlockId: "B1",
        });
        expect(await prisma.waitpoint.count({ where: { completedByBatchId: batch.id } })).toBe(0);

        await expect(
          engine.blockRunWithWaitpoint({ ...common, waitpoints: legacy.waitpoint.id })
        ).rejects.toMatchObject({ outcome: "cleanupOwed", currentBlockId: "B1" });
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: run.id, waitpointId: legacy.waitpoint.id },
          })
        ).toBe(0);
        expect((await engine.getRunExecutionData({ runId: run.id }))!.snapshot.id).toBe(
          started.snapshot.id
        );

        const cleanup = {
          runId: run.id,
          organizationId: env.organization.id,
          blockId: "B1",
          transitionId: retry.id,
        };
        await engine.waitpointSystem.ensureBlockersCleanedUp(cleanup);
        const cachedChild = await engine.trigger(cachedParams, prisma);
        expect(cachedChild.id).toBe(debouncedChild.id);
        expect(publishedCachedSpans).toBe(1);
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: run.id, spanIdToComplete: cachedSpanId },
          })
        ).toBe(1);
        const child = await engine.trigger(childParams, prisma);
        expect(await engine.runQueue.messageExists(env.organization.id, child.id)).toBeTruthy();
        await engine.createFailedTaskRun(failedParams);
        const batchWaitpoint = await engine.blockRunWithCreatedBatch(header);
        expect(batchWaitpoint).not.toBeNull();
        await engine.blockRunWithWaitpoint({ ...common, waitpoints: legacy.waitpoint.id });
        // An old replay can no longer delete the later attempt's accepted legacy edge.
        await engine.waitpointSystem.ensureBlockersCleanedUp(cleanup);
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: run.id, waitpointId: legacy.waitpoint.id },
          })
        ).toBe(1);
        expect((await engine.waitpointSystem.continueRunIfUnblocked(common)).status).toBe(
          "blocked"
        );
        await engine.cancelRun({ runId: child.id });
        await engine.cancelRun({ runId: debouncedChild.id });
        await engine.completeWaitpoint({
          id: legacy.waitpoint.id,
          organizationId: env.organization.id,
        });
        await engine.completeWaitpoint({
          id: batchWaitpoint!.id,
          organizationId: env.organization.id,
        });
        expect((await engine.waitpointSystem.continueRunIfUnblocked(common)).status).toBe(
          "unblocked"
        );
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "CLEANUP FENCE: marked lockless batch admission reads the fence under the cleanup run lock",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      const locked = deferred();
      const release = deferred();
      let cleanup: Promise<unknown> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_cleanuplockless");
        const common = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        };
        const source = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          ...common,
          waitpoints: [source],
          blockOperation: { id: "B1", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        const legacy = await engine.createManualWaitpoint({
          ...common,
          runId: undefined,
          environmentId: env.id,
        });
        const batch = await prisma.batchTaskRun.create({
          data: {
            id: "cleanup_batch",
            friendlyId: "batch_cleanup",
            runtimeEnvironmentId: env.id,
          },
        });

        cleanup = engine["runLock"].lock("prepareCleanup", [run.id], async () => {
          locked.resolve();
          await boundedBarrier(release.promise, "test never released the cleanup run lock");
          await engine.waitpointSystem.prepareFailedAttemptCleanup({
            runId: run.id,
            organizationId: env.organization.id,
            transitionId: SnapshotId.generate().id,
          });
        });
        await boundedBarrier(locked.promise, "cleanup never acquired the run lock");
        let settled = false;
        const admission = engine.waitpointSystem
          .blockRunWithWaitpointLockless({
            ...common,
            waitpoints: legacy.waitpoint.id,
            batch: { id: batch.id, index: 7 },
          })
          .then(
            () => {
              settled = true;
            },
            (error: unknown) => {
              settled = true;
              return error;
            }
          );
        // The actual Redis run lock remains held at a deterministic cleanup barrier. Admission must
        // wait rather than authorizing a PG write from a fence read made before cleanup arms it.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(false);
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: run.id, waitpointId: legacy.waitpoint.id },
          })
        ).toBe(0);
        release.resolve();
        await cleanup;
        expect(await admission).toMatchObject({ outcome: "cleanupOwed", currentBlockId: "B1" });
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: run.id, waitpointId: legacy.waitpoint.id },
          })
        ).toBe(0);
      } finally {
        release.resolve();
        await cleanup;
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  // Catches: a legacy edge written for a stale-unmarked parent after the first native cleanup fence is armed.
  containerTestWithIsolatedRedis(
    "CLEANUP FENCE: an initially unmarked legacy batch producer cannot write its edge across the first native cleanup",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(
        prisma,
        redisOptions,
        store,
        snapshotStore,
        undefined,
        () => true,
        undefined,
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma })
      );
      const locked = deferred();
      const release = deferred();
      let firstNative: Promise<void> | undefined;
      let producer: Promise<unknown> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_firstnative");
        expect(
          hasStoreWaitpoints(
            (await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).annotations
          )
        ).toBe(false);
        const common = {
          runId: run.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        };
        const source = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        firstNative = engine["runLock"].lock("firstNativeCleanup", [run.id], async () => {
          locked.resolve();
          await boundedBarrier(release.promise, "test never released the cleanup run lock");
          await blockStore(engine, {
            ...common,
            waitpoints: [source],
            blockOperation: { id: "B1", cycleAnchor: await captureAnchor(engine, run.id) },
          });
          await engine.waitpointSystem.prepareFailedAttemptCleanup({
            runId: run.id,
            organizationId: env.organization.id,
            transitionId: SnapshotId.generate().id,
          });
        });
        await boundedBarrier(locked.promise, "cleanup never acquired the run lock");
        const batch = await prisma.batchTaskRun.create({
          data: {
            id: "first_native_legacy_batch",
            friendlyId: "batch_first_native_legacy",
            runtimeEnvironmentId: env.id,
          },
        });
        const childId = generateRunOpsId();
        const friendlyId = `run_${childId}`;
        producer = engine
          .trigger(
            {
              number: 1,
              friendlyId,
              environment: env,
              taskIdentifier: "test-task",
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: "first_native_child_trace",
              spanId: "first_native_child_span",
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
              parentTaskRunId: run.id,
              resumeParentOnCompletion: true,
              idempotencyKey: "first_native_child_key",
              batch: { id: batch.id, index: 0 },
            },
            prisma
          )
          .then(
            () => undefined,
            (error: unknown) => error
          );
        // The child commits on the stale false marker while the first native section holds the
        // parent lock; its edge write waits for that lock and then reads the armed cleanup fence.
        await vi.waitFor(
          async () => expect(await prisma.taskRun.count({ where: { friendlyId } })).toBe(1),
          { timeout: 3_000, interval: 25 }
        );
        release.resolve();
        await firstNative;
        expect(await producer).toMatchObject({ outcome: "cleanupOwed", currentBlockId: "B1" });
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
        expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBeFalsy();
        // The committed child is retired, not orphaned: terminal, with its idempotency key freed.
        const child = await prisma.taskRun.findFirstOrThrow({ where: { friendlyId } });
        expect(child.status).toBe("SYSTEM_FAILURE");
        expect(child.idempotencyKey).toBeNull();
      } finally {
        release.resolve();
        await firstNative;
        await producer;
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );
});
