import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import {
  hasStoreWaitpoints,
  RedisSnapshotStore,
  type SnapshotStoreDial,
} from "@internal/run-store";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  generateWaitpointId,
  mintWaitpointIdFor,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient, type Redis } from "@internal/redis";
import { describe, expect, vi } from "vitest";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { runResultKey, waitpointKeys } from "../waitpointCoordinator/keys.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeRedisRunStore,
  makeEngine,
  triggerRun,
  dequeueAndStart,
  restrictedWaitpointStore,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("storeWaitpointSharedResultRetention", () => {
  for (const crash of [false, true]) {
    containerTest(
      `shared RUN commit gap ${crash ? "after restart" : "with eager producer paused"} keeps one home for a PG batch waiter`,
      async ({ prisma, redisOptions }) => {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
        );
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        let dial: SnapshotStoreDial = "redis-only";
        const runStore = makeRedisRunStore(prisma, snapshotStore, () => dial);
        let engine = makeEngine(prisma, redisOptions, { store, snapshotStore, runStore });
        let unlock!: () => void;
        const releaseLock = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        let lockReady = false;
        let lockOwner: Promise<unknown> | undefined;
        let eagerOutcome: Promise<string> | undefined;
        let monitorClient: Redis | undefined;
        let monitor: Redis | undefined;
        const waiters = () => prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          AND objid = 777001 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        `;
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task", "racy-child"]);
          const originalParent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "racy-original-parent");
          dial = "off";
          const lateParent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "racy-pg-parent");
          dial = "redis-only";
          const friendlyId = `run_${generateRunOpsId()}`;
          const childId = RunId.fromFriendlyId(friendlyId);
          const waitpointId = deriveWaitpointIdFromAnchor(childId, "RUN")!;
          const originalOperation = await engine.waitpointSystem.buildStoreBlockOperation({
            runId: originalParent.id,
            waitpointId,
            organizationId: env.organization.id,
          });
          const key = `racy-key-${generateRunOpsId()}`;
          // A BEFORE STATEMENT trigger waits before the marker update takes row locks.
          // The child insert has committed, so a second real caller can plan from its immutable home.
          await prisma.$executeRawUnsafe(`CREATE FUNCTION test_pause_association() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
              IF current_query() LIKE '%"waitpointsOnStore"%' THEN
                PERFORM pg_advisory_xact_lock(777001);
              END IF;
              RETURN NULL;
            END $$`);
          await prisma.$executeRawUnsafe(`CREATE TRIGGER test_pause_association
            BEFORE UPDATE ON "TaskRun" FOR EACH STATEMENT EXECUTE FUNCTION test_pause_association()`);
          lockOwner = prisma.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(777001)`;
              lockReady = true;
              await releaseLock;
            },
            { timeout: 10_000 }
          );
          await expect
            .poll(() => lockReady, {
              timeout: 5000,
              interval: 10,
              message: "real association advisory lock was never acquired",
            })
            .toBe(true);
          const eager = triggerRun(engine, env, prisma, {
            friendlyId,
            taskIdentifier: "racy-child",
            parentTaskRunId: originalParent.id,
            resumeParentOnCompletion: true,
            idempotencyKey: key,
          });
          eagerOutcome = eager.then(
            () => "returned",
            (error: Error) => error.message
          );
          await expect
            .poll(waiters, {
              timeout: 5000,
              interval: 10,
              message: "eager producer never reached its real marker update",
            })
            .toHaveLength(1);
          const cached = await prisma.taskRun.findFirstOrThrow({
            where: {
              runtimeEnvironmentId: env.id,
              taskIdentifier: "racy-child",
              idempotencyKey: key,
            },
            include: { associatedWaitpoint: true },
          });
          expect(cached.id).toBe(childId);
          expect(cached.associatedWaitpoint).toBeNull();
          expect(hasStoreWaitpoints(cached.annotations)).toBe(false);
          expect(await store.probeWaitpointPresence(waitpointId)).toBe("absent");
          if (crash) {
            const [producer] = await waiters();
            await prisma.$queryRaw`SELECT pg_terminate_backend(${producer!.pid}::int)`;
            unlock();
            await lockOwner;
            expect(await eagerOutcome).toMatch(/terminated|closed|connection/i);
            await engine.quit();
            // The killed producer used this real pool; reconnect it before the new process reads.
            await prisma.$disconnect();
            await prisma.$connect();
            engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
          }
          // MONITOR sees each real attempt on the child's lifecycle lock key: only redlock's acquire
          // script runs EXISTS on it, and a granted attempt stops retrying.
          let lockAttempts = 0;
          if (!crash) {
            monitorClient = createRedisClient(redisOptions);
            monitor = await monitorClient.monitor();
            monitor.on("monitor", (_time: string, args: string[]) => {
              if (args[0] === "exists" && args[1]?.endsWith(`runlock:${childId}`)) lockAttempts++;
            });
          }
          const lateAssociation = engine.getOrCreateRunWaitpoint({
            runId: cached.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
            blockingParentRunId: lateParent.id,
            blockingViaBatch: true,
          });
          if (!crash) {
            // Annotation marking now shares the child's lifecycle lock with this late caller.
            // It must wait at that lock rather than issue a competing SQL marker update.
            // Catches: the eager producer writing the annotations marker outside the child's run lock.
            await expect
              .poll(() => lockAttempts, {
                timeout: 5000,
                interval: 10,
                message: "late caller never retried the child's run lock",
              })
              .toBeGreaterThanOrEqual(2);
            expect(await waiters()).toHaveLength(1);
            unlock();
            await lockOwner;
          }
          const association = await lateAssociation;
          expect(association.id).toBe(waitpointId);
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: childId } })).toBe(
            0
          );
          const batch = await prisma.batchTaskRun.create({
            data: {
              id: generateRunOpsId(),
              friendlyId: `batch_${generateRunOpsId()}`,
              runtimeEnvironmentId: env.id,
            },
          });
          const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
            runId: lateParent.id,
            waitpointId,
            organizationId: env.organization.id,
          });
          await engine.blockRunWithWaitpoint({
            runId: lateParent.id,
            waitpoints: waitpointId,
            projectId: env.project.id,
            organizationId: env.organization.id,
            blockOperation,
            batch: { id: batch.id, index: 0 },
          });
          if (crash) {
            await engine["worker"].enqueue({
              id: `recoverRunWaitpoint:${childId}`,
              job: "recoverRunWaitpoint",
              payload: {
                runId: childId,
                parentRunId: originalParent.id,
                waitpointId,
                organizationId: env.organization.id,
                blockOperation: originalOperation!,
              },
            });
          } else {
            expect(await eagerOutcome).toBe("returned");
          }
          const attempt = await dequeueAndStart(engine, "racy-child");
          expect(attempt.run.id).toBe(childId);
          await engine.completeRunAttempt({
            runId: childId,
            snapshotId: attempt.snapshot.id,
            completion: { id: childId, ok: true, output: "false", outputType: "application/json" },
          });
          await vi.waitFor(
            async () => {
              // A killed eager producer never accepted its birth-parent dependency. The late
              // batch waiter did accept its slot and must receive the shared result after restart.
              const acceptedParents = crash ? [lateParent] : [originalParent, lateParent];
              for (const parent of acceptedParents) {
                const resumed = await engine.getRunExecutionData({ runId: parent.id });
                expect(
                  resumed?.snapshot.executionStatus,
                  "run never reached the expected execution status"
                ).toBe("EXECUTING");
                expect(resumed?.completedWaitpoints).toContainEqual(
                  expect.objectContaining({ id: waitpointId, output: "false" })
                );
              }
            },
            { timeout: 10_000 }
          );
          if (crash) {
            const untouched = await engine.getRunExecutionData({ runId: originalParent.id });
            expect(untouched?.snapshot.executionStatus).toBe("EXECUTING");
            expect(untouched?.completedWaitpoints).toEqual([]);
            expect((await store.readBlockState(originalParent.id)).edges).toEqual([]);
          }
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: childId } })).toBe(
            0
          );
        } finally {
          unlock?.();
          await lockOwner?.catch(() => {});
          await eagerOutcome?.catch(() => {});
          monitor?.disconnect();
          monitorClient?.disconnect();
          await engine.quit();
          await store.quit();
          await snapshotStore.quit();
        }
      }
    );
  }

  for (const completionSource of ["manual-timeout", "old-batch-job"])
    containerTest(
      `legacy ${completionSource} keeps pending store child and resumes with both results`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "parent");
          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          });
          const attempt = await dequeueAndStart(engine, "child");
          const storeChild = await engine.getOrCreateRunWaitpoint({
            runId: child.id,
            environmentId: env.id,
            projectId: env.projectId,
            organizationId: env.organizationId,
          });
          let legacyId: string;
          const context = {
            runId: parent.id,
            environmentId: env.id,
            projectId: env.projectId,
            organizationId: env.organizationId,
          };
          if (completionSource === "manual-timeout") {
            const manual = await engine.createManualWaitpoint({
              ...context,
              // Standalone MANUAL remains a legacy PG token; this test exercises its old timeout job.
              runId: undefined,
              timeout: new Date(Date.now() + 1000),
            });
            legacyId = manual.waitpoint.id;
            await engine.blockRunWithWaitpoint({ ...context, waitpoints: legacyId });
          } else {
            const batch = await prisma.batchTaskRun.create({
              data: {
                friendlyId: `batch_${generateRunOpsId()}`,
                runtimeEnvironmentId: env.id,
                batchVersion: "runengine:v2",
                runCount: 1,
                successfulRunCount: 1,
                failedRunCount: 0,
                sealed: true,
                runIds: [child.friendlyId],
              },
            });
            // Seed the pre-deployment PG header explicitly; newly admitted batches are native now.
            const legacy = await engine.runStore.createWaitpoint({
              data: {
                ...mintWaitpointIdFor(batch.id),
                type: "BATCH",
                idempotencyKey: batch.id,
                userProvidedIdempotencyKey: false,
                completedByBatchId: batch.id,
                environmentId: env.id,
                projectId: env.projectId,
              },
            });
            legacyId = legacy.id;
            await engine.blockRunWithWaitpoint({
              ...context,
              waitpoints: legacyId,
              batch: { id: batch.id },
            });
            // Exactly the pre-deployment queued payload: no organization field.
            await engine.tryCompleteBatch({ batchId: batch.id });
          }
          await vi.waitFor(
            async () =>
              expect(
                (await engine.runStore.findWaitpoint({ where: { id: legacyId } }))?.status,
                "waitpoint condition never settled: (await engine.runStore.findWaitpoint({ where: { id: legacyId } }))?.status"
              ).toBe("COMPLETED"),
            { timeout: 10_000 }
          );
          expect(
            (await engine.waitpointSystem.continueRunIfUnblocked({ runId: parent.id })).status
          ).toBe("blocked");
          expect(
            (await engine.getRunExecutionData({ runId: parent.id }))!.snapshot.executionStatus
          ).toBe("EXECUTING_WITH_WAITPOINTS");
          await engine.completeRunAttempt({
            runId: child.id,
            snapshotId: attempt.snapshot.id,
            completion: {
              id: child.id,
              ok: true,
              output: '{"child":true}',
              outputType: "application/json",
            },
          });
          await vi.waitFor(
            async () => {
              const data = (await engine.getRunExecutionData({ runId: parent.id }))!;
              expect(
                data.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
              expect(data.completedWaitpoints.map((w) => w.id)).toEqual(
                expect.arrayContaining([legacyId, storeChild.id])
              );
              expect(data.completedWaitpoints).toHaveLength(2);
            },
            { timeout: 10_000 }
          );
        } finally {
          await engine.quit();
          await store.quit();
          await snapshotStore.quit();
        }
      }
    );

  // Shared RUN fixtures represent existing reusable children; the parent references both in one block.
  // All delivery, snapshot persistence/hydration, restart and finalization paths below are production code.
  for (const mode of ["off", "dual-write", "redis-read"] as const)
    containerTest(
      `retained shared RUN results survive ${mode} source expiry, restart and later cycles`,
      async ({ prisma, redisOptions }) => {
        // Match the shipped migration: testcontainers' schema push recreates this obsolete FK.
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
        );
        let snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        let access = await restrictedWaitpointStore(redisOptions, 10_000);
        let store = access.store;
        let engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore: snapshots,
          resolveDial: () => mode,
        });
        const raw = createRedisClient(redisOptions);
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, "parent-task");
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, `retention_${mode}`);
          const ids = [generateWaitpointId("RUN"), generateWaitpointId("RUN")];
          const error = '{"message":"immutable shared error"}';
          const now = new Date().toISOString();
          for (const id of ids)
            await store.createIfAbsent({
              record: {
                id,
                friendlyId: `waitpoint_${id}`,
                type: "RUN",
                environmentId: env.id,
                projectId: env.projectId,
                createdAt: now,
                updatedAt: now,
                completedByTaskRunId: `shared_${id}`,
                tags: [],
                userProvidedIdempotencyKey: false,
              },
              status: "PENDING",
            });
          const operation = await engine.waitpointSystem.buildStoreBlockOperation({
            runId: parent.id,
            waitpointId: ids[0]!,
            organizationId: env.organizationId,
          });
          await engine.blockRunWithWaitpoint({
            runId: parent.id,
            waitpoints: ids,
            projectId: env.projectId,
            organizationId: env.organizationId,
            blockOperation: operation,
          });
          const markedParent = await engine.runStore.findRunOnPrimary(
            { id: parent.id },
            { select: { annotations: true } }
          );
          expect(hasStoreWaitpoints(markedParent?.annotations)).toBe(true);
          await engine.completeWaitpoint({
            id: ids[0]!,
            organizationId: env.organizationId,
            output: { value: error, isError: true },
          });
          await vi.waitFor(
            async () =>
              expect(
                (await store.readBlockState(parent.id)).deliveredIds,
                "waitpoint condition never settled: (await store.readBlockState(parent.id)).deliveredIds"
              ).toContain(ids[0]),
            { timeout: 10_000 }
          );
          // The retained receipt precedes the final fanout acknowledgment, which arms the source TTL.
          // Wait for that acknowledgment so it cannot overwrite the forced expiry below.
          await vi.waitFor(
            async () =>
              expect(
                await store.describeWaitpoint(ids[0]!),
                "waitpoint never reached its expected terminal state"
              ).toMatchObject({ fanout: "done" }),
            { timeout: 10_000 }
          );
          await raw.pexpire(waitpointKeys(ids[0]!).record, 1);
          await vi.waitFor(
            async () =>
              expect(
                await raw.exists(waitpointKeys(ids[0]!).record),
                "waitpoint condition never settled: await raw.exists(waitpointKeys(ids[0]!).record)"
              ).toBe(0),
            { timeout: 10_000, interval: 20 }
          );
          expect((await store.readBlockState(parent.id)).pendingIds).toEqual([ids[1]]);
          await engine.completeWaitpoint({
            id: ids[1]!,
            organizationId: env.organizationId,
            output: { value: error, isError: true },
          });
          await vi.waitFor(
            async () =>
              expect(
                (await store.readBlockState(parent.id)).blockId,
                "waitpoint condition never settled: (await store.readBlockState(parent.id)).blockId"
              ).toBeUndefined(),
            { timeout: 10_000 }
          );
          await vi.waitFor(
            async () =>
              expect(
                await store.describeWaitpoint(ids[1]!),
                "waitpoint never reached its expected terminal state"
              ).toMatchObject({ fanout: "done" }),
            { timeout: 10_000 }
          );
          await raw.pexpire(waitpointKeys(ids[1]!).record, 1);
          await vi.waitFor(
            async () =>
              expect(
                await raw.exists(waitpointKeys(ids[1]!).record),
                "waitpoint condition never settled: await raw.exists(waitpointKeys(ids[1]!).record)"
              ).toBe(0),
            { timeout: 10_000, interval: 20 }
          );
          expect(await raw.pttl(runResultKey(parent.id))).toBe(-1);
          await engine.quit();
          await access.close();
          await snapshots.quit();
          snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
          access = await restrictedWaitpointStore(redisOptions, 10_000);
          store = access.store;
          engine = makeEngine(prisma, redisOptions, {
            store,
            snapshotStore: snapshots,
            resolveDial: () => mode,
          });
          const resumed = (await engine.runStore.findLatestExecutionSnapshot(parent.id))!;
          expect(resumed.executionStatus).toBe("EXECUTING");
          expect(resumed.completedWaitpoints.map((w) => w.id).sort()).toEqual([...ids].sort());
          for (const id of ids)
            expect(resumed.completedWaitpoints.find((w) => w.id === id)).toMatchObject({
              output: error,
              outputType: "application/json",
              outputIsError: true,
              completedByTaskRunId: `shared_${id}`,
            });
          const data = (await engine.getRunExecutionData({ runId: parent.id }))!;
          for (const id of ids)
            expect(data.completedWaitpoints.find((w) => w.id === id)).toMatchObject({
              output: error,
              outputIsError: true,
              completedByTaskRun: { id: `shared_${id}` },
            });
          // Duplicate recovery cannot rewrite old results or interfere with a later sequential wait.
          await engine.waitpointSystem.continueRunIfUnblocked({
            runId: parent.id,
            organizationId: env.organizationId,
          });
          const nextId = generateWaitpointId("RUN");
          await store.createIfAbsent({
            record: {
              id: nextId,
              friendlyId: `waitpoint_${nextId}`,
              type: "RUN",
              environmentId: env.id,
              projectId: env.projectId,
              createdAt: now,
              updatedAt: now,
              completedByTaskRunId: `shared_${nextId}`,
              tags: [],
              userProvidedIdempotencyKey: false,
            },
            status: "PENDING",
          });
          const nextOperation = await engine.waitpointSystem.buildStoreBlockOperation({
            runId: parent.id,
            waitpointId: nextId,
            organizationId: env.organizationId,
          });
          await engine.blockRunWithWaitpoint({
            runId: parent.id,
            waitpoints: nextId,
            projectId: env.projectId,
            organizationId: env.organizationId,
            blockOperation: nextOperation,
          });
          expect(
            (
              await store.deliverCompletion({
                runId: parent.id,
                blockId: operation!.id,
                waitpointId: ids[0]!,
                completion: {
                  completedAt: now,
                  output: { inline: "wrong" },
                  outputType: "text/plain",
                  outputIsError: true,
                },
              })
            ).outcome
          ).toBe("stale");
          await engine.completeWaitpoint({
            id: nextId,
            organizationId: env.organizationId,
            output: { value: "next-cycle", isError: true },
          });
          await vi.waitFor(
            async () =>
              expect(
                (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING"),
            { timeout: 10_000 }
          );
          const latest = (await engine.runStore.findLatestExecutionSnapshot(parent.id))!;
          expect(latest.completedWaitpoints.map((w) => w.id)).toEqual([nextId]);
          const original = await engine.runStore.findExecutionSnapshot({
            where: { id: resumed.id },
            include: { completedWaitpoints: true },
          });
          expect(original?.completedWaitpoints.map((w) => w.id).sort()).toEqual([...ids].sort());
          expect(original?.completedWaitpoints.every((w) => w.output === error)).toBe(true);
          if (mode === "off") {
            await access.admin.call("ACL", "SETUSER", access.username, "-pexpire");
            await expect(
              engine.completeRunAttempt({
                runId: parent.id,
                snapshotId: latest.id,
                completion: {
                  id: parent.id,
                  ok: true,
                  output: "{}",
                  outputType: "application/json",
                },
              })
            ).rejects.toThrow(/ACL|permission|NOPERM/i);
            await access.admin.call("ACL", "SETUSER", access.username, "+pexpire");
            expect(await raw.pttl(runResultKey(parent.id))).toBe(-1);
            const worker = (
              engine as unknown as {
                worker: {
                  queue: { getJob(id: string): Promise<unknown> };
                  jobs: { ensureRunFinalized(args: { payload: { runId: string } }): Promise<void> };
                };
              }
            ).worker;
            // Catches: the success path no longer arming the parent's ensureRunFinalized guard.
            expect(await worker.queue.getJob(`ensureRunFinalized:${parent.id}`)).toMatchObject({
              job: "ensureRunFinalized",
              item: { runId: parent.id },
            });
            await worker.jobs.ensureRunFinalized({ payload: { runId: parent.id } });
          } else {
            await engine.completeRunAttempt({
              runId: parent.id,
              snapshotId: latest.id,
              completion: { id: parent.id, ok: true, output: "{}", outputType: "application/json" },
            });
          }
          expect(await raw.pttl(runResultKey(parent.id))).toBeGreaterThan(0);
          expect(
            (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
          ).toBe("FINISHED");
        } finally {
          await raw.quit();
          await engine.quit();
          await access.close();
          await snapshots.quit();
        }
      }
    );
});
