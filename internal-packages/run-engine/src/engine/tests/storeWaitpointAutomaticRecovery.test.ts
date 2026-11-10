import {
  containerTestWithIsolatedRedis as containerTest,
  redisTest,
} from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { deriveRunWaitpointId } from "../waitpointCoordinator/runWaitpointId.js";
import { workerCatalog } from "../workerCatalog.js";
import { QUEUED_SNAPSHOT_DESCRIPTION, QUEUED_SNAPSHOT_STATUS } from "../consts.js";
import { RUN_WAITPOINT_RECOVERY_COMMIT_WINDOW_MS } from "../systems/waitpointSystem.js";
import { runBlockKeys, runResultKey, waitpointKeys } from "../waitpointCoordinator/keys.js";
import { RedisSnapshotStore } from "@internal/run-store";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  parseWaitpointId,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";

import { waitpointStoreBarrier } from "./utils/waitpointStoreBarrier.js";
import { describe, expect, vi } from "vitest";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("storeWaitpointAutomaticRecovery", () => {
  describe("Automatic store waitpoint recovery without traffic", () => {
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
  });

  containerTest(
    "a delayed original producer cannot republish the child after recovery queues it",
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
      });
      const recoveryEngine = makeEngine(prisma, redisOptions, { store, snapshotStore });
      let original: ReturnType<typeof triggerRun> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "recovery-delayed-producer-parent");
        const friendlyId = `run_${generateRunOpsId()}`;
        const runId = RunId.fromFriendlyId(friendlyId);
        const waitpointId = deriveWaitpointIdFromAnchor(runId, "RUN")!;
        barrier.pause(
          (args) =>
            args[2] === "1" &&
            args[3] === `wp:v1:{${waitpointId}}` &&
            args[4]!.includes('"type":"RUN"')
        );
        original = triggerRun(engine, env, prisma, {
          friendlyId,
          taskIdentifier: "child-task",
          parentTaskRunId: parent.id,
          resumeParentOnCompletion: true,
        });
        await expect
          .poll(() => barrier.held, {
            timeout: 5000,
            interval: 10,
            message: "original RUN source write never reached real Redis request",
          })
          .toBe(true);
        await vi.waitFor(
          async () => {
            expect(
              await engine.runQueue.messageExists(env.organization.id, runId),
              "child was never published to its run queue"
            ).toBe(1);
          },
          { timeout: 10_000 }
        );
        // RUN recovery arrived before the producer's first parent absorption. It may publish the
        // child, but cannot make the request's first parent dependency on the producer's behalf.
        expect((await store.readBlockState(parent.id)).pendingIds).toEqual([]);
        expect(
          (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
        ).toBe("EXECUTING");
        barrier.release();
        expect((await original).id).toBe(runId);
        expect((await store.readBlockState(parent.id)).pendingIds).toEqual([waitpointId]);
        const child = await dequeueAndStart(engine, "recovery-delayed-producer-child");
        expect(child.run.id).toBe(runId);
        expect(
          await engine.dequeueFromWorkerQueue({
            blockingPopTimeoutSeconds: 1,
            consumerId: "recovery-no-duplicate",
            workerQueue: "main",
          })
        ).toHaveLength(0);
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
});
