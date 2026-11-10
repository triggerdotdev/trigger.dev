import { deriveRunWaitpointId } from "../waitpointCoordinator/runWaitpointId.js";
import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { hasStoreWaitpoints, RedisSnapshotStore } from "@internal/run-store";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  RunId,
  generateWaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient } from "@internal/redis";
import { describe, expect, vi } from "vitest";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { runResultKey, waitpointKeys } from "../waitpointCoordinator/keys.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("storeWaitpointLifecycleRouting", () => {
  describe("Store RUN waitpoint lifecycle (real RunEngine + MemoryDB)", () => {
    containerTest(
      "older parent preserves mixed legacy DATETIME and completed-before-registration shared RUN errors, and rejects missing/foreign results",
      async ({ prisma, redisOptions }) => {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
        );
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          resolveDial: () => "off",
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          const attempt = await dequeueAndStart(engine, "mixed_late_parent");
          const sharedId = generateWaitpointId("RUN");
          const error = '{"type":"BUILT_IN_ERROR","message":"shared failure"}';
          const record = {
            id: sharedId,
            friendlyId: `waitpoint_${sharedId}`,
            type: "RUN" as const,
            environmentId: env.id,
            projectId: env.project.id,
            completedByTaskRunId: "shared_error_child",
            userProvidedIdempotencyKey: false,
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await store.createIfAbsent({ record, status: "PENDING" });
          await store.complete({
            waitpointId: sharedId,
            completion: {
              completedAt: new Date().toISOString(),
              output: { inline: error },
              outputType: "application/json",
              outputIsError: true,
            },
          });
          const legacy = await prisma.waitpoint.create({
            data: {
              id: "csharedlegacydatetime00001",
              friendlyId: "waitpoint_legacy_datetime",
              type: "DATETIME",
              status: "COMPLETED",
              completedAfter: new Date(),
              completedAt: new Date(),
              projectId: env.project.id,
              environmentId: env.id,
              idempotencyKey: "legacy-date",
              userProvidedIdempotencyKey: false,
              output: "legacy-value",
              outputType: "text/plain",
            },
          });
          const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
            runId: parent.id,
            waitpointId: sharedId,
            organizationId: env.organization.id,
          });
          await engine.blockRunWithWaitpoint({
            runId: parent.id,
            waitpoints: [legacy.id, sharedId],
            projectId: env.project.id,
            organizationId: env.organization.id,
            blockOperation,
          });
          await vi.waitFor(
            async () => {
              const data = await engine.getRunExecutionData({ runId: parent.id });
              expect(
                data?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
              expect(data?.completedWaitpoints).toHaveLength(2);
              expect(data?.completedWaitpoints.find((w) => w.id === sharedId)).toMatchObject({
                output: error,
                outputIsError: true,
                completedByTaskRun: { id: "shared_error_child" },
              });
              expect(data?.completedWaitpoints.find((w) => w.id === legacy.id)).toMatchObject({
                output: "legacy-value",
                type: "DATETIME",
              });
            },
            { timeout: 10_000, interval: 100 }
          );
          const resumed = (await engine.runStore.findLatestExecutionSnapshot(parent.id))!;
          await prisma.taskRunExecutionSnapshot.update({
            where: { id: resumed.id },
            data: {
              completedWaitpointOrder: [sharedId, legacy.id, sharedId],
            },
          });
          const ordered = (await engine.getRunExecutionData({ runId: parent.id }))!;
          expect(
            ordered.completedWaitpoints.filter((w) => w.id === sharedId).map((w) => w.index)
          ).toEqual([0, 2]);
          expect(ordered.completedWaitpoints.find((w) => w.id === legacy.id)?.index).toBe(1);
          const since = await engine.getSnapshotsSince({
            runId: parent.id,
            snapshotId: attempt.snapshot.id,
          });
          expect(since?.at(-1)?.completedWaitpoints.find((w) => w.id === sharedId)?.output).toBe(
            error
          );
          expect((await store.readBlockState(parent.id)).blockId).toBeUndefined();
          expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: parent.id } })).toBe(0);
          expect(await prisma.waitpoint.count({ where: { id: sharedId } })).toBe(0);
          // Corrupt durable references fail closed, including tenant mismatch, instead of returning a lossy result.
          const raw = createRedisClient(redisOptions);
          try {
            const retained = JSON.parse((await raw.hget(runResultKey(parent.id), sharedId))!);
            await raw.hset(
              runResultKey(parent.id),
              sharedId,
              JSON.stringify({ ...retained, record: { ...record, environmentId: "another-env" } })
            );
            await expect(engine.runStore.findLatestExecutionSnapshot(parent.id)).rejects.toThrow(
              "another environment"
            );
            await raw.hdel(runResultKey(parent.id), sharedId);
            await raw.del(waitpointKeys(sharedId).record);
            await expect(engine.runStore.findLatestExecutionSnapshot(parent.id)).rejects.toThrow(
              "No store waitpoint record"
            );
          } finally {
            raw.disconnect();
          }
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );

    for (const dial of ["off", "dual-write", "redis-only"] as const) {
      for (const enabled of [false, true]) {
        containerTest(
          `RUN rollout is independent: TRES=${dial}, waitpoints=${enabled}`,
          async ({ prisma, redisOptions }) => {
            // Apply the existing production migration omitted by schema-push fixtures.
            await prisma.$executeRawUnsafe(
              `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
            );
            const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
            const store = new WaitpointStoreCoordinator({ redisOptions });
            let enabledOrganization: string | undefined;
            const options = {
              store,
              snapshotStore,
              resolveDial: () => dial,
              isWaitpointStoreEnabled: (organizationId: string) =>
                organizationId === enabledOrganization,
            };
            const engine = makeEngine(prisma, redisOptions, options);
            try {
              const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
              await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);

              const parent = await triggerRun(engine, env, prisma, {
                friendlyId:
                  dial === "off" ? RunId.generate().friendlyId : `run_${generateRunOpsId()}`,
                taskIdentifier: "parent-task",
              });
              await dequeueAndStart(engine, "c_parent");

              // This parent predates waitpoint opt-in; its snapshot home stays fixed.
              enabledOrganization = enabled ? env.organization.id : undefined;
              const route = await engine.runStore.readSnapshotRoute(parent.id, env.organization.id);
              expect(route?.residency).toBe(
                dial === "off" ? "postgres" : dial === "dual-write" ? "mirrored" : "redis-primary"
              );
              const control = await prisma.organization.create({
                data: { title: "Control", slug: "control" },
              });
              const controlPlan = await engine.waitpointSystem.planRunAssociatedWaitpoint({
                organizationId: control.id,
                projectId: env.project.id,
                environmentId: env.id,
                anchorRunId: generateRunOpsId(),
                parentRunId: parent.id,
              });
              expect(controlPlan.plan.residency).toBe("legacy");

              const child = await triggerRun(engine, env, prisma, {
                friendlyId:
                  dial === "off" ? RunId.generate().friendlyId : `run_${generateRunOpsId()}`,
                taskIdentifier: "child-task",
                parentTaskRunId: parent.id,
                resumeParentOnCompletion: true,
              });

              // The child's RUN waitpoint is a store record, NOT a Postgres row.
              const derivedId = deriveRunWaitpointId(child.id)!;
              expect(derivedId).toBeDefined();
              expect(await store.probeWaitpointPresence(derivedId)).toBe(
                enabled ? "present" : "absent"
              );
              const pgRow = await prisma.waitpoint.findFirst({
                where: { completedByTaskRunId: child.id },
              });
              if (enabled) expect(pgRow).toBeNull();
              else expect(pgRow).toMatchObject({ type: "RUN", status: "PENDING" });
              const dbChild = await prisma.taskRun.findFirst({
                where: { id: child.id },
                include: { associatedWaitpoint: true },
              });
              if (enabled) expect(dbChild?.associatedWaitpoint).toBeNull();
              else expect(dbChild?.associatedWaitpoint?.id).toBe(pgRow?.id);
              expect(dbChild ? hasStoreWaitpoints(dbChild.annotations) : undefined).toBe(enabled);
              // The parent is blocked on the store waitpoint.
              await vi.waitFor(
                async () => {
                  const ed = await engine.getRunExecutionData({ runId: parent.id });
                  expect(
                    ed?.snapshot.executionStatus,
                    "run never reached the expected execution status"
                  ).toBe("EXECUTING_WITH_WAITPOINTS");
                },
                { timeout: 10_000, interval: 100 }
              );

              // Drive the child to success. The success path resolves the store id by anchor and completes it.
              const childAttempt = await dequeueAndStart(engine, "c_child");
              await engine.completeRunAttempt({
                runId: child.id,
                snapshotId: childAttempt.snapshot.id,
                completion: {
                  id: child.id,
                  ok: true,
                  output: '{"result":"ok"}',
                  outputType: "application/json",
                },
              });

              const desc = await store.describeWaitpoint(derivedId);
              if (enabled) {
                expect(desc.outcome).toBe("exists");
                expect(desc.outcome === "exists" ? desc.status : undefined).toBe("COMPLETED");
              } else expect(desc.outcome).toBe("missing");

              // The durable fanout worker resumes the parent without a foreground delivery or repair call.
              await vi.waitFor(
                async () => {
                  const ed = await engine.getRunExecutionData({ runId: parent.id });
                  expect(
                    ed?.snapshot.executionStatus,
                    "run never reached the expected execution status"
                  ).toBe("EXECUTING");
                  expect(ed?.completedWaitpoints).toContainEqual(
                    expect.objectContaining({
                      id: enabled ? derivedId : pgRow!.id,
                      output: '{"result":"ok"}',
                      outputType: "application/json",
                      outputIsError: false,
                    })
                  );
                },
                { timeout: 10_000, interval: 100 }
              );

              // Still no Postgres Waitpoint row for the child after the whole cycle.
              expect(
                await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })
              ).toBe(enabled ? 0 : 1);
              expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: parent.id } })).toBe(
                0
              );
              expect((await store.readBlockState(parent.id)).pendingIds).toEqual([]);
            } finally {
              await engine.quit();
              await store.quit();

              await snapshotStore.quit();
            }
          }
        );
      }
    }

    containerTest(
      "a terminal child failure completes the store RUN waitpoint and resumes the parent",
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
          await dequeueAndStart(engine, "c_parent_f");

          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          });
          const derivedId = deriveWaitpointIdFromAnchor(child.id, "RUN")!;
          await vi.waitFor(
            async () => {
              const ed = await engine.getRunExecutionData({ runId: parent.id });
              expect(
                ed?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING_WITH_WAITPOINTS");
            },
            { timeout: 10_000, interval: 100 }
          );

          // Fail the child terminally (no retry). The failure completion site resolves the store id and
          // completes it with the error envelope.
          const childAttempt = await dequeueAndStart(engine, "c_child_f");
          await engine.completeRunAttempt({
            runId: child.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: child.id,
              ok: false,
              error: { type: "INTERNAL_ERROR", code: "TASK_RUN_CRASHED", message: "boom" },
            },
          });

          const desc = await store.describeWaitpoint(derivedId);
          expect(desc.outcome === "exists" ? desc.status : undefined).toBe("COMPLETED");

          const blockId = (await store.readBlockState(parent.id)).blockId!;
          await store.deliverCompletion({
            runId: parent.id,
            blockId,
            waitpointId: derivedId,
            completion: {
              completedAt: new Date().toISOString(),
              outputType: "application/json",
              outputIsError: true,
              output: { inline: "{}" },
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
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })).toBe(
            0
          );
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );
  });
});
