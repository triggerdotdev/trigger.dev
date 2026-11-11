import { PrismaClient } from "@trigger.dev/database";
import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { hasStoreWaitpoints, PostgresRunStore, RedisSnapshotStore } from "@internal/run-store";
import { generateWaitpointId, SnapshotId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import { Logger } from "@trigger.dev/core/logger";
import { LegacyPostgresWaitpointCoordinator } from "../waitpointCoordinator/legacyPostgresCoordinator.js";
import { RoutingWaitpointCoordinator } from "../waitpointCoordinator/routingCoordinator.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { createTestStore, quitTestStore, disableStoreAccess } from "./utils/storeTestAccess.js";
import {
  boundedBarrier,
  deferred,
  makeEngine,
  runToExecuting,
} from "./utils/storeWaitpointBlockCycle.setup.js";

describe("Store waitpoint block cycle: legacy", () => {
  containerTestWithIsolatedRedis(
    "LEGACY FAILURE ORDERING: OFF deletes committed blockers before a failing retry lookup",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const logged = new PrismaClient({
        datasources: { db: { url: postgresContainer.getConnectionUri() } },
        log: [{ emit: "event", level: "query" }],
      });
      const blockerDeletes: string[] = [];
      logged.$on("query", ({ query }) => {
        if (/DELETE FROM .*"TaskRunWaitpoint"/i.test(query)) blockerDeletes.push(query);
      });
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      await disableStoreAccess(store);
      const engine = makeEngine(
        logged,
        redisOptions,
        store,
        snapshotStore,
        new StoreWaitpointCoordinator({ store }),
        () => false
      );
      const runStore = new PostgresRunStore({ prisma: logged, readOnlyPrisma: logged });
      engine.setRunStore(runStore);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_legacyorder");
        const { waitpoint } = await engine.createManualWaitpoint({
          runId: run.id,
          projectId: env.project.id,
          environmentId: env.id,
        });
        const blocked = await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(1);
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "TaskRun" RENAME COLUMN "lockedRetryConfig" TO "_unavailableRetryConfig"'
        );

        // A real interactive transaction keeps the same ordering, but its delete rolls back when
        // the later lookup fails. The exact same blocker then exercises the ordinary client below.
        await expect(
          prisma.$transaction(async (tx) => {
            await engine.runAttemptSystem.attemptFailed({
              runId: run.id,
              snapshotId: blocked.id,
              tx,
              completion: {
                ok: false,
                id: run.id,
                error: { type: "BUILT_IN_ERROR", name: "Error", message: "retry", stackTrace: "" },
              },
            });
          })
        ).rejects.toThrow("lockedRetryConfig");
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(1);

        // completeRunAttempt passes the real Prisma client, not an interactive transaction. The
        // baseline delete therefore stays committed even though deciding the retry now fails.
        await expect(
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: blocked.id,
            forceRequeue: true,
            completion: {
              ok: false,
              id: run.id,
              error: { type: "BUILT_IN_ERROR", name: "Error", message: "retry", stackTrace: "" },
              retry: { timestamp: Date.now() + 50, delay: 50 },
            },
          })
        ).rejects.toThrow("lockedRetryConfig");
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "TaskRun" RENAME COLUMN "_unavailableRetryConfig" TO "lockedRetryConfig"'
        );
        expect((await engine.getRunExecutionData({ runId: run.id }))!.snapshot.id).toBe(blocked.id);
        // On the successful retry path the OFF SQL footprint remains one blocker delete. Observe the
        // actual Postgres queries, including an extra post-transition cleanup if one is introduced.
        blockerDeletes.length = 0;
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: blocked.id,
          completion: {
            ok: false,
            id: run.id,
            error: { type: "BUILT_IN_ERROR", name: "Error", message: "retry", stackTrace: "" },
            retry: { timestamp: Date.now() + 50, delay: 50 },
          },
        });
        expect(
          blockerDeletes,
          "OFF successful retry must issue exactly one blocker DELETE"
        ).toHaveLength(1);
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
        await logged.$disconnect();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "SUCCESS DARK PATH: a disabled marked run preserves advanced legacy edges and arms no cleanup obligation",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      // A store that fails loudly on any block-lifecycle call, behind a never-enabling predicate.
      const store = await createTestStore(redisOptions);
      await disableStoreAccess(store);
      const engine = makeEngine(
        prisma,
        redisOptions,
        store,
        snapshotStore,
        new StoreWaitpointCoordinator({ store }),
        () => false
      );
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const orgId = env.organization.id;
        const run = await runToExecuting(engine, env, taskIdentifier, prisma, "run_succdark");
        const snap = await engine.getRunExecutionData({ runId: run.id });

        // Rollback keeps the legacy skip even for a run marked by earlier store use.
        await new PostgresRunStore({ prisma, readOnlyPrisma: prisma }).markRunWaitpointsOnStore(
          run.id
        );
        // An already-advanced run retains its completed legacy edge while disabled.
        const legacy = await prisma.waitpoint.create({
          data: {
            ...WaitpointId.generate(),
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date(),
            idempotencyKey: "dark-resume",
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.id,
          },
        });
        const edge = await prisma.taskRunWaitpoint.create({
          data: { taskRunId: run.id, waitpointId: legacy.id, projectId: env.project.id },
        });
        expect(
          await engine.waitpointSystem.continueRunIfUnblocked({
            runId: run.id,
            organizationId: orgId,
          })
        ).toMatchObject({ status: "skipped" });
        expect(await prisma.taskRunWaitpoint.findUnique({ where: { id: edge.id } })).not.toBeNull();

        // The pre-commit arm observes no block WITHOUT touching MemoryDB (the throwing store proves it).
        const armed = await engine.waitpointSystem.armBlockerCleanupObligation({
          runId: run.id,
          organizationId: orgId,
          transitionId: SnapshotId.generate().id,
        });
        expect(armed).toBeUndefined();

        // A normal successful completion never reaches the store: if the dark gate leaked, the throwing
        // store would reject and this would fail.
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: snap!.snapshot.id,
          completion: { ok: true, id: run.id, output: "{}", outputType: "application/json" },
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
      } finally {
        await engine.quit();
        await quitTestStore(store);
        await snapshotStore.quit();
      }
    }
  );

  for (const enabled of [false, true]) {
    containerTestWithIsolatedRedis(
      `CLEANUP FENCE: ${enabled ? "enabled unmarked parents serialize" : "disabled marked parents stay lockless"} without MemoryDB`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = await createTestStore(redisOptions);
        await disableStoreAccess(store);
        const engine = makeEngine(
          prisma,
          redisOptions,
          store,
          snapshotStore,
          undefined,
          () => enabled
        );
        const locked = deferred();
        const release = deferred();
        let holder: Promise<void> | undefined;
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, "test-task");
          const run = await runToExecuting(engine, env, "test-task", prisma, "run_cleanupdark");
          if (!enabled) await engine.runStore.markRunWaitpointsOnStore(run.id);
          const common = {
            runId: run.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          };
          const batch = await prisma.batchTaskRun.create({
            data: {
              id: "cleanup_dark_batch",
              friendlyId: "batch_cleanup_dark",
              runtimeEnvironmentId: env.id,
            },
          });
          const header = await engine.blockRunWithCreatedBatch({
            ...common,
            environmentId: env.id,
            batchId: batch.id,
          });
          expect(header).not.toBeNull();
          const legacy = await engine.createManualWaitpoint({
            ...common,
            runId: undefined,
            environmentId: env.id,
          });
          holder = engine["runLock"].lock("unmarkedControl", [run.id], async () => {
            locked.resolve();
            await boundedBarrier(release.promise, "test never released the cleanup run lock");
          });
          await boundedBarrier(locked.promise, "cleanup never acquired the run lock");
          let settled = false;
          const admission = engine.waitpointSystem
            .blockRunWithWaitpointLockless({
              ...common,
              waitpoints: legacy.waitpoint.id,
              batch: { id: batch.id, index: 3 },
            })
            .then(() => {
              settled = true;
            });
          if (enabled) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(settled).toBe(false);
            release.resolve();
            await holder;
          }
          await admission;
          expect(
            await prisma.taskRunWaitpoint.count({
              where: { taskRunId: run.id, waitpointId: legacy.waitpoint.id },
            })
          ).toBe(1);
          // Concurrent admissions queue before acquisition rather than consuming the retry
          // budget competing with this worker's own siblings. Exercise the production wiring.
          engine["runLock"]["retryConfig"].maxAttempts = 1;
          const siblings = await Promise.all(
            Array.from({ length: 32 }, () =>
              engine.createManualWaitpoint({ ...common, runId: undefined, environmentId: env.id })
            )
          );
          const admissions = await Promise.allSettled(
            siblings.map(({ waitpoint }, index) =>
              engine.waitpointSystem.blockRunWithWaitpointLockless({
                ...common,
                waitpoints: waitpoint.id,
                batch: { id: batch.id, index: index + 4 },
              })
            )
          );
          expect(admissions.every((result) => result.status === "fulfilled")).toBe(true);
          expect(
            await prisma.taskRunWaitpoint.count({
              where: {
                taskRunId: run.id,
                waitpointId: { in: siblings.map(({ waitpoint }) => waitpoint.id) },
              },
            })
          ).toBe(32);
        } finally {
          release.resolve();
          await holder;
          await engine.quit();
          await quitTestStore(store);
          await snapshotStore.quit();
        }
      }
    );
  }

  containerTestWithIsolatedRedis(
    "disabled organization delegates persisted blockers to legacy and skips store cleanup discovery",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = await createTestStore(redisOptions);
      const engine = makeEngine(
        prisma,
        redisOptions,
        store,
        snapshotStore,
        new StoreWaitpointCoordinator({ store }),
        () => false
      );
      await quitTestStore(store);
      try {
        const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        const routing = new RoutingWaitpointCoordinator({
          legacy: new LegacyPostgresWaitpointCoordinator({
            runStore: () => runStore,
            prisma,
            logger: new Logger("disabled-routing-test"),
          }),
          store: new StoreWaitpointCoordinator({ store }),
          mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
          isStoreEnabled: () => false,
          markStoreWaitpoints: (runId) => runStore.markRunWaitpointsOnStore(runId),
        });
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await runToExecuting(engine, env, "test-task", prisma, "run_disabledlegacy");
        // Disabled routing must preserve existing Postgres rows even when their IDs look native.
        const storeId = generateWaitpointId("RUN");
        const legacy = await prisma.waitpoint.create({
          data: {
            id: storeId,
            friendlyId: WaitpointId.toFriendlyId(storeId),
            type: "RUN",
            idempotencyKey: storeId,
            userProvidedIdempotencyKey: false,
            projectId: env.project.id,
            environmentId: env.id,
          },
        });
        const absorbed = await routing.absorbBlockers({
          runId: run.id,
          organizationId: env.organization.id,
          projectId: env.project.id,
          waitpointIds: [storeId],
          client: prisma,
          blockId: "B",
          absorptionId: "a",
          parentResidency: "redis-primary",
        });
        expect(absorbed).toEqual({
          pendingCount: 1,
          registration: { kind: "noop", pendingCount: 1 },
        });
        expect(await routing.registerBlockers(absorbed.registration)).toEqual({ pendingCount: 1 });
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: run.id, waitpointId: storeId },
          })
        ).toBe(1);
        expect(
          hasStoreWaitpoints(
            (await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).annotations
          )
        ).toBe(false);
        const blocked = await engine.blockRunWithWaitpoint({
          runId: run.id,
          organizationId: env.organization.id,
          projectId: env.project.id,
          waitpoints: legacy.id,
        });
        expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
        const completed = await routing.complete({
          waitpointId: storeId,
          organizationId: env.organization.id,
          output: { value: "legacy completion", type: "text/plain", isError: false },
        });
        expect(completed.waitpoint).toMatchObject({
          id: storeId,
          status: "COMPLETED",
          output: "legacy completion",
        });
        await expect(
          routing.registerBlockers({
            kind: "routing",
            parts: [
              {
                kind: "store",
                runId: "disabled_missing_run",
                organizationId: "disabled_org",
                blockId: "B",
                absorptionId: "a",
                edges: [],
                storePendingTotal: 0,
                alreadyDelivered: [],
              },
            ],
          })
        ).rejects.toThrow("Store waitpoint registration is disabled for this organization");
        await expect(
          routing.compensateAbsorption({
            runId: "disabled_missing_run",
            organizationId: "disabled_org",
            blockId: "B",
            absorptionId: "a",
          })
        ).resolves.toBeUndefined();
        // No such run or snapshot exists. A disabled handler must return before locking or discovering it.
        await expect(
          engine.waitpointSystem.ensureBlockersCleanedUp({
            runId: "disabled_missing_run",
            organizationId: "disabled_org",
            blockId: "B",
            transitionId: "missing_transition",
          })
        ).resolves.toBeUndefined();
        await expect(
          engine.waitpointSystem.ensureAbsorptionCompensated({
            runId: "disabled_missing_run",
            organizationId: "disabled_org",
            blockId: "B",
            absorptionId: "a",
          })
        ).resolves.toBeUndefined();
        // Old queued payloads carry no org: do not discover one through run SQL.
        await expect(
          engine.waitpointSystem.ensureAbsorptionCompensated({
            runId: "disabled_missing_run",
            blockId: "B",
            absorptionId: "a",
          })
        ).resolves.toBeUndefined();
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
