import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { PostgresRunStore, RedisSnapshotStore } from "@internal/run-store";
import { SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient } from "@internal/redis";
import {
  runBlockKeys,
  runWithdrawalKey,
  organizationRunIndexKey,
  fanoutPartition,
  runContributionIndexKey,
} from "../waitpointCoordinator/keys.js";
import { describe, expect, vi } from "vitest";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  createTestStore,
  quitTestStore,
  rejectStoreCommand,
  rejectWatcherWithdrawal,
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

describe("Store waitpoint block cycle: recovery", () => {
  containerTestWithIsolatedRedis.for([false, true])(
    "TERMINAL OWNERSHIP (interrupted=%s): resume retains ownership; success or interrupted-registration cancellation retires it before recovery",
    async (interrupted, { prisma, redisOptions }) => {
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const redis = createRedisClient(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshots);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_terminalregistry");
        const organizationId = env.organization.id;
        const wp = await seedStoreWaitpoint(
          store,
          env.id,
          env.project.id,
          env.organizationId,
          "RUN"
        );
        const operation = {
          runId: run.id,
          organizationId,
          projectId: env.project.id,
          waitpoints: [wp],
          blockOperation: {
            id: "terminal_block",
            absorptionId: "terminal_absorption",
            cycleAnchor: await captureAnchor(engine, run.id),
          },
        };
        const registry = organizationRunIndexKey(organizationId, fanoutPartition(run.id));
        if (interrupted) {
          await rejectRegistration(store, wp, () => blockStore(engine, operation));
          expect(await redis.zscore(registry, run.id)).toBe("0");
          expect(await redis.zcard(runContributionIndexKey(run.id))).toBe(1);
          await engine.cancelRun({ runId: run.id });
          expect(await redis.zcard(runContributionIndexKey(run.id))).toBe(0);
          expect(await redis.zscore(registry, run.id)).toBeNull();
          await engine.waitpointSystem.recoverWaitpointBlock(operation);
        } else {
          await blockStore(engine, operation);
          expect(await redis.zscore(registry, run.id)).toBe("0");
          await engine.waitpointSystem.completeWaitpoint({ id: wp, organizationId });
          await store.deliverCompletion({
            runId: run.id,
            blockId: operation.blockOperation.id,
            waitpointId: wp,
            completion: {
              completedAt: new Date().toISOString(),
              outputType: "application/json",
              outputIsError: false,
              output: null,
            },
          });
          await engine.waitpointSystem.continueRunIfUnblocked({ runId: run.id, organizationId });
          await expect
            .poll(
              async () =>
                (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus,
              {
                timeout: 10_000,
                interval: 50,
                message: "run never resumed after waitpoint completion",
              }
            )
            .toBe("EXECUTING");
          expect(await redis.zscore(registry, run.id)).toBe("0");
          const resumed = await engine.getRunExecutionData({ runId: run.id });
          await engine.completeRunAttempt({
            runId: run.id,
            snapshotId: resumed!.snapshot.id,
            completion: { ok: true, id: run.id, output: "{}", outputType: "application/json" },
          });
          await expect
            .poll(
              async () =>
                (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus,
              {
                timeout: 10_000,
                interval: 50,
                message: "run never finished after successful completion",
              }
            )
            .toBe("FINISHED");
        }
        expect(await redis.zscore(registry, run.id)).toBeNull();
        expect(await redis.zcard(runContributionIndexKey(run.id))).toBe(0);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshots.quit();
        redis.disconnect();
      }
    }
  );

  containerTestWithIsolatedRedis.for([false, true])(
    "RESUME REPLAY (suspended=%s): drain failure converges after later snapshot advancement — one resume, the exact handoff drained",
    async (suspended, { prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const coordinator = new StoreWaitpointCoordinator({ store });
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore, coordinator);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_resumereplay");

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "rr_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });

        if (suspended) {
          const blocked = (await engine.runStore.findLatestExecutionSnapshot(run.id))!;
          const checkpointed = await engine.createCheckpoint({
            runId: run.id,
            snapshotId: blocked.id,
            checkpoint: {
              type: "DOCKER",
              reason: "TEST_CHECKPOINT",
              location: "test-location",
              imageRef: "test-image-ref",
            },
          });
          expect(checkpointed.ok).toBe(true);
        }

        await engine.waitpointSystem.completeWaitpoint({ id: wp, organizationId: orgId });
        await store.deliverCompletion({
          runId: run.id,
          blockId: "rr_op",
          waitpointId: wp,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });

        // The resume and handoff commit, then the block drain fails. Proof must survive both.
        await rejectStoreCommand(store, "unlink", () =>
          engine.waitpointSystem.continueRunIfUnblocked({
            runId: run.id,
            organizationId: orgId,
          })
        );

        // The resume transition committed (run advanced to EXECUTING) but the block remains undrained.
        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe(suspended ? "QUEUED" : "EXECUTING");
          },
          { timeout: 10_000, interval: 100 }
        );
        expect((await store.readBlockState(run.id)).blockId).toBe("rr_op");
        // A later ordinary snapshot must not erase the proof of this block's committed resume.
        const resumed = (await engine.runStore.findLatestExecutionSnapshot(run.id))!;
        const advanced = await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run: { id: run.id, status: resumed.runStatus, attemptNumber: resumed.attemptNumber },
          snapshot: {
            executionStatus: suspended ? "QUEUED" : "EXECUTING",
            description: "Later execution update",
          },
          previousSnapshotId: resumed.id,
          environmentId: resumed.environmentId,
          environmentType: resumed.environmentType,
          projectId: resumed.projectId,
          organizationId: resumed.organizationId,
        });
        const snapshotAfterResume = advanced.id;

        // The retried continuation finds the run already advanced and converges the interrupted drain without
        // a second resume: it acknowledges + drains THIS exact block, and writes no new snapshot.
        const result = await engine.waitpointSystem.continueRunIfUnblocked({
          runId: run.id,
          organizationId: orgId,
        });
        expect(result.status).toBe("skipped");
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();
        // The exact original block was acknowledged, once — never a different or newer one (the store's
        // own fence against a newer cycle is proven by STALE ACK above).
        expect((await engine.getRunExecutionData({ runId: run.id }))!.snapshot.id).toBe(
          snapshotAfterResume
        );
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "CLEANUP OBLIGATION (defer): a SUSPENDED checkpoint advancing the snapshot is not proof — B1 and its watchers are untouched; also dark for an unblocked run and fenced to its block",
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
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_codefer");

        // DARK: an executing run with no store block arms no obligation.
        const darkObligation = await engine.waitpointSystem.armBlockerCleanupObligation({
          runId: run.id,
          organizationId: orgId,
          transitionId: SnapshotId.generate().id,
        });
        expect(darkObligation).toBeUndefined();

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "co_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        const ewwSnap = (await engine.getRunExecutionData({ runId: run.id }))!.snapshot.id;
        expect((await store.readBlockState(run.id)).blockId).toBe("co_op");
        expect(await describeLiveWatchers(store, wp)).toBe(1);

        // FENCE: an obligation for a DIFFERENT (stale) block never touches the current one.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "stale_op",
          transitionId: SnapshotId.generate().id,
        });
        expect((await store.readBlockState(run.id)).blockId).toBe("co_op");

        // Advance the snapshot with an intermediate SUSPENDED checkpoint while B1 remains current — the
        // intended retry transition never committed.
        const checkpointed = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: ewwSnap,
          checkpoint: {
            type: "DOCKER",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });
        expect(checkpointed.ok).toBe(true);
        expect(checkpointed.ok && checkpointed.snapshot.executionStatus).toBe("SUSPENDED");
        expect((await store.readBlockState(run.id)).blockId).toBe("co_op");

        // The guard for the (uncommitted) retry transition must DEFER — the checkpoint advancement is not
        // proof — so B1 and its watchers stay untouched.
        await expect(
          engine.waitpointSystem.ensureBlockersCleanedUp({
            runId: run.id,
            organizationId: orgId,
            blockId: "co_op",
            transitionId: SnapshotId.generate().id,
          })
        ).rejects.toThrow();
        expect((await store.readBlockState(run.id)).blockId).toBe("co_op");
        expect(await describeLiveWatchers(store, wp)).toBe(1);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "CLEANUP OBLIGATION (retry): once the retry transition has committed, the guard identifies it by id even after a further advancement and abandons B1",
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
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_coabandon");

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "co_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        const ewwSnap = (await engine.getRunExecutionData({ runId: run.id }))!.snapshot.id;

        // Fail the attempt with a retry; the retry transition commits, then the inline abandon is lost.
        await rejectStoreCommand(store, "set", () =>
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: ewwSnap,
            completion: {
              ok: false,
              id: run.id,
              error: {
                type: "BUILT_IN_ERROR",
                name: "UserError",
                message: "boom",
                stackTrace: "boom",
              },
              retry: { timestamp: Date.now(), delay: 0 },
            },
          })
        );

        // The committed retry transition IS the current snapshot; its id is the obligation's proof.
        const retryTransitionId = (await engine.getRunExecutionData({ runId: run.id }))!.snapshot
          .id;
        expect((await store.readBlockState(run.id)).blockId).toBe("co_op"); // still owed

        // Advance again before the guard runs (start the next attempt), so the retry snapshot is no
        // longer latest but remains provable by id.
        const attempt2 = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: retryTransitionId,
        });
        expect(attempt2.snapshot.id).not.toBe(retryTransitionId);

        // The guard identifies the committed retry transition by id and abandons B1 without terminalizing.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "co_op",
          transitionId: retryTransitionId,
        });
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();
        expect(
          (await engine.getRunExecutionData({ runId: run.id }))!.snapshot.executionStatus
        ).toBe("EXECUTING");
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "CLEANUP OBLIGATION (terminal): a store release lost after the terminal transition is re-driven terminal-first",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const coordinator = new StoreWaitpointCoordinator({ store });
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore, coordinator);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        // maxAttempts 1: the first failure permanently fails the run (terminal).
        await setupBackgroundWorker(engine, env, taskIdentifier, undefined, { maxAttempts: 1 });
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_coterminal");

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "ct_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        const ewwSnap = (await engine.getRunExecutionData({ runId: run.id }))!.snapshot.id;

        // Fail the attempt; the retry policy is exhausted so it terminalizes, then the release is lost.
        await rejectStoreCommand(store, "set", () =>
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: ewwSnap,
            completion: {
              ok: false,
              id: run.id,
              error: {
                type: "BUILT_IN_ERROR",
                name: "UserError",
                message: "boom",
                stackTrace: "boom",
              },
              retry: { timestamp: Date.now(), delay: 0 },
            },
          })
        );

        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("FINISHED");
          },
          { timeout: 10_000, interval: 100 }
        );
        // The inline release was lost, so the watcher is still live and no terminal fence is installed.
        expect(await describeLiveWatchers(store, wp)).toBe(1);

        // The obligation re-drives the SAME block terminal-first (durable terminal status is the proof):
        // the watcher is withdrawn and a late delivery is refused as terminal (a fence, not a cleared slot).
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "ct_op",
          transitionId: SnapshotId.generate().id,
        });
        expect(await describeLiveWatchers(store, wp)).toBe(0);
        const late = await store.deliverCompletion({
          runId: run.id,
          blockId: "ct_op",
          waitpointId: wp,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        expect(late.outcome).toBe("terminal");
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "ABANDON RETENTION: a failed watcher withdrawal is retried from durable targets after the active block is cleared, then converges without an in-memory edge list",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_abretain");

        const w1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const w2 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [w1, w2],
          blockOperation: { id: "ar_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        expect(await describeLiveWatchers(store, w1)).toBe(1);
        expect(await describeLiveWatchers(store, w2)).toBe(1);

        // Abandon B1 with w2's watcher withdrawal failing AFTER the run-side block is cleared.
        await rejectWatcherWithdrawal(store, () =>
          engine.waitpointSystem.cleanupBlockersAfterAttemptFailure({
            runId: run.id,
            organizationId: orgId,
            outcome: "retry",
          })
        );

        // The active block is gone, w2's watcher is stranded (its withdrawal failed), and the durable
        // target list for this block survives, keyed by block id, so the withdrawal can be retried.
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();
        expect(await describeLiveWatchers(store, w2)).toBe(1);
        expect(await store.readWithdrawalPage({ runId: run.id, blockId: "ar_op" })).toBeDefined();

        // Reconstructed from durable state only (no in-memory edge list): the obligation resumes B1's
        // withdrawal even though the active block is already gone — absence of the current block means
        // "check for retained work", not "done" — unregisters w2, and finalizes the record.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "ar_op",
          transitionId: SnapshotId.generate().id,
        });
        expect(await describeLiveWatchers(store, w1)).toBe(0);
        expect(await describeLiveWatchers(store, w2)).toBe(0);
        expect(await store.readWithdrawalPage({ runId: run.id, blockId: "ar_op" })).toBeUndefined();
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "SUCCESS CRASH RECOVERY: a store release lost after the FINISHED commit is re-driven by the cleanup obligation, fenced to the block, and idempotent on replay",
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
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_succrec");

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const blocked = await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "sr_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });

        // The FINISHED transition commits, then the inline terminal release is lost (models a crash after
        // the durable success but before cleanup).
        await rejectStoreCommand(store, "set", () =>
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: blocked.id,
            completion: { ok: true, id: run.id, output: "{}", outputType: "application/json" },
          })
        );

        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("FINISHED");
          },
          { timeout: 10_000, interval: 100 }
        );
        // The inline release was lost, so the block is still owed: the watcher is live and no fence exists.
        expect(await describeLiveWatchers(store, wp)).toBe(1);

        // FENCE: an obligation carrying a STALE block id must not release the still-owed current block.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "stale_op",
          transitionId: SnapshotId.generate().id,
        });
        expect(await describeLiveWatchers(store, wp)).toBe(1);

        // The obligation for the EXACT block re-drives the terminal release (durable FINISHED is proof on
        // its own — no success-snapshot id required): watcher withdrawn, late delivery refused terminal.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "sr_op",
          transitionId: SnapshotId.generate().id,
        });
        expect(await describeLiveWatchers(store, wp)).toBe(0);
        const late = await store.deliverCompletion({
          runId: run.id,
          blockId: "sr_op",
          waitpointId: wp,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        expect(late.outcome).toBe("terminal");

        // Replay is idempotent: the block is gone, so a second obligation firing withdraws nothing more.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "sr_op",
          transitionId: SnapshotId.generate().id,
        });
        expect(await describeLiveWatchers(store, wp)).toBe(0);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  // Catches: a success whose inline store release is lost staying owed forever because the write-ahead
  // ensureRunFinalized guard is not armed, or its replay skips the terminal store cleanup.
  containerTestWithIsolatedRedis(
    "SUCCESS CRASH RECOVERY via the finalization guard: the armed ensureRunFinalized job retires every store key and index, idempotently",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const redis = createRedisClient(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_finrec");
        const registry = organizationRunIndexKey(orgId, fanoutPartition(run.id));
        const keys = runBlockKeys(run.id);
        const activeKeys = () =>
          redis.exists(keys.pend, keys.done, keys.edge, keys.refs, keys.edgeIndex, keys.doneOrder);

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const blocked = await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "fin_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });

        // FINISHED commits, then the inline terminal release is lost.
        await rejectStoreCommand(store, "set", () =>
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: blocked.id,
            completion: { ok: true, id: run.id, output: "{}", outputType: "application/json" },
          })
        );
        await expect
          .poll(
            async () =>
              (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus,
            { timeout: 10_000, interval: 50, message: "run never reached FINISHED" }
          )
          .toBe("FINISHED");
        expect(await describeLiveWatchers(store, wp)).toBe(1);
        expect(await redis.hget(keys.state, "blk")).toBe("fin_op");
        expect(await redis.zscore(registry, run.id)).toBe("0");

        const guardId = `ensureRunFinalized:${run.id}`;
        expect(
          await engine["worker"].getJob(guardId),
          "finalization guard was not armed"
        ).not.toBeNull();

        // Replay the armed guard's handler twice; its 60s delay is outside the test window.
        for (let replay = 0; replay < 2; replay++) {
          await engine.runAttemptSystem.ensureRunFinalized({ runId: run.id });
          expect(await describeLiveWatchers(store, wp)).toBe(0);
          expect(await activeKeys()).toBe(0);
          expect(await redis.hget(keys.state, "term")).toBe("1");
          expect(await redis.hget(keys.state, "blk")).toBeNull();
          expect(await redis.pttl(keys.state)).toBeGreaterThan(0);
          expect(await redis.zcard(runContributionIndexKey(run.id))).toBe(0);
          expect(await redis.zscore(registry, run.id)).toBeNull();
        }
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
        redis.disconnect();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "TERMINAL RETENTION (stale fence): a terminal release fenced to a superseded block leaves the newer block and its watcher untouched",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_termstale");

        const w2wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [w2wp],
          blockOperation: { id: "B2", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        expect((await store.readBlockState(run.id)).blockId).toBe("B2");
        expect(await describeLiveWatchers(store, w2wp)).toBe(1);

        // A terminal retain-and-clear fenced to the SUPERSEDED B1 must not fence, clear or terminalize B2.
        const stale = await store.terminalRetainAndClear({ runId: run.id, blockId: "B1" });
        expect(stale.outcome).toBe("stale");
        const state = await store.readBlockState(run.id);
        expect(state.blockId).toBe("B2");
        expect(state.terminal).toBe(false);
        expect(await describeLiveWatchers(store, w2wp)).toBe(1);
        expect(await store.readWithdrawalPage({ runId: run.id, blockId: "B1" })).toBeUndefined();
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "TERMINAL CLEANUP REPLAY: a durably terminal run whose store terminalization succeeded but whose watcher withdrawal failed (leaving a retained record) and whose Postgres edge remains has the watcher, the withdrawal record and the legacy edge all cleared by the obligation replay — even after the ordinary run keys expire",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      const probe = createRedisClient(redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_termreplay");

        const s1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const s2 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [s1, s2],
          blockOperation: { id: "B1", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        expect(await describeLiveWatchers(store, s1)).toBe(1);

        // The mixed block's Postgres half: a legacy edge on the run.
        await prisma.waitpoint.create({
          data: {
            id: "wp_termreplay_l1",
            friendlyId: "wp_termreplay_l1_friendly",
            type: "MANUAL",
            status: "PENDING",
            idempotencyKey: "idem_termreplay_l1",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.id,
          },
        });
        await prisma.taskRunWaitpoint.create({
          data: {
            id: "trw_termreplay_l1",
            taskRunId: run.id,
            waitpointId: "wp_termreplay_l1",
            projectId: env.project.id,
          },
        });

        // 1+2. Cancel the run: it reaches a durable terminal snapshot and the store block terminalizes
        // (fence installed, retained record written), but s1's watcher withdrawal FAILS — leaving
        // withdrawal:B1 and a stranded watcher. The lost cross-shard withdrawal rejects the inline release.
        await rejectWatcherWithdrawal(store, () =>
          engine.cancelRun({ runId: run.id, finalizeRun: true })
        );
        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("FINISHED");
          },
          { timeout: 10_000, interval: 100 }
        );
        expect(await describeLiveWatchers(store, s1)).toBe(1); // withdrawal failed → stranded
        expect((await store.readBlockState(run.id)).terminal).toBe(true);
        expect(
          (await store.readWithdrawalPage({ runId: run.id, blockId: "B1" }))?.fields
        ).toHaveLength(2);

        // 3. The legacy edge is still present.
        expect(
          await prisma.taskRunWaitpoint.findFirst({ where: { taskRunId: run.id } })
        ).not.toBeNull();

        // 4. Simulate the terminal TTL firing: delete the ordinary run coordination keys. The retained
        // withdrawal record has NO TTL and must survive as the authoritative target list.
        const keys = runBlockKeys(run.id);
        await probe.del(keys.pend, keys.done, keys.edge, keys.state);
        expect(
          (await store.readWithdrawalPage({ runId: run.id, blockId: "B1" }))?.fields
        ).toHaveLength(2);

        // 5. Replay the obligation with the withdrawal fault cleared. terminalRetainAndClear now returns
        // `absent` (keys gone), but that is NOT convergence: releaseRunWatchers finishes the exact block's
        // retained withdrawal, then the Postgres delete is retried.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "B1",
          transitionId: SnapshotId.generate().id,
        });

        // 6. The retained watcher, the withdrawal record and the Postgres edge are all removed.
        expect(await describeLiveWatchers(store, s1)).toBe(0);
        expect(await describeLiveWatchers(store, s2)).toBe(0);
        expect(await store.readWithdrawalPage({ runId: run.id, blockId: "B1" })).toBeUndefined();
        expect(
          await prisma.taskRunWaitpoint.findFirst({ where: { taskRunId: run.id } })
        ).toBeNull();
      } finally {
        probe.disconnect();
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "TERMINAL AFTER PARTIAL ABANDON: an interrupted non-terminal abandon (retained + blk cleared, watcher unregister failed) that then goes terminal is recognized as B1 recovery, not stale — terminal cleanup withdraws the watcher, retires the record and fence, deletes the legacy edge, and installs the terminal fence",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      const probe = createRedisClient(redisOptions);
      const stKey = (runId: string) => `wp:v1:run:{${runId}}:st`;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_partabandon");

        const s1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const blocked = await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [s1],
          blockOperation: { id: "B1", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        expect(await describeLiveWatchers(store, s1)).toBe(1);

        // 2+3. Fail the attempt RETRYABLY with s1's watcher unregister failing AFTER B1 was retained and the
        // active block cleared: leaves withdrawal:B1, co=B1, and the stranded watcher.
        await rejectWatcherWithdrawal(store, () =>
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
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();
        expect(await store.readWithdrawalPage({ runId: run.id, blockId: "B1" })).toBeDefined();
        expect(await probe.hget(stKey(run.id), "co")).toBe("B1");
        expect(await describeLiveWatchers(store, s1)).toBe(1);

        // A legacy edge present on the run (the mixed case's Postgres half, still owed).
        await prisma.waitpoint.create({
          data: {
            id: "wp_partabandon_l1",
            friendlyId: "wp_partabandon_l1_friendly",
            type: "MANUAL",
            status: "PENDING",
            idempotencyKey: "idem_partabandon_l1",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.id,
          },
        });
        await prisma.taskRunWaitpoint.create({
          data: {
            id: "trw_partabandon_l1",
            taskRunId: run.id,
            waitpointId: "wp_partabandon_l1",
            projectId: env.project.id,
          },
        });

        // 5. The run goes durably terminal before the original obligation succeeds.
        await engine.cancelRun({ runId: run.id, finalizeRun: true });
        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId: run.id });
            expect(
              ed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("FINISHED");
          },
          { timeout: 10_000, interval: 100 }
        );

        // 6. Replay the cleanup obligation with the fault cleared. runTerminalRetainAndClear must recognize
        // the exact-B1 recovery evidence (not classify it stale) and drive the full terminal cleanup.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "B1",
          transitionId: SnapshotId.generate().id,
        });

        // 7. Everything converged and fenced terminal.
        expect(await describeLiveWatchers(store, s1)).toBe(0);
        expect(await store.readWithdrawalPage({ runId: run.id, blockId: "B1" })).toBeUndefined();
        expect(await probe.hget(stKey(run.id), "co")).toBeNull();
        const state = await store.readBlockState(run.id);
        expect(state.blockId).toBeUndefined();
        expect(state.terminal).toBe(true);
        expect(
          await prisma.taskRunWaitpoint.findFirst({ where: { taskRunId: run.id } })
        ).toBeNull();
        const late = await store.deliverCompletion({
          runId: run.id,
          blockId: "B1",
          waitpointId: s1,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        expect(late.outcome).toBe("terminal");

        // 8. Replay again — idempotent.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "B1",
          transitionId: SnapshotId.generate().id,
        });
        expect(await describeLiveWatchers(store, s1)).toBe(0);
        expect((await store.readBlockState(run.id)).terminal).toBe(true);
      } finally {
        probe.disconnect();
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "COMPENSATION UNDER CLEANUP FENCE: interrupted empty withdrawal replays from durable state and a later wait completes",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      const probe = createRedisClient(redisOptions);
      const co = (runId: string) => probe.hget(`wp:v1:run:{${runId}}:st`, "co");
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_compfence");
        // This fixture bypasses the router: seed its write-ahead marker before writing Redis directly.
        await new PostgresRunStore({ prisma, readOnlyPrisma: prisma }).markRunWaitpointsOnStore(
          run.id
        );

        // 1. B1 installed with ONE contributed store edge (a1) directly — a partial mixed absorb whose
        // compensation is still owed: blk=B1, edge s1, contribution a1=[s1]; no blocked TRES snapshot.
        const s1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await store.absorbBlockers({
          runId: run.id,
          blockId: "B1",
          edges: [{ waitpointId: s1, createdAt: new Date().toISOString(), type: "MANUAL" }],
          absorptionId: "a1",
        });
        expect((await store.readBlockState(run.id)).blockId).toBe("B1");
        expect(
          await store.readContribution({ runId: run.id, blockId: "B1", absorptionId: "a1" })
        ).toHaveLength(1);

        // A legacy edge (mixed).
        await prisma.waitpoint.create({
          data: {
            id: "wp_compfence_l1",
            friendlyId: "wp_compfence_l1_friendly",
            type: "MANUAL",
            status: "PENDING",
            idempotencyKey: "idem_compfence_l1",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.id,
          },
        });
        await prisma.taskRunWaitpoint.create({
          data: {
            id: "trw_compfence_l1",
            taskRunId: run.id,
            waitpointId: "wp_compfence_l1",
            projectId: env.project.id,
          },
        });

        // 2. Arm co=B1 via failed-attempt preparation, bound to a specific retry transition id T.
        const transitionId = SnapshotId.generate().id;
        await engine.waitpointSystem.prepareFailedAttemptCleanup({
          runId: run.id,
          organizationId: orgId,
          transitionId,
          tx: prisma,
        });
        expect(await co(run.id)).toBe("B1");

        // 3. Delayed compensation removes B1's final edge. Because co=B1 is armed, blk=B1 is PRESERVED.
        await engine.waitpointSystem.ensureAbsorptionCompensated({
          runId: run.id,
          organizationId: env.organization.id,
          blockId: "B1",
          absorptionId: "a1",
        });

        // 4. Contribution + edge gone; blk=B1 and co=B1 remain as durable recovery evidence.
        expect(
          await store.readContribution({ runId: run.id, blockId: "B1", absorptionId: "a1" })
        ).toEqual([]);
        const afterComp = await store.readBlockState(run.id);
        expect(afterComp.blockId).toBe("B1");
        expect(afterComp.edges).toEqual([]);
        expect(afterComp.pendingIds).toEqual([]);
        expect(await co(run.id)).toBe("B1");

        // 5. Before the retry transition exists, cleanup DEFERS without changing that state. Under
        // redis-primary reads the missing snapshot throws first; otherwise "not yet committed" does.
        // Catches: cleanup failing for an unrelated reason passing as the deferral.
        await expect(
          engine.waitpointSystem.ensureBlockersCleanedUp({
            runId: run.id,
            organizationId: orgId,
            blockId: "B1",
            transitionId,
          })
        ).rejects.toThrow(/redis-primary snapshot missing|not yet committed/);
        expect((await store.readBlockState(run.id)).blockId).toBe("B1");
        expect(await co(run.id)).toBe("B1");
        expect(
          await prisma.taskRunWaitpoint.findFirst({ where: { taskRunId: run.id } })
        ).not.toBeNull();

        // 6. Commit the specific retry/requeue transition.
        const cur = (await engine.runStore.findLatestExecutionSnapshot(run.id))!;
        await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          snapshotId: transitionId,
          run: { id: run.id, status: cur.runStatus, attemptNumber: cur.attemptNumber },
          snapshot: { executionStatus: "EXECUTING", description: "retry transition (test)" },
          previousSnapshotId: cur.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.project.id,
          organizationId: orgId,
        });

        // 7. Cleanup commits its ordered legacy delete and atomic retain-and-clear, then stops before
        // finalization. Replay must use the durable manifest and detached target hash.
        await prisma.taskRunWaitpoint.deleteMany({ where: { taskRunId: run.id } });
        await store.abandonRetainAndClear({ runId: run.id, blockId: "B1" });
        expect(await probe.get(runWithdrawalKey(run.id, "B1"))).toBe("B1");
        expect(await store.readWithdrawalPage({ runId: run.id, blockId: "B1" })).toEqual({
          blockId: "B1",
          fields: [],
        });
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();
        expect(await co(run.id)).toBe("B1");

        // 8. Ordinary nonterminal cleanup reads the retained record and atomically retires it + co.
        await engine.waitpointSystem.ensureBlockersCleanedUp({
          runId: run.id,
          organizationId: orgId,
          blockId: "B1",
          transitionId,
        });
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();
        expect(await co(run.id)).toBeNull();
        expect(await store.readWithdrawalPage({ runId: run.id, blockId: "B1" })).toBeUndefined();
        expect(
          await prisma.taskRunWaitpoint.findFirst({ where: { taskRunId: run.id } })
        ).toBeNull();

        // 9. The next native RUN wait can block and resume through the same engine.
        const s2 = await seedStoreWaitpoint(
          store,
          env.id,
          env.project.id,
          env.organizationId,
          "RUN"
        );
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [s2],
          blockOperation: { id: "B2", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        expect((await store.readBlockState(run.id)).blockId).toBe("B2");
        await engine.waitpointSystem.completeWaitpoint({ id: s2, organizationId: orgId });
        await store.deliverCompletion({
          runId: run.id,
          blockId: "B2",
          waitpointId: s2,
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
        expect(
          (await engine.getRunExecutionData({ runId: run.id }))!.snapshot.executionStatus
        ).toBe("EXECUTING");
        expect((await store.readBlockState(run.id)).blockId).toBeUndefined();
      } finally {
        probe.disconnect();
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );
});
