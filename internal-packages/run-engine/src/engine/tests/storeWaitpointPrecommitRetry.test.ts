import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { trace } from "@internal/tracing";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import { cycleAnchorSnapshotId } from "../systems/waitpointSystem.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { runBlockKeys } from "../waitpointCoordinator/keys.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

describe("failed-attempt cleanup before transition commit", () => {
  containerTestWithIsolatedRedis(
    "a rejected durable retry snapshot preserves B1, then legitimate retry clears its fence and permits B2",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: {
          redis: redisOptions,
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
        },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
        waitpointStoreEnabled: () => true,
        waitpointRouting: {
          store: new StoreWaitpointCoordinator({ store }),
          mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
        },
        waitpointStore: store,
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_precommit",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "trace_precommit",
            spanId: "span_precommit",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );
        let dequeued: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>> = [];
        await expect
          .poll(
            async () => {
              dequeued = await engine.dequeueFromWorkerQueue({
                consumerId: "precommit",
                workerQueue: "main",
                blockingPopTimeoutSeconds: 1,
              });
              return dequeued.length;
            },
            { timeout: 10_000, interval: 50, message: "run never reached its worker queue" }
          )
          .toBe(1);
        await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued[0]!.snapshot.id });
        const wp = generateWaitpointId("RUN");
        const now = new Date().toISOString();
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "RUN",
            environmentId: env.id,
            projectId: env.project.id,
            completedByTaskRunId: "child_precommit",
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        const block = async (id: string) =>
          engine.blockRunWithWaitpoint({
            runId: run.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
            waitpoints: [wp],
            blockOperation: {
              id,
              absorptionId: id,
              cycleAnchor: cycleAnchorSnapshotId(
                (await engine.runStore.findLatestExecutionSnapshot(run.id))!
              ),
            },
          });
        await block("B1");
        const before = (await engine.getRunExecutionData({ runId: run.id }))!.snapshot;
        expect(before.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
        // Reject the real primary snapshot INSERT after the native fence is armed.
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION reject_test_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."executionStatus" = 'EXECUTING' THEN RAISE EXCEPTION 'test retry snapshot rejected before commit'; END IF; RETURN NEW; END $$`
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER reject_test_retry BEFORE INSERT ON "TaskRunExecutionSnapshot" FOR EACH ROW EXECUTE FUNCTION reject_test_retry()`
        );
        const failAttempt = () =>
          engine.completeRunAttempt({
            runId: run.id,
            snapshotId: before.id,
            completion: {
              ok: false,
              id: run.id,
              error: {
                type: "BUILT_IN_ERROR",
                name: "UserError",
                message: "retry",
                stackTrace: "retry",
              },
              retry: { timestamp: Date.now(), delay: 0 },
            },
          });
        await expect(failAttempt()).rejects.toThrow("test retry snapshot rejected before commit");
        expect((await engine.getRunExecutionData({ runId: run.id }))!.snapshot.id).toBe(before.id);
        expect(await redis.hget(runBlockKeys(run.id).state, "co")).toBe("B1");
        expect((await store.readBlockState(run.id)).pendingIds).toEqual([wp]);
        await expect(block("B2")).rejects.toThrow();
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER reject_test_retry ON "TaskRunExecutionSnapshot"`
        );
        // A legitimate retry uses B1's fence, then the committed transition owns cleanup.
        const retried = await failAttempt();
        expect(retried.attemptStatus).toBe("RETRY_IMMEDIATELY");
        expect(retried.snapshot.id).not.toBe(before.id);
        expect(
          await prisma.taskRunExecutionSnapshot.findUnique({ where: { id: retried.snapshot.id } })
        ).not.toBeNull();
        expect(await redis.hget(runBlockKeys(run.id).state, "co")).toBeNull();
        expect(await store.currentBlockId(run.id)).toBeUndefined();
        await engine.startRunAttempt({ runId: run.id, snapshotId: retried.snapshot.id });
        await block("B2");
        expect(await store.currentBlockId(run.id)).toBe("B2");
      } finally {
        await engine.quit();
        await store.quit();
        await redis.quit();
      }
    }
  );
});
