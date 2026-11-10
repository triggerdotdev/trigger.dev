import { StoreWaitpointBlockCycleAdvanced } from "../errors.js";
import {
  containerTestWithIsolatedRedis as containerTest,
  redisTest,
} from "@internal/testcontainers";
import { RedisSnapshotStore, type SnapshotStoreDial } from "@internal/run-store";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  parseWaitpointId,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient } from "@internal/redis";
import { deriveRunWaitpointId } from "../waitpointCoordinator/runWaitpointId.js";
import { workerCatalog } from "../workerCatalog.js";
import { QUEUED_SNAPSHOT_DESCRIPTION, QUEUED_SNAPSHOT_STATUS } from "../consts.js";
import { RUN_WAITPOINT_RECOVERY_COMMIT_WINDOW_MS } from "../systems/waitpointSystem.js";
import { runBlockKeys, runResultKey, waitpointKeys } from "../waitpointCoordinator/keys.js";
import { waitpointStoreBarrier } from "./utils/waitpointStoreBarrier.js";
import { describe, expect, vi } from "vitest";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
  restrictedWaitpointStore,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("storeWaitpointAutomaticRecovery", () => {
  describe("Automatic store waitpoint recovery without traffic", () => {
    containerTest(
      "restart repairs the blocked snapshot to watcher registration gap",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        let engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          recoveryDelayMs: 1000,
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "recovery-register-parent");
          const childFriendlyId = `run_${generateRunOpsId()}`;
          const childId = RunId.fromFriendlyId(childFriendlyId);
          const waitpointId = deriveWaitpointIdFromAnchor(childId, "RUN")!;
          const raw = createRedisClient(redisOptions);
          try {
            await raw.set(waitpointKeys(waitpointId).watchers, "wrong-type");
          } finally {
            raw.disconnect();
          }
          await expect(
            triggerRun(engine, env, prisma, {
              friendlyId: childFriendlyId,
              taskIdentifier: "child-task",
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
            })
          ).rejects.toThrow("WRONGTYPE");
          expect(
            (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
          ).toBe("EXECUTING_WITH_WAITPOINTS");
          await engine.quit();
          const repair = createRedisClient(redisOptions);
          try {
            await repair.del(waitpointKeys(waitpointId).watchers);
          } finally {
            repair.disconnect();
          }
          engine = makeEngine(prisma, redisOptions, {
            store,
            snapshotStore,
            recoveryDelayMs: 1000,
          });
          await vi.waitFor(
            async () => {
              expect(
                await engine.runQueue.messageExists(env.organization.id, childId),
                "child was never published to its run queue"
              ).toBe(1);
            },
            { timeout: 10_000 }
          );
          await engine.waitpointSystem.completeWaitpoint({
            id: waitpointId,
            organizationId: env.organization.id,
            output: { value: "{}", type: "application/json", isError: false },
          });
          await vi.waitFor(
            async () => {
              expect(
                (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
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

    containerTest(
      "restart completes DATETIME from its durable deadline after creation crashes",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const barrier = await waitpointStoreBarrier(redisOptions);
        let store = new WaitpointStoreCoordinator({
          redisOptions: {
            ...barrier.redisOptions,
            retryStrategy: () => null,
            maxRetriesPerRequest: 0,
          },
        });
        let engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          recoveryDelayMs: 1000,
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "recovery-datetime-parent");
          // Warm the real candidate script on this dedicated socket before selecting its reply.
          const base = {
            runId: parent.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
          };
          await engine.createDateTimeWaitpoint({
            ...base,
            completedAfter: new Date(Date.now() + 60_000),
          });
          const completedAfter = new Date(Date.now() + 1000);
          barrier.pause((args) => args[2] === "2" && args[4]!.endsWith(":mint-fence"), "reply");
          const creation = engine.createDateTimeWaitpoint({ ...base, completedAfter }).then(
            () => undefined,
            (error: unknown) => error
          );
          await expect
            .poll(() => barrier.held, {
              timeout: 5000,
              interval: 10,
              message: "DATETIME source never reached its actual committed reply",
            })
            .toBe(true);
          const id = JSON.parse(barrier.requestArgs![5]!).id as string;
          expect(await engine["worker"].getJob(`recoverDateTimeWaitpoint:${id}`)).not.toBeNull();
          expect(await engine["worker"].getJob(`finishWaitpoint:${id}`)).toBeNull();
          barrier.disconnect();
          expect(String(await creation)).toMatch(/closed|connection|retry/i);
          expect(parseWaitpointId(id).format).toBe("b32hexW");
          await engine.quit();
          await store.quit();
          store = new WaitpointStoreCoordinator({ redisOptions });
          expect(await store.probeWaitpointPresence(id)).toBe("present");
          engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
          await vi.waitFor(
            async () => {
              const record = await store.describeWaitpoint(id);
              expect(
                record.outcome === "exists" ? record.status : undefined,
                'waitpoint condition never settled: record.outcome === "exists" ? record.status : undefined'
              ).toBe("COMPLETED");
            },
            { timeout: 10_000 }
          );
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
          await barrier.close();
        }
      }
    );

    containerTest(
      "durable fanout repairs delivery before continuation without new traffic",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        let engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          recoveryDelayMs: 1000,
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "recovery-fanout-parent");
          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          });
          const waitpointId = deriveWaitpointIdFromAnchor(child.id, "RUN")!;
          await engine.quit();
          engine = makeEngine(prisma, redisOptions, { store, snapshotStore, workerDisabled: true });
          await engine.waitpointSystem.completeWaitpoint({
            id: waitpointId,
            organizationId: env.organization.id,
            output: { value: "{}", type: "application/json", isError: false },
          });
          expect(
            await engine["worker"].getJob(`deliverWaitpointFanout:${waitpointId}`)
          ).not.toBeNull();
          await engine.quit();
          // Actual receipt delivery precedes continuation; the producer's real durable job remains.
          const completion = (await store.readCompletedRecords([waitpointId])).get(
            waitpointId
          )!.completion!;
          const state = await store.readBlockState(parent.id);
          expect(
            await store.deliverCompletion({
              runId: parent.id,
              blockId: state.blockId!,
              waitpointId,
              completion,
            })
          ).toMatchObject({ outcome: "delivered" });
          engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
          await vi.waitFor(
            async () => {
              expect(
                (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
            },
            { timeout: 15_000 }
          );
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );
  });

  containerTest(
    "disabled organization acknowledges recovery work before any run or waitpoint lookup",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, { store, snapshotStore, enabled: false });
      try {
        const runId = generateRunOpsId();
        const parentRunId = generateRunOpsId();
        const waitpointId = deriveWaitpointIdFromAnchor(runId, "RUN")!;
        const operation = {
          id: `block:${parentRunId}:absent`,
          absorptionId: "absent",
          cycleAnchor: "absent",
        };
        const organizationId = "disabled-recovery-org";
        await engine["worker"].enqueue({
          id: "disabled-run-recovery",
          job: "recoverRunWaitpoint",
          payload: { runId, parentRunId, waitpointId, organizationId, blockOperation: operation },
        });
        await engine["worker"].enqueue({
          id: "disabled-block-recovery",
          job: "recoverWaitpointBlock",
          payload: {
            runId: parentRunId,
            waitpoints: [waitpointId],
            organizationId,
            projectId: "absent",
            blockOperation: operation,
          },
        });
        await engine["worker"].enqueue({
          id: "disabled-datetime-recovery",
          job: "recoverDateTimeWaitpoint",
          payload: {
            waitpointId,
            organizationId,
            projectId: "absent",
            environmentId: "absent",
            completedAfter: new Date(),
          },
        });
        await engine["worker"].enqueue({
          id: "disabled-fanout-recovery",
          job: "deliverWaitpointFanout",
          payload: { waitpointId, organizationId },
        });
        await vi.waitFor(
          async () => {
            for (const id of [
              "disabled-run-recovery",
              "disabled-block-recovery",
              "disabled-datetime-recovery",
              "disabled-fanout-recovery",
            ]) {
              expect(
                await engine["worker"].queue.getJob(id),
                "recovery job never left the worker queue"
              ).toBeNull();
            }
          },
          { timeout: 5000 }
        );
        expect(await store.probeWaitpointPresence(waitpointId)).toBe("absent");
        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(0);
      } finally {
        await engine.quit();
        await store.quit();

        await snapshotStore.quit();
      }
    }
  );

  for (const retireParent of [false, true]) {
    containerTest(
      `a delayed original producer ${retireParent ? "cannot reattach a retired parent cycle" : "cannot republish the child after recovery queues it"}`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const barrier = await waitpointStoreBarrier(redisOptions);
        const producerStore = new WaitpointStoreCoordinator({ redisOptions: barrier.redisOptions });
        const engine = makeEngine(prisma, redisOptions, {
          store: producerStore,
          snapshotStore,
          workerDisabled: true,
          recoveryDelayMs: 500,
          resolveDial: () => (retireParent ? "off" : "redis-only"),
        });
        const recoveryEngine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          workerDisabled: true,
          resolveDial: () => (retireParent ? "off" : "redis-only"),
        });
        // Queue dispatch stays live while the engine recovery worker is deliberately held off.
        recoveryEngine.runQueue["worker"].start();
        let original: ReturnType<typeof triggerRun> | undefined;
        try {
          if (retireParent) {
            // Match the existing production FK-removal migration omitted by schema-push fixtures.
            await prisma.$executeRawUnsafe(
              `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
            );
          }
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          const parentAttempt = await dequeueAndStart(engine, "recovery-delayed-producer-parent");
          const friendlyId = `run_${generateRunOpsId()}`;
          const runId = RunId.fromFriendlyId(friendlyId);
          const waitpointId = deriveWaitpointIdFromAnchor(runId, "RUN")!;
          barrier.pause(
            (args) =>
              args[2] === "2" &&
              args[3] === `wp:v1:{${waitpointId}}` &&
              args[4] === `wp:v1:{${waitpointId}}:related` &&
              args[5]!.includes('"type":"RUN"')
          );
          original = triggerRun(engine, env, prisma, {
            friendlyId,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          });
          // Retain the rejection for the assertion after release while controlling the parent race.
          void original.catch(() => {});
          await expect
            .poll(() => barrier.held, {
              timeout: 5000,
              interval: 10,
              message: "original RUN source write never reached real Redis request",
            })
            .toBe(true);
          expect(await prisma.taskRun.findUnique({ where: { id: runId } })).toMatchObject({
            status: "PENDING",
          });
          expect(await engine.runQueue.messageExists(env.organization.id, runId)).toBeFalsy();
          expect(
            await engine["worker"].queue.getJob(`recoverRunWaitpoint:${runId}`)
          ).not.toBeNull();
          let laterWaitpointId: string | undefined;
          let laterSnapshotId: string | undefined;
          let laterBlockId: string | undefined;
          if (retireParent) {
            const retry = await recoveryEngine.completeRunAttempt({
              runId: parent.id,
              snapshotId: parentAttempt.snapshot.id,
              completion: {
                id: parent.id,
                ok: false,
                error: {
                  type: "BUILT_IN_ERROR",
                  name: "Error",
                  message: "new parent attempt",
                  stackTrace: "",
                },
                retry: { timestamp: Date.now() + 50, delay: 50 },
              },
            });
            expect(retry.attemptStatus).toBe("RETRY_IMMEDIATELY");
            expect(retry.snapshot.id).not.toBe(parentAttempt.snapshot.id);
            expect(retry.snapshot.executionStatus).toBe("EXECUTING");
            const later = await recoveryEngine.createDateTimeWaitpoint({
              runId: parent.id,
              organizationId: env.organization.id,
              projectId: env.project.id,
              environmentId: env.id,
              completedAfter: new Date(Date.now() + 60_000),
            });
            laterWaitpointId = later.waitpoint.id;
            const operation = await recoveryEngine.waitpointSystem.buildStoreBlockOperation({
              runId: parent.id,
              waitpointId: laterWaitpointId,
              organizationId: env.organization.id,
            });
            const blocked = await recoveryEngine.blockRunWithWaitpoint({
              runId: parent.id,
              waitpoints: laterWaitpointId,
              organizationId: env.organization.id,
              projectId: env.project.id,
              blockOperation: operation,
            });
            laterSnapshotId = blocked.id;
            laterBlockId = operation!.id;
          }
          // Start the actual worker only after the chosen parent cycle is durable.
          recoveryEngine["worker"].start();
          await vi.waitFor(
            async () => {
              expect(
                await engine.runQueue.messageExists(env.organization.id, runId),
                "child was never published to its run queue"
              ).toBe(1);
            },
            { timeout: 10_000 }
          );
          await expect
            .poll(() => recoveryEngine["worker"].queue.getJob(`recoverRunWaitpoint:${runId}`), {
              timeout: 10_000,
              interval: 20,
              message: "RUN publication recovery was never acknowledged",
            })
            .toBeNull();
          if (retireParent) {
            expect((await store.readBlockState(parent.id)).blockId).toBe(laterBlockId);
            expect((await store.readBlockState(parent.id)).pendingIds).toEqual([laterWaitpointId]);
            expect(
              (await recoveryEngine.getRunExecutionData({ runId: parent.id }))?.snapshot.id
            ).toBe(laterSnapshotId);
            expect(
              await prisma.taskRunWaitpoint.count({ where: { taskRunId: parent.id, waitpointId } })
            ).toBe(0);
          }
          if (!retireParent) {
            // Recovery can queue the child before the original producer accepts its first edge.
            expect((await store.readBlockState(parent.id)).pendingIds).toEqual([]);
            expect(
              (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
            ).toBe("EXECUTING");
          }
          barrier.release();
          if (retireParent)
            await expect(original).rejects.toBeInstanceOf(StoreWaitpointBlockCycleAdvanced);
          else {
            expect((await original).id).toBe(runId);
            expect((await store.readBlockState(parent.id)).pendingIds).toEqual([waitpointId]);
          }
          const child = await dequeueAndStart(engine, "recovery-delayed-producer-child");
          expect(child.run.id).toBe(runId);
          expect(
            await engine.dequeueFromWorkerQueue({
              blockingPopTimeoutSeconds: 1,
              consumerId: "recovery-no-duplicate",
              workerQueue: "main",
            })
          ).toHaveLength(0);
          if (retireParent) {
            await recoveryEngine.completeRunAttempt({
              runId,
              snapshotId: child.snapshot.id,
              completion: {
                id: runId,
                ok: true,
                output: '{"committed":true}',
                outputType: "application/json",
              },
            });
            const source = (await store.readCompletedRecords([waitpointId])).get(waitpointId)!;
            expect(source.status).toBe("COMPLETED");
            expect(source.completion?.output).toEqual({ inline: '{"committed":true}' });
            await expect
              .poll(
                async () => {
                  const state = await store.describeWaitpoint(waitpointId);
                  return state.outcome === "exists" ? state.recordTtlMs : 0;
                },
                {
                  timeout: 5_000,
                  interval: 20,
                  message: "completed unobserved child source never entered terminal retention",
                }
              )
              .toBeGreaterThan(0);

            expect((await store.readBlockState(parent.id)).blockId).toBe(laterBlockId);
            expect((await store.readBlockState(parent.id)).pendingIds).toEqual([laterWaitpointId]);
            expect(
              (await recoveryEngine.getRunExecutionData({ runId: parent.id }))?.snapshot.id
            ).toBe(laterSnapshotId);
            await recoveryEngine.completeWaitpoint({
              id: laterWaitpointId!,
              organizationId: env.organization.id,
            });
            await expect
              .poll(
                async () => {
                  const resumed = await recoveryEngine.getRunExecutionData({ runId: parent.id });
                  if (resumed?.snapshot.executionStatus !== "EXECUTING") return false;
                  expect(resumed.completedWaitpoints.map((w) => w.id)).not.toContain(waitpointId);
                  expect(resumed.completedWaitpoints.map((w) => w.id)).toContain(laterWaitpointId);
                  return true;
                },
                {
                  timeout: 10_000,
                  interval: 20,
                  message: "new parent wait never resumed with its own result",
                }
              )
              .toBe(true);
          }
        } finally {
          barrier.release();
          await original?.catch(() => {});
          await engine.quit();
          await recoveryEngine.quit();
          await producerStore.quit();
          await store.quit();
          await barrier.close();

          await snapshotStore.quit();
        }
      }
    );
  }

  redisTest(
    "keyed DATETIME arms recovery for each candidate before any record effect",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const coordinator = new StoreWaitpointCoordinator({ store });
      const candidates: string[] = [];
      try {
        const params = {
          projectId: "recovery-keyed-project",
          environmentId: "recovery-keyed-env",
          completedAfter: new Date(Date.now() + 60_000),
          idempotencyKey: "recovery-keyed-datetime",
          beforeStoreCreate: async (id: string) => {
            expect(await store.probeWaitpointPresence(id)).toBe("absent");
            candidates.push(id);
          },
        };
        const first = await coordinator.createDateTimeWaitpoint(params);
        const second = await coordinator.createDateTimeWaitpoint(params);
        expect(candidates).toHaveLength(2);
        expect(second.kind).toBe("cached");
        expect(second.waitpoint.id).toBe(first.waitpoint.id);
        expect(await store.probeWaitpointPresence(candidates[1])).toBe("absent");
      } finally {
        await store.quit();
      }
    }
  );

  for (const terminalPath of ["parked expiry", "finalization replay", "block timeout"] as const) {
    containerTest(
      `terminal org context: ${terminalPath} completes a store RUN waitpoint`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        let dial: SnapshotStoreDial = "redis-only";
        const engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          resolveDial: () => dial,
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "terminal_context_parent");
          // Child residency is independently Postgres; its parent's immutable Redis route still mints a store waitpoint.
          dial = "off";
          const externalId =
            terminalPath === "parked expiry" ? "terminal-context-missing-deployment" : undefined;
          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
            parkedOnExternalDeploymentId: externalId,
          });
          const waitpointId = deriveWaitpointIdFromAnchor(child.id, "RUN")!;
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })).toBe(
            0
          );
          const pending = await store.describeWaitpoint(waitpointId);
          expect(pending.outcome === "exists" && pending.status).toBe("PENDING");
          if (terminalPath === "parked expiry") {
            await engine.pendingVersionSystem.expireParkedExternalDeploymentRun({
              runId: child.id,
              externalDeploymentId: externalId!,
            });
          } else if (terminalPath === "finalization replay") {
            // Crash boundary: the terminal row committed, but its waitpoint completion never ran.
            await prisma.taskRun.update({
              where: { id: child.id },
              data: {
                status: "EXPIRED",
                expiredAt: new Date(),
                error: { type: "STRING_ERROR", raw: "expired" },
              },
            });
            await engine.runAttemptSystem.ensureRunFinalized({ runId: child.id });
          } else {
            const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
              runId: parent.id,
              waitpointId,
              organizationId: env.organization.id,
            });
            await engine.blockRunWithWaitpoint({
              runId: parent.id,
              waitpoints: waitpointId,
              projectId: env.project.id,
              organizationId: env.organization.id,
              blockOperation,
              timeout: new Date(Date.now() + 50),
            });
          }
          await vi.waitFor(
            async () => {
              const completed = await store.describeWaitpoint(waitpointId);
              expect(
                completed.outcome === "exists" && completed.status,
                'waitpoint condition never settled: completed.outcome === "exists" && completed.status'
              ).toBe("COMPLETED");
            },
            { timeout: 10000, interval: 100 }
          );
        } finally {
          await engine.quit();
          await store.quit();
          await snapshotStore.quit();
        }
      }
    );
  }

  containerTest(
    "RUN recovery publishes a shared child without inventing a failed late-parent dependency",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const { store, admin, username, close } = await restrictedWaitpointStore(redisOptions);
      const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        const originalParent = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "shared-recovery-birth-parent");
        const failed = await engine.createFailedTaskRun({
          friendlyId: `run_${generateRunOpsId()}`,
          environment: env,
          taskIdentifier: "child-task",
          parentTaskRunId: originalParent.id,
          error: { type: "STRING_ERROR", raw: "shared recovery error" },
        });
        const waitingParent = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "shared-recovery-waiting-parent");
        const waitpointId = deriveWaitpointIdFromAnchor(failed.id, "RUN")!;
        const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
          runId: waitingParent.id,
          waitpointId,
          organizationId: env.organization.id,
        });
        expect(blockOperation).toBeDefined();
        const waitingSnapshotId = (await engine.getRunExecutionData({ runId: waitingParent.id }))!
          .snapshot.id;
        await admin.call("ACL", "SETUSER", username, "-hset");
        await expect(
          engine.getOrCreateRunWaitpoint({
            runId: failed.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
            blockingParentRunId: waitingParent.id,
          })
        ).rejects.toThrow(/permission|NOPERM/i);
        // Recovery was armed before the marker/record write and contains the late parent's cycle.
        expect(
          await engine["worker"].queue.getJob(`recoverRunWaitpoint:${failed.id}`)
        ).not.toBeNull();
        expect(await store.probeWaitpointPresence(waitpointId)).toBe("absent");
        await admin.call("ACL", "SETUSER", username, "+hset");
        const payload = {
          runId: failed.id,
          parentRunId: waitingParent.id,
          waitpointId,
          organizationId: env.organization.id,
          blockOperation: blockOperation!,
        };
        const foreignEnvironment = await prisma.runtimeEnvironment.create({
          data: {
            type: "DEVELOPMENT",
            slug: "foreign-recovery",
            projectId: env.project.id,
            organizationId: env.organization.id,
            apiKey: "foreign-recovery",
            pkApiKey: "foreign-recovery",
            shortcode: "foreign-recovery",
          },
        });
        const foreignParent = await prisma.taskRun.create({
          data: {
            id: generateRunOpsId(),
            friendlyId: `run_${generateRunOpsId()}`,
            runtimeEnvironmentId: foreignEnvironment.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
            taskIdentifier: "parent-task",
            queue: "task/parent-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "foreign",
            spanId: "foreign",
          },
        });
        await expect(
          engine.waitpointSystem.recoverRunWaitpoint({ ...payload, parentRunId: foreignParent.id })
        ).rejects.toThrow("parent scope conflict");
        expect(await store.probeWaitpointPresence(waitpointId)).toBe("absent");
        await expect(
          engine.waitpointSystem.recoverRunWaitpoint({
            ...payload,
            waitpointId: deriveWaitpointIdFromAnchor(generateRunOpsId(), "RUN")!,
          })
        ).rejects.toThrow("ownership conflict");
        await engine.waitpointSystem.recoverRunWaitpoint(payload);
        // Publication failed before any parent edge was accepted. Recovery owns the source,
        // while only an explicit successful retry may add the late parent's dependency.
        expect((await engine.getRunExecutionData({ runId: waitingParent.id }))!.snapshot.id).toBe(
          waitingSnapshotId
        );
        expect((await store.readBlockState(waitingParent.id)).pendingIds).toEqual([]);
        expect((await store.describeWaitpoint(waitpointId)).outcome).toBe("exists");
        const associated = await engine.getOrCreateRunWaitpoint({
          runId: failed.id,
          projectId: env.project.id,
          environmentId: env.id,
          organizationId: env.organization.id,
          blockingParentRunId: waitingParent.id,
        });
        await engine.blockRunWithWaitpoint({
          runId: waitingParent.id,
          waitpoints: associated.id,
          organizationId: env.organization.id,
          projectId: env.project.id,
          blockOperation,
        });
        await vi.waitFor(
          async () => {
            const resumed = await engine.getRunExecutionData({ runId: waitingParent.id });
            expect(
              resumed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("EXECUTING");
            expect(resumed?.completedWaitpoints).toContainEqual(
              expect.objectContaining({
                id: waitpointId,
                outputIsError: true,
                output: expect.stringContaining("shared recovery error"),
              })
            );
          },
          { timeout: 10_000 }
        );
        expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: failed.id } })).toBe(
          0
        );
        // Replay is fenced to the captured cycle, and preserves the winning completion.
        await engine.waitpointSystem.recoverRunWaitpoint(payload);
        const record = await store.describeWaitpoint(waitpointId);
        expect(record.outcome === "exists" && record.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
        await close();
        await snapshotStore.quit();
      }
    }
  );
  containerTest(
    "a failed pre-absorption child is queued by recovery without blocking a fresh retry",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        recoveryDelayMs: 60_000,
      });
      const redis = createRedisClient(redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "failed-child-parent");
        const friendlyId = RunId.generate().friendlyId;
        const childId = RunId.fromFriendlyId(friendlyId);
        const waitpointId = deriveRunWaitpointId(childId)!;
        await redis.set(runResultKey(parent.id), "wrong-type");
        await expect(
          triggerRun(engine, env, prisma, {
            friendlyId,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          })
        ).rejects.toThrow("WRONGTYPE");
        await redis.del(runResultKey(parent.id));
        expect((await store.readBlockState(parent.id)).pendingIds).toEqual([]);
        const runJob = await engine["worker"].getJob(`recoverRunWaitpoint:${childId}`);
        const runPayload = workerCatalog.recoverRunWaitpoint.schema.parse(runJob!.item);
        const blockJobId = `recoverWaitpointBlock:${parent.id}:${runPayload.blockOperation.absorptionId}`;
        const blockJob = await engine["worker"].getJob(blockJobId);
        expect(blockJob).not.toBeNull();
        const retry = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "child-task",
          parentTaskRunId: parent.id,
          resumeParentOnCompletion: true,
        });
        const retryWaitpointId = deriveRunWaitpointId(retry.id)!;
        // Run both actual production handlers: neither may add the failed request's absent edge to
        // the retry's active block. The child itself remains recoverable and queueable.
        await engine["worker"]["jobs"].recoverRunWaitpoint({
          id: `recoverRunWaitpoint:${childId}`,
          payload: runPayload,
          attempt: 0,
          visibilityTimeoutMs: 30_000,
        });
        await engine["worker"]["jobs"].recoverWaitpointBlock({
          id: blockJobId,
          payload: workerCatalog.recoverWaitpointBlock.schema.parse(blockJob!.item),
          attempt: 0,
          visibilityTimeoutMs: 30_000,
        });
        expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBe(1);
        expect((await store.readBlockState(parent.id)).pendingIds).toEqual([retryWaitpointId]);
        await engine.waitpointSystem.completeWaitpoint({
          id: retryWaitpointId,
          organizationId: env.organization.id,
        });
        await vi.waitFor(
          async () => {
            expect(
              (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
            ).toBe("EXECUTING");
          },
          { timeout: 10_000 }
        );
        expect((await store.readBlockState(parent.id)).pendingIds).toEqual([]);
        expect((await store.describeWaitpoint(waitpointId)).outcome).toBe("exists");
        expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: childId } })).status).toBe(
          "PENDING"
        );
      } finally {
        redis.disconnect();
        await engine.quit();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );

  // Catches: an uncommitted store child's recoverRunWaitpoint job retrying for ~35 days and then
  // sitting in the DLQ with no TTL; a late-committed child being treated as recoverable; and a
  // retired recovery reaching child publication, which would enqueue a child committed in that gap.
  containerTest(
    "an uncommitted child's recovery retires after the commit window and a late commit is inert",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        recoveryDelayMs: 60_000,
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "parent-task",
        });
        const parentAttempt = await dequeueAndStart(engine, "uncommitted-child-parent");
        const { id: childId, friendlyId } = RunId.generate();
        const waitpointId = deriveRunWaitpointId(childId)!;
        // The producer armed recovery and then never committed the child (crash or failed create).
        await engine.waitpointSystem.armRunWaitpointRecovery({
          runId: childId,
          parentRunId: parent.id,
          organizationId: env.organization.id,
          waitpointId,
          blockOperation: (await engine.waitpointSystem.buildStoreBlockOperation({
            runId: parent.id,
            waitpointId,
            organizationId: env.organization.id,
          }))!,
        });
        const jobId = `recoverRunWaitpoint:${childId}`;
        const payload = workerCatalog.recoverRunWaitpoint.schema.parse(
          (await engine["worker"].getJob(jobId))!.item
        );
        expect(payload.armedAt).toBeInstanceOf(Date);
        const recover = (armedAt: Date | undefined) =>
          engine["worker"]["jobs"].recoverRunWaitpoint({
            id: jobId,
            payload: { ...payload, armedAt },
            attempt: 0,
            visibilityTimeoutMs: 30_000,
          });
        const blockBefore = await store.readBlockState(parent.id);

        await expect(recover(payload.armedAt)).rejects.toThrow(/not committed/);
        await expect(recover(undefined)).rejects.toThrow(/not committed/);
        // Another engine holds the child's run lock: retirement must return before child publication,
        // where a child committing between the two primary reads would be enqueued.
        const lockHolder = makeEngine(prisma, redisOptions, {
          snapshotStore,
          workerDisabled: true,
        });
        try {
          await lockHolder["runLock"].lock("holdUncommittedChild", [childId], () =>
            recover(new Date(Date.now() - RUN_WAITPOINT_RECOVERY_COMMIT_WINDOW_MS - 1))
          );
        } finally {
          await lockHolder.quit();
        }

        expect(await engine["worker"].queue.sizeOfDeadLetterQueue()).toBe(0);
        expect((await store.readBlockState(parent.id)).pendingIds).toEqual([]);
        expect((await store.describeWaitpoint(waitpointId)).outcome).not.toBe("exists");
        expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBe(0);

        // The dead producer's create lands after retirement. Nothing publishes, blocks or enqueues
        // it: the producer did those after createRun, and the caller retries with a new id.
        await engine.runStore.createRun({
          organizationFlags: env.organization.featureFlags,
          data: {
            id: childId,
            engine: "V2",
            status: "PENDING",
            friendlyId,
            runtimeEnvironmentId: env.id,
            environmentType: env.type,
            organizationId: env.organization.id,
            projectId: env.project.id,
            taskIdentifier: "child-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: `t_${friendlyId}`,
            spanId: `s_${friendlyId}`,
            queue: "task/child-task",
            workerQueue: "main",
            isTest: false,
            taskEventStore: "taskEvent",
            queueTimestamp: new Date(),
            parentTaskRunId: parent.id,
            rootTaskRunId: parent.id,
            resumeParentOnCompletion: true,
            depth: 1,
          },
          snapshot: {
            engine: "V2",
            executionStatus: QUEUED_SNAPSHOT_STATUS,
            description: QUEUED_SNAPSHOT_DESCRIPTION,
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.project.id,
            organizationId: env.organization.id,
          },
        });

        expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBe(0);
        const blockAfter = await store.readBlockState(parent.id);
        expect(blockAfter.pendingIds).toEqual([]);
        expect(blockAfter.blockId).toBe(blockBefore.blockId);
        expect((await store.describeWaitpoint(waitpointId)).outcome).not.toBe("exists");
        expect(
          (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
        ).toBe("EXECUTING");
        await engine.completeRunAttempt({
          runId: parent.id,
          snapshotId: parentAttempt.snapshot.id,
          completion: { id: parent.id, ok: true, output: "", outputType: "text/plain" },
        });
        expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(
          "COMPLETED_SUCCESSFULLY"
        );
        expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: childId } })).status).toBe(
          "PENDING"
        );
      } finally {
        await engine.quit();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );

  for (const boundary of ["absorption reply", "phase 3 guard ack"] as const) {
    containerTest(
      `recovery completes an accepted child after losing the ${boundary}`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const barrier = await waitpointStoreBarrier(redisOptions);
        const admin = createRedisClient(redisOptions);
        const queueUser = `recovery_ack_${crypto.randomUUID()}`;
        const queuePassword = crypto.randomUUID();
        await admin.call("ACL", "SETUSER", queueUser, "on", `>${queuePassword}`, "~*", "+@all");
        const interruptedOptions = {
          ...barrier.redisOptions,
          retryStrategy: () => null,
          maxRetriesPerRequest: 0,
        };
        const producerStore = new WaitpointStoreCoordinator({
          redisOptions: boundary === "absorption reply" ? interruptedOptions : redisOptions,
        });
        let engine = makeEngine(prisma, redisOptions, {
          store: producerStore,
          snapshotStore,
          workerDisabled: true,
          recoveryDelayMs: 60_000,
          workerRedisOptions:
            boundary === "phase 3 guard ack"
              ? { ...interruptedOptions, username: queueUser, password: queuePassword }
              : redisOptions,
        });
        const setupEngine = makeEngine(prisma, redisOptions, { store, snapshotStore });
        let setupStopped = false;
        let original: Promise<unknown> | undefined;
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(setupEngine, env, ["parent-task", "child-task"]);
          const parent = await triggerRun(setupEngine, env, prisma, {
            friendlyId: RunId.generate().friendlyId,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(setupEngine, `accepted-${boundary}-parent`);
          await setupEngine.quit();
          setupStopped = true;
          const friendlyId = RunId.generate().friendlyId;
          const childId = RunId.fromFriendlyId(friendlyId);
          const waitpointId = deriveRunWaitpointId(childId)!;
          barrier.pause(
            boundary === "absorption reply"
              ? (args) =>
                  args[0]?.toLowerCase() === "eval" &&
                  args.includes(runBlockKeys(parent.id).edge) &&
                  args.includes(waitpointId)
              : (args) =>
                  args.some((arg) => arg.startsWith(`ensureAbsorptionCompensated:${parent.id}:`)),
            boundary === "absorption reply" ? "reply" : "request"
          );
          original = triggerRun(engine, env, prisma, {
            friendlyId,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          }).then(
            () => undefined,
            (error: unknown) => error
          );
          await expect.poll(() => barrier.held, { timeout: 5000, interval: 10 }).toBe(true);
          expect((await store.readBlockState(parent.id)).pendingIds).toEqual([waitpointId]);
          expect(
            (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
          ).toBe(boundary === "absorption reply" ? "EXECUTING" : "EXECUTING_WITH_WAITPOINTS");
          // Drop the producer's connection after the durable boundary, then discard its engine.
          // Recovery must use queued payloads and committed state, with no in-memory continuation.
          if (boundary === "absorption reply") {
            barrier.disconnect();
          } else {
            // Queue clients reconnect and replay a disconnected request. Deny the held ACK on
            // this private queue user instead, to make its actual Redis failure deterministic.
            await admin.call("ACL", "SETUSER", queueUser, "-eval", "-evalsha");
            barrier.release();
          }
          expect(await original).toBeInstanceOf(Error);
          await admin.call("ACL", "SETUSER", queueUser, "+@all");
          await engine.quit();
          engine = makeEngine(prisma, redisOptions, {
            store,
            snapshotStore,
            recoveryDelayMs: 60_000,
          });
          const runJobId = `recoverRunWaitpoint:${childId}`;
          const runJob = await engine["worker"].getJob(runJobId);
          const payload = workerCatalog.recoverRunWaitpoint.schema.parse(runJob!.item);
          const blockJobId = `recoverWaitpointBlock:${parent.id}:${payload.blockOperation.absorptionId}`;
          const blockJob = await engine["worker"].getJob(blockJobId);
          expect(blockJob).not.toBeNull();
          expect(
            await store.readContribution({
              runId: parent.id,
              blockId: payload.blockOperation.id,
              absorptionId: payload.blockOperation.absorptionId,
            })
          ).toHaveLength(boundary === "absorption reply" ? 1 : 0);
          await engine["worker"]["jobs"].recoverRunWaitpoint({
            id: runJobId,
            payload,
            attempt: 0,
            visibilityTimeoutMs: 30_000,
          });
          // The first replay retired the contribution. A duplicate lower handler must still finish
          // existing registration/tail effects from exact edge evidence without adding another edge.
          await engine["worker"]["jobs"].recoverWaitpointBlock({
            id: blockJobId,
            payload: workerCatalog.recoverWaitpointBlock.schema.parse(blockJob!.item),
            attempt: 0,
            visibilityTimeoutMs: 30_000,
          });
          expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBe(1);
          expect((await store.readBlockState(parent.id)).edges).toHaveLength(1);
          const redis = createRedisClient(redisOptions);
          try {
            expect(await redis.hlen(waitpointKeys(waitpointId).watchers)).toBe(1);
          } finally {
            redis.disconnect();
          }
          await engine.waitpointSystem.completeWaitpoint({
            id: waitpointId,
            organizationId: env.organization.id,
          });
          await vi.waitFor(
            async () => {
              expect(
                (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
              ).toBe("EXECUTING");
            },
            { timeout: 10_000 }
          );
        } finally {
          barrier.release();
          await original;
          await engine.quit();
          if (!setupStopped) await setupEngine.quit();
          await producerStore.quit();
          await store.quit();
          await barrier.close();
          await admin.call("ACL", "DELUSER", queueUser);
          admin.disconnect();
          await snapshotStore.quit();
        }
      }
    );
  }
});
