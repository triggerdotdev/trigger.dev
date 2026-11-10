import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { RedisSnapshotStore, PostgresRunStore } from "@internal/run-store";
import { describe, expect, vi } from "vitest";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { createTestStore, quitTestStore, rejectStoreCommand } from "./utils/storeTestAccess.js";
import {
  makeEngine,
  seedStoreWaitpoint,
  runToExecuting,
  describeLiveWatchers,
  captureAnchor,
  blockStore,
} from "./utils/storeWaitpointBlockCycle.setup.js";

describe("Store waitpoint block cycle: attempt", () => {
  containerTestWithIsolatedRedis(
    "FAILED ATTEMPT (enabled org, no store block): a failed attempt does not throw",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_nostore");
        const snap = await engine.getRunExecutionData({ runId: run.id });

        // The org is enabled, but this run has no native blockers:
        // the failed-attempt cleanup must not throw a transactional-store-clear error.
        const failResult = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: snap!.snapshot.id,
          completion: {
            ok: false,
            id: run.id,
            error: {
              type: "BUILT_IN_ERROR" as const,
              name: "Error",
              message: "boom",
              stackTrace: "",
            },
            retry: undefined,
          },
        });
        expect(failResult.snapshot.executionStatus).toBe("FINISHED");
        expect(failResult.attemptStatus).toBe("RUN_FINISHED");
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  for (const postgresSnapshots of [false, true]) {
    containerTestWithIsolatedRedis(
      `FAILED ATTEMPT (active store block, ${postgresSnapshots ? "Postgres" : "Redis"} snapshots): retry abandons and fences the old block; an old delivery is refused; the next attempt can block again`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = await createTestStore(redisOptions);
        const engine = makeEngine(
          prisma,
          redisOptions,
          store,
          snapshotStore,
          undefined,
          undefined,
          undefined,
          postgresSnapshots ? new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) : undefined
        );
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const taskIdentifier = "test-task";
          await setupBackgroundWorker(engine, env, taskIdentifier);
          const orgId = env.organization.id;
          const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_retryblk");

          const wp1 = await seedStoreWaitpoint(
            store,
            env.id,
            env.project.id,
            env.organizationId,
            "RUN"
          );
          const blocked = await blockStore(engine, {
            runId: run.id,
            projectId: env.project.id,
            organizationId: orgId,
            waitpoints: [wp1],
            blockOperation: { id: "blk_c1", cycleAnchor: await captureAnchor(engine, run.id) },
          });
          expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
          const oldBlockId = (await store.readBlockState(run.id)).blockId!;

          // The attempt fails RETRYABLY while blocked.
          const failResult = await engine.completeRunAttempt({
            runId: run.id,
            snapshotId: blocked.id,
            completion: {
              ok: false,
              id: run.id,
              error: {
                type: "BUILT_IN_ERROR" as const,
                name: "Error",
                message: "retry me",
                stackTrace: "",
              },
              retry: { timestamp: Date.now() + 50, delay: 50 },
            },
          });
          expect(["RETRY_IMMEDIATELY", "RETRY_QUEUED"]).toContain(failResult.attemptStatus);

          // The old block was abandoned and fenced WITHOUT terminalizing the run.
          const afterFail = await store.readBlockState(run.id);
          expect(afterFail.blockId).toBeUndefined();
          expect(afterFail.terminal).toBe(false);

          // An in-flight OLD-block delivery lands as an INERT early receipt (no block is installed after the
          // abandon), so it does not resume the run — it is not a stale refusal, just an orphan the
          // reconciliation lane reaps.
          const late = await store.deliverCompletion({
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
          expect(late.resumable).toBe(false);

          // The next attempt can open a FRESH block cycle.
          await vi.waitFor(
            async () => {
              const dequeued = await engine.dequeueFromWorkerQueue({
                consumerId: "c_retryblk2",
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

          const wp2 = await seedStoreWaitpoint(
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
            waitpoints: [wp2],
            blockOperation: { id: "blk_c2", cycleAnchor: await captureAnchor(engine, run.id) },
          });
          const freshBlock = (await store.readBlockState(run.id)).blockId;
          expect(freshBlock).toBe("blk_c2");
          expect(freshBlock).not.toBe(oldBlockId);
        } finally {
          await engine.quit();
          await quitTestStore(store);
          await snapshotStore.quit();
        }
      }
    );
  }

  containerTestWithIsolatedRedis(
    "FAILED ATTEMPT (active store block): a final failure fences the run terminal-first",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_failblk");

        const wp1 = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const blocked = await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp1],
          blockOperation: { id: "blk_c1", cycleAnchor: await captureAnchor(engine, run.id) },
        });

        // A non-retryable failure: the run goes terminal.
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: blocked.id,
          completion: {
            ok: false,
            id: run.id,
            error: {
              type: "BUILT_IN_ERROR" as const,
              name: "Error",
              message: "final",
              stackTrace: "",
            },
            retry: undefined,
          },
        });

        // Terminal-first: the run's block shard is fenced, so an in-flight delivery is refused.
        const state = await store.readBlockState(run.id);
        expect(state.terminal).toBe(true);
        const late = await store.deliverCompletion({
          runId: run.id,
          blockId: blocked.id,
          waitpointId: wp1,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        expect(late.outcome).toBe("terminal");
        expect(late.resumable).toBe(false);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "DIRECT CANCEL: cancelling a store-blocked run releases its block terminal-first — watcher withdrawn, late delivery refused as terminal",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_cancelblk");

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "cn_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        expect(await describeLiveWatchers(store, wp)).toBe(1);

        // Direct cancellation (not via attemptFailed): cancelRun owns the store-blocker release.
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

        // The store block was released terminal-first: the watcher is withdrawn and a late delivery is
        // refused as terminal, so a never-completing waitpoint cannot later resume the cancelled run.
        expect(await describeLiveWatchers(store, wp)).toBe(0);
        const late = await store.deliverCompletion({
          runId: run.id,
          blockId: "cn_op",
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
    "SUCCESS WITH STORE BLOCK: a successful attempt on a store-blocked run releases the block terminal-first — watcher withdrawn, late delivery refused",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_succblk");

        const wp = await seedStoreWaitpoint(store, env.id, env.project.id, env.organizationId);
        const blocked = await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: { id: "sb_op", cycleAnchor: await captureAnchor(engine, run.id) },
        });
        expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
        expect(await describeLiveWatchers(store, wp)).toBe(1);

        // The worker reports SUCCESS while the store block is still installed (a completion racing the
        // block). FINISHED is terminal for the block; the success cleanup must release it terminal-first.
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: blocked.id,
          completion: {
            ok: true,
            id: run.id,
            output: "{}",
            outputType: "application/json",
          },
        });
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

        // Terminal-first: the block's watcher is withdrawn, the run's shard is fenced, and a late delivery
        // is refused as terminal so a never-completing waitpoint can never resume the finished run.
        const state = await store.readBlockState(run.id);
        expect(state.blockId).toBeUndefined();
        expect(state.terminal).toBe(true);
        expect(await describeLiveWatchers(store, wp)).toBe(0);
        const late = await store.deliverCompletion({
          runId: run.id,
          blockId: "sb_op",
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
    "EXPIRED TERMINAL RESUME: continuation releases the observed store block after finished snapshot expiry",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const coordinator = new StoreWaitpointCoordinator({ store });
      const engine = makeEngine(prisma, redisOptions, store, snapshotStore, coordinator);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_expiredterminal");
        const { waitpoint } = await engine.createManualWaitpoint({
          runId: run.id,
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: orgId,
        });
        const wp = waitpoint.id;
        expect((await store.readCompletedRecords([wp])).get(wp)?.record.organizationId).toBe(orgId);
        expect(await store.manualCatalog.getManifest(orgId, wp)).toBeDefined();
        const blocked = await blockStore(engine, {
          runId: run.id,
          projectId: env.project.id,
          organizationId: orgId,
          waitpoints: [wp],
          blockOperation: {
            id: "expired_terminal_op",
            cycleAnchor: await captureAnchor(engine, run.id),
          },
        });
        // Leave a real completed transition whose terminal store release was interrupted.
        await rejectStoreCommand(store, "set", () =>
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: blocked.id,
            completion: { ok: true, id: run.id, output: "{}", outputType: "application/json" },
          })
        );
        expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
          "COMPLETED_SUCCESSFULLY"
        );
        await engine.waitpointSystem.completeWaitpoint({ id: wp, organizationId: orgId });
        await store.deliverCompletion({
          runId: run.id,
          blockId: "expired_terminal_op",
          waitpointId: wp,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");
        expect((await store.readBlockState(run.id)).blockId).toBe("expired_terminal_op");
        const result = await engine.waitpointSystem.continueRunIfUnblocked({
          runId: run.id,
          organizationId: orgId,
        });
        expect(result).toEqual({ status: "skipped", reason: "run is finished" });
        const state = await store.readBlockState(run.id);
        expect(state.terminal).toBe(true);
        expect(state.blockId).toBeUndefined();
        expect(await describeLiveWatchers(store, wp)).toBe(0);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );
});
