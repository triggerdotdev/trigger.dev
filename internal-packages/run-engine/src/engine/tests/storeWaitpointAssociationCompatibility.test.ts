import { deriveRunWaitpointId } from "../waitpointCoordinator/runWaitpointId.js";
import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { hasStoreWaitpoints, RedisSnapshotStore } from "@internal/run-store";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  parseWaitpointId,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient } from "@internal/redis";
import { describe, expect, vi } from "vitest";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
  restrictedWaitpointStore,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("storeWaitpointAssociationCompatibility", () => {
  describe("Store RUN waitpoint failure boundary", () => {
    containerTest(
      "a crash before the store record write fails loud (no half-block, no phantom); recovery mints exactly once",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const { store, admin, username, close } = await restrictedWaitpointStore(redisOptions);
        let engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          recoveryDelayMs: 1000,
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const orgId = env.organization.id;
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);

          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "c_parent_fb");

          const childFriendlyId = `run_${generateRunOpsId()}`;
          // Deny the real source-record write only on the waitpoint client.
          await admin.call("ACL", "SETUSER", username, "-hset");
          await expect(
            triggerRun(engine, env, prisma, {
              friendlyId: childFriendlyId,
              taskIdentifier: "child-task",
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
            })
          ).rejects.toThrow(/permission|NOPERM/i);

          const childId = childFriendlyId.replace(/^run_/, "");
          const derivedId = deriveWaitpointIdFromAnchor(childId, "RUN")!;

          // The child committed, but there is NO store waitpoint and NO phantom Postgres row...
          expect(await prisma.taskRun.count({ where: { id: childId } })).toBe(1);
          expect(await store.probeWaitpointPresence(derivedId)).toBe("absent");
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: childId } })).toBe(
            0
          );

          // ...and the parent was never half-blocked: it is still plainly EXECUTING.
          const parentEd = await engine.getRunExecutionData({ runId: parent.id });
          expect(parentEd?.snapshot.executionStatus).toBe("EXECUTING");

          await engine.quit();
          await admin.call("ACL", "SETUSER", username, "+hset");
          engine = makeEngine(prisma, redisOptions, {
            store,
            snapshotStore,
            recoveryDelayMs: 1000,
          });
          // With no caller traffic, the worker repairs the source and child queue. The failed
          // request never accepted a parent edge, so recovery must leave the parent unblocked.
          await vi.waitFor(
            async () => {
              expect(
                await store.probeWaitpointPresence(derivedId),
                "waitpoint source never reached its expected presence"
              ).toBe("present");
              expect(
                (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
              ).toBe("EXECUTING");
              expect((await store.readBlockState(parent.id)).edges).toEqual([]);
              expect(await engine.runQueue.messageExists(orgId, childId)).toBe(1);
            },
            { timeout: 10_000, interval: 100 }
          );
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: childId } })).toBe(
            0
          );
        } finally {
          await engine.quit();
          await close();

          await snapshotStore.quit();
        }
      }
    );
  });

  describe("Store RUN waitpoint for a failed-at-creation child", () => {
    containerTest(
      "createFailedTaskRun mints a store RUN waitpoint for a redis-primary parent, completes it, and resumes",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const orgId = env.organization.id;
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);

          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "c_parent_ff");

          const childFriendlyId = `run_${generateRunOpsId()}`;
          const failed = await engine.createFailedTaskRun({
            friendlyId: childFriendlyId,
            environment: {
              id: env.id,
              type: env.type,
              project: { id: env.project.id },
              organization: { id: orgId },
            },
            taskIdentifier: "child-task",
            payload: "{}",
            payloadType: "application/json",
            error: { type: "STRING_ERROR", raw: "created already-failed" },
            traceId: "0123456789abcdef0123456789abcdef",
            spanId: "fedcba9876543210",
            resumeParentOnCompletion: true,
            parentTaskRunId: parent.id,
          });
          expect(failed.status).toBe("SYSTEM_FAILURE");

          // The failed child's RUN waitpoint is a store record (no Postgres row), already COMPLETED.
          const derivedId = deriveWaitpointIdFromAnchor(failed.id, "RUN")!;
          const desc = await store.describeWaitpoint(derivedId);
          expect(desc.outcome === "exists" ? desc.status : undefined).toBe("COMPLETED");
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: failed.id } })).toBe(
            0
          );

          // The parent was blocked; deliver the completion and resume it.
          const blocked = await engine.getRunExecutionData({ runId: parent.id });
          expect(blocked?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
          await store.deliverCompletion({
            runId: parent.id,
            blockId: (await store.readBlockState(parent.id)).blockId!,
            waitpointId: derivedId,
            completion: {
              completedAt: new Date().toISOString(),
              outputType: "application/json",
              outputIsError: true,
              output: { inline: '{"type":"STRING_ERROR"}' },
            },
          });
          await engine.waitpointSystem.continueRunIfUnblocked({
            runId: parent.id,
            organizationId: orgId,
          });
          await vi.waitFor(
            async () => {
              const ed = await engine.getRunExecutionData({ runId: parent.id });
              expect(
                ed?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
            },
            { timeout: 10_000, interval: 100 }
          );
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );
  });

  describe("createFailedTaskRun batch child stays legacy", () => {
    containerTest(
      "a failed BATCH child of a redis-primary parent mints a LEGACY waitpoint, never store",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const orgId = env.organization.id;
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);

          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "c_parent_fb2");

          const batchId = `batch_tri13748_${generateRunOpsId()}`;
          await prisma.batchTaskRun.create({
            data: {
              id: batchId,
              friendlyId: `batch_${generateRunOpsId()}`,
              runtimeEnvironmentId: env.id,
            },
          });

          const childFriendlyId = `run_${generateRunOpsId()}`;
          const failed = await engine.createFailedTaskRun({
            friendlyId: childFriendlyId,
            environment: {
              id: env.id,
              type: env.type,
              project: { id: env.project.id },
              organization: { id: orgId },
            },
            taskIdentifier: "child-task",
            payload: "{}",
            payloadType: "application/json",
            error: { type: "STRING_ERROR", raw: "failed batch child" },
            traceId: "0123456789abcdef0123456789abcdef",
            spanId: "fedcba9876543210",
            resumeParentOnCompletion: true,
            parentTaskRunId: parent.id,
            batch: { id: batchId, index: 0 },
          });
          expect(failed.status).toBe("SYSTEM_FAILURE");

          // Batch child MUST be legacy: a Postgres associated-waitpoint row exists, no store record.
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: failed.id } })).toBe(
            1
          );
          expect(
            await store.probeWaitpointPresence(deriveWaitpointIdFromAnchor(failed.id, "RUN")!)
          ).toBe("absent");
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );
  });

  describe("Lazy RUN association is legacy for a batch-blocked parent", () => {
    containerTest(
      "getOrCreateRunWaitpoint with blockingViaBatch mints a LEGACY waitpoint, never store",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const orgId = env.organization.id;
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);

          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "c_parent_bl");

          // An existing standalone child with no association.
          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
          });
          const derivedId = deriveWaitpointIdFromAnchor(child.id, "RUN")!;

          const waitpoint = await engine.getOrCreateRunWaitpoint({
            runId: child.id,
            projectId: env.project.id,
            environmentId: env.id,
            blockingParentRunId: parent.id,
            organizationId: orgId,
            blockingViaBatch: true,
          });

          // Batch child stays legacy: a Postgres row exists, the derived store id does not.
          expect(parseWaitpointId(waitpoint.id).format).toBe("legacy");
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })).toBe(
            1
          );
          expect(await store.probeWaitpointPresence(derivedId)).toBe("absent");
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );
  });

  describe("Shareable RUN children retain one associated waitpoint", () => {
    containerTest(
      "concurrent idempotent triggerAndWait mints one store waitpoint and batch reuse keeps that identity",
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
          await dequeueAndStart(engine, "c_parent_share");

          // Shared children follow the same parent-based mint policy as private children.
          const key = `idem-${generateRunOpsId()}`;
          const contenders = await Promise.allSettled(
            [0, 1].map(() =>
              triggerRun(engine, env, prisma, {
                friendlyId: `run_${generateRunOpsId()}`,
                taskIdentifier: "child-task",
                parentTaskRunId: parent.id,
                resumeParentOnCompletion: true,
                idempotencyKey: key,
              })
            )
          );
          const winners = contenders.filter((r) => r.status === "fulfilled");
          expect(winners).toHaveLength(1);
          const child = winners[0]!.value;
          const losers = contenders.filter((r) => r.status === "rejected");
          expect(losers).toHaveLength(1);
          expect(losers[0]!.reason.name).toBe("RunDuplicateIdempotencyKeyError");
          const reused = await prisma.taskRun.findFirstOrThrow({
            where: {
              runtimeEnvironmentId: env.id,
              taskIdentifier: "child-task",
              idempotencyKey: key,
            },
          });
          expect(reused.id).toBe(child.id);
          const association = await engine.getOrCreateRunWaitpoint({
            runId: reused.id,
            projectId: env.project.id,
            environmentId: env.id,
            blockingParentRunId: parent.id,
            organizationId: env.organization.id,
            blockingViaBatch: true,
          });
          expect(association.id).toBe(deriveWaitpointIdFromAnchor(child.id, "RUN"));
          expect(await prisma.taskRun.count({ where: { idempotencyKey: key } })).toBe(1);
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })).toBe(
            0
          );
          expect(await store.probeWaitpointPresence(association.id)).toBe("present");
          // Cached idempotency and debounce callers use the locked block seam even in batches.
          const batch = await prisma.batchTaskRun.create({
            data: {
              id: generateRunOpsId(),
              friendlyId: `batch_${generateRunOpsId()}`,
              runtimeEnvironmentId: env.id,
            },
          });
          const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
            runId: parent.id,
            waitpointId: association.id,
            organizationId: env.organization.id,
          });
          await engine.blockRunWithWaitpoint({
            runId: parent.id,
            waitpoints: association.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
            blockOperation,
            batch: { id: batch.id, index: 7 },
          });
          const attempt = await dequeueAndStart(engine, "shared-idem-child");
          expect(attempt.run.id).toBe(child.id);
          await engine.completeRunAttempt({
            runId: child.id,
            snapshotId: attempt.snapshot.id,
            completion: { id: child.id, ok: true, output: "false", outputType: "application/json" },
          });
          await vi.waitFor(
            async () => {
              const resumed = await engine.getRunExecutionData({ runId: parent.id });
              expect(
                resumed?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
              expect(resumed?.completedWaitpoints).toContainEqual(
                expect.objectContaining({
                  id: association.id,
                  output: "false",
                  outputIsError: false,
                })
              );
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
      "concurrent lazy getOrCreateRunWaitpoint mints one store association for shared children",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const orgId = env.organization.id;
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);

          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "c_parent_share2");

          // Originally standalone children acquire one deterministic association when late waiters arrive.
          const idemChild = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            idempotencyKey: `idem-${generateRunOpsId()}`,
          });
          const debounceChild = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            debounce: { key: "d", delay: "30s" },
            delayUntil: new Date(Date.now() + 30_000),
          });

          for (const child of [idemChild, debounceChild]) {
            const lookup = {
              runId: child.id,
              projectId: env.project.id,
              environmentId: env.id,
              blockingParentRunId: parent.id,
              organizationId: orgId,
            };
            const associations = await Promise.all([
              engine.getOrCreateRunWaitpoint(lookup),
              engine.getOrCreateRunWaitpoint(lookup),
            ]);
            const waitpoint = associations[0]!;
            expect(associations[1]!.id).toBe(waitpoint.id);
            expect(waitpoint.id).toBe(deriveWaitpointIdFromAnchor(child.id, "RUN"));
            expect(parseWaitpointId(waitpoint.id).format).toBe("b32hexW");
            expect(
              await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })
            ).toBe(0);
            expect(
              await store.probeWaitpointPresence(deriveWaitpointIdFromAnchor(child.id, "RUN")!)
            ).toBe("present");
          }
          const before = await prisma.taskRun.findUniqueOrThrow({
            where: { id: debounceChild.id },
          });
          const rescheduled = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
            debounce: { key: "d", delay: "60s", mode: "trailing" },
            delayUntil: new Date(Date.now() + 60_000),
            payload: '{"replacement":true}',
          });
          expect(rescheduled.id).toBe(debounceChild.id);
          const after = await prisma.taskRun.findUniqueOrThrow({ where: { id: rescheduled.id } });
          expect(after.payload).toBe('{"replacement":true}');
          expect(after.delayUntil!.getTime()).toBeGreaterThan(before.delayUntil!.getTime());
          const oldId = deriveWaitpointIdFromAnchor(debounceChild.id, "RUN")!;
          expect(
            await engine.waitpointSystem.resolveAssociatedRunWaitpointId({
              runId: rescheduled.id,
              organizationId: orgId,
            })
          ).toBe(oldId);
          await engine.cancelRun({ runId: debounceChild.id });
          const replacement = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            debounce: { key: "d", delay: "30s" },
            delayUntil: new Date(Date.now() + 30_000),
          });
          expect(replacement.id).not.toBe(debounceChild.id);
          const replacementWaitpoint = await engine.getOrCreateRunWaitpoint({
            runId: replacement.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: orgId,
            blockingParentRunId: parent.id,
          });
          expect(replacementWaitpoint.id).not.toBe(oldId);
          const oldRecord = await store.describeWaitpoint(oldId);
          expect(oldRecord.outcome === "exists" && oldRecord.status).toBe("COMPLETED");
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );
  });

  describe("Parallel triggerAndWait store blocks join one cycle", () => {
    containerTest(
      "two children from one redis-primary parent register additively under a single block id, then both resume",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const orgId = env.organization.id;
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);

          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "c_parent_par");

          // Two triggerAndWait children on the same parent in the same cycle (Promise.all serializes on the
          // parent run lock). Each is a separate block call; they must join ONE block, not refuse the second.
          const childA = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          });
          const childB = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          });
          const derivedA = deriveWaitpointIdFromAnchor(childA.id, "RUN")!;
          const derivedB = deriveWaitpointIdFromAnchor(childB.id, "RUN")!;

          // Both waitpoints live under ONE block id (additive registration), and both are still pending.
          const state = await store.readBlockState(parent.id);
          expect(state.blockId).toBeDefined();
          expect(state.pendingIds.sort()).toEqual([derivedA, derivedB].sort());

          // Complete both children; deliver both to the one block; the parent resumes.
          for (const child of [childA, childB]) {
            const attempt = await dequeueAndStart(engine, `c_child_${child.friendlyId}`);
            await engine.completeRunAttempt({
              runId: child.id,
              snapshotId: attempt.snapshot.id,
              completion: { id: child.id, ok: true, output: "{}", outputType: "application/json" },
            });
          }
          const blockId = (await store.readBlockState(parent.id)).blockId!;
          for (const derived of [derivedA, derivedB]) {
            await store.deliverCompletion({
              runId: parent.id,
              blockId,
              waitpointId: derived,
              completion: {
                completedAt: new Date().toISOString(),
                outputType: "application/json",
                outputIsError: false,
                output: { inline: "{}" },
              },
            });
          }
          await engine.waitpointSystem.continueRunIfUnblocked({
            runId: parent.id,
            organizationId: orgId,
          });
          await vi.waitFor(
            async () => {
              const ed = await engine.getRunExecutionData({ runId: parent.id });
              expect(
                ed?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
            },
            { timeout: 10_000, interval: 100 }
          );
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );
  });

  describe("Legacy RUN anchors with Redis waitpoints enabled", () => {
    for (const creation of ["eager", "lazy", "failed-at-creation", "existing-postgres"] as const) {
      containerTest(
        `${creation}: a CUID child preserves its association and resumes its Postgres parent`,
        async ({ prisma, redisOptions }) => {
          const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
          const store = new WaitpointStoreCoordinator({ redisOptions });
          await prisma.$executeRawUnsafe(
            `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
          );
          const options = {
            store,
            snapshotStore,
            enabled: creation !== "existing-postgres",
            resolveDial: () => "off" as const,
          };
          const engine = makeEngine(prisma, redisOptions, options);
          const probe = createRedisClient(redisOptions);
          try {
            const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
            const orgId = env.organization.id;
            await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
            const parent = await triggerRun(engine, env, prisma, {
              friendlyId: RunId.generate().friendlyId,
              taskIdentifier: "parent-task",
            });
            await dequeueAndStart(engine, "legacy_anchor_parent");

            const childFriendlyId = RunId.generate().friendlyId;
            expect(deriveWaitpointIdFromAnchor(childFriendlyId, "RUN")).toBeUndefined();
            const child =
              creation === "failed-at-creation"
                ? await engine.createFailedTaskRun({
                    friendlyId: childFriendlyId,
                    environment: {
                      id: env.id,
                      type: env.type,
                      project: { id: env.project.id },
                      organization: { id: orgId },
                    },
                    taskIdentifier: "child-task",
                    payload: "{}",
                    payloadType: "application/json",
                    error: { type: "STRING_ERROR", raw: "legacy child failure" },
                    traceId: "0123456789abcdef0123456789abcdef",
                    spanId: "fedcba9876543210",
                    resumeParentOnCompletion: true,
                    parentTaskRunId: parent.id,
                  })
                : await triggerRun(engine, env, prisma, {
                    friendlyId: childFriendlyId,
                    taskIdentifier: "child-task",
                    ...(creation === "eager" || creation === "existing-postgres"
                      ? { parentTaskRunId: parent.id, resumeParentOnCompletion: true }
                      : {}),
                  });

            if (creation === "lazy") {
              const waitpoint = await engine.getOrCreateRunWaitpoint({
                runId: child.id,
                projectId: env.project.id,
                environmentId: env.id,
                blockingParentRunId: parent.id,
                organizationId: orgId,
              });
              await engine.blockRunWithWaitpoint({
                runId: parent.id,
                waitpoints: waitpoint.id,
                projectId: env.project.id,
                organizationId: orgId,
                blockOperation: await engine.waitpointSystem.buildStoreBlockOperation({
                  runId: parent.id,
                  waitpointId: waitpoint.id,
                  organizationId: orgId,
                }),
              });
            }

            options.enabled = true;
            const pg = await prisma.waitpoint.findFirst({
              where: { completedByTaskRunId: child.id },
            });
            const id = pg?.id ?? deriveRunWaitpointId(child.id)!;
            expect(parseWaitpointId(id).format).toBe(
              creation === "existing-postgres" ? "legacy" : "b32hexW"
            );
            expect(await store.probeWaitpointPresence(deriveRunWaitpointId(child.id)!)).toBe(
              creation === "existing-postgres" ? "absent" : "present"
            );
            expect(
              hasStoreWaitpoints(
                (await prisma.taskRun.findUniqueOrThrow({ where: { id: child.id } })).annotations
              )
            ).toBe(creation !== "existing-postgres");

            if (creation !== "failed-at-creation") {
              expect(
                (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
              ).toBe("EXECUTING_WITH_WAITPOINTS");
              const attempt = await dequeueAndStart(engine, "legacy_anchor_child");
              await engine.completeRunAttempt({
                runId: child.id,
                snapshotId: attempt.snapshot.id,
                completion: {
                  id: child.id,
                  ok: true,
                  output: '{"legacy":true}',
                  outputType: "application/json",
                },
              });
            }

            await vi.waitFor(
              async () => {
                expect(
                  (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot
                    .executionStatus,
                  "run never reached the expected execution status"
                ).toBe("EXECUTING");
              },
              { timeout: 10_000, interval: 100 }
            );
            const resumed = await engine.getRunExecutionData({ runId: parent.id });
            expect(resumed?.completedWaitpoints).toContainEqual(
              expect.objectContaining({
                id,
                outputIsError: creation === "failed-at-creation",
                ...(creation !== "failed-at-creation" ? { output: '{"legacy":true}' } : {}),
              })
            );

            // A later waiter reuses the same association even after enrollment changes.
            options.enabled = true;
            const reused = await engine.getOrCreateRunWaitpoint({
              runId: child.id,
              projectId: env.project.id,
              environmentId: env.id,
              blockingParentRunId: parent.id,
              organizationId: orgId,
            });
            expect(reused.id).toBe(id);
            expect(
              await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })
            ).toBe(creation === "existing-postgres" ? 1 : 0);
            if (creation === "existing-postgres") expect(await probe.keys("wp:v1*")).toEqual([]);
          } finally {
            probe.disconnect();
            await engine.quit();
            await store.quit();

            await snapshotStore.quit();
          }
        }
      );
    }
  });
});
