import { deriveRunWaitpointId } from "../waitpointCoordinator/runWaitpointId.js";
import { keyedWaitpointTest as containerTest } from "./utils/keyedWaitpointTest.js";
import { hasStoreWaitpoints, RedisSnapshotStore } from "@internal/run-store";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  RunId,
  generateWaitpointId,
  parseWaitpointId,
  WaitpointId,
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

  describe("Store DATETIME waitpoint lifecycle (real RunEngine + MemoryDB)", () => {
    containerTest(
      "disabled creation and scheduled legacy completion preserve payloads with unavailable native store",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        await store.quit();
        const engine = makeEngine(prisma, redisOptions, { store, snapshotStore, enabled: false });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const timeout = new Date(Date.now() + 1000);
          const manual = await engine.createManualWaitpoint({
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
            timeout,
          });
          const manualJob = await engine["worker"].getJob(`finishWaitpoint.${manual.waitpoint.id}`);
          expect(manualJob!.item).toEqual({
            waitpointId: manual.waitpoint.id,
            error: expect.any(String),
          });
          const dateTime = await engine.createDateTimeWaitpoint({
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
            completedAfter: timeout,
          });
          const dateJob = await engine["worker"].getJob(`finishWaitpoint.${dateTime.waitpoint.id}`);
          expect(dateJob!.item).toEqual({ waitpointId: dateTime.waitpoint.id });
          // Present org context on an old finish job must also remain on the legacy path.
          await engine["worker"].enqueue({
            id: `finish-off-org:${dateTime.waitpoint.id}`,
            job: "finishWaitpoint",
            payload: { waitpointId: dateTime.waitpoint.id, organizationId: env.organization.id },
          });
          await expect
            .poll(
              async () =>
                prisma.waitpoint.findMany({
                  where: { id: { in: [manual.waitpoint.id, dateTime.waitpoint.id] } },
                  orderBy: { type: "asc" },
                  select: { type: true, status: true, outputIsError: true },
                }),
              {
                timeout: 5000,
                interval: 20,
                message: "disabled legacy timeout jobs never completed",
              }
            )
            .toEqual([
              { type: "DATETIME", status: "COMPLETED", outputIsError: false },
              { type: "MANUAL", status: "COMPLETED", outputIsError: true },
            ]);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    for (const dial of ["off", "dual-write", "redis-only"] as const) {
      for (const enabled of [false, true]) {
        containerTest(
          `DATETIME rollout is independent: TRES=${dial}, waitpoints=${enabled}`,
          async ({ prisma, redisOptions }) => {
            await prisma.$executeRawUnsafe(
              `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
            );
            const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
            const store = new WaitpointStoreCoordinator({ redisOptions });
            let enabledOrganization: string | undefined;
            const engine = makeEngine(prisma, redisOptions, {
              store,
              snapshotStore,
              resolveDial: () => dial,
              isWaitpointStoreEnabled: (organizationId) => organizationId === enabledOrganization,
            });
            try {
              const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
              const orgId = env.organization.id;
              await setupBackgroundWorker(engine, env, ["waiter-task"]);

              const run = await triggerRun(engine, env, prisma, {
                friendlyId:
                  dial === "off" ? RunId.generate().friendlyId : `run_${generateRunOpsId()}`,
                taskIdentifier: "waiter-task",
              });
              await dequeueAndStart(engine, "c_waiter");

              enabledOrganization = enabled ? orgId : undefined;
              if (enabled && dial === "off") {
                const controlOrganization = await prisma.organization.create({
                  data: { title: "Control", slug: "control-datetime" },
                });
                const controlProject = await prisma.project.create({
                  data: {
                    name: "Control",
                    slug: "control",
                    externalRef: "control-datetime",
                    organizationId: controlOrganization.id,
                    defaultWorkerGroupId: env.project.defaultWorkerGroupId,
                  },
                });
                const controlEnvironment = await prisma.runtimeEnvironment.create({
                  data: {
                    type: "PRODUCTION",
                    slug: "control",
                    projectId: controlProject.id,
                    organizationId: controlOrganization.id,
                    apiKey: "control-key",
                    pkApiKey: "control-pk",
                    shortcode: "control-datetime",
                  },
                  include: { project: true, organization: true, orgMember: true },
                });
                const controlRun = await triggerRun(engine, controlEnvironment, prisma, {
                  friendlyId: RunId.generate().friendlyId,
                  taskIdentifier: "waiter-task",
                });
                const control = await engine.createDateTimeWaitpoint({
                  runId: controlRun.id,
                  projectId: controlProject.id,
                  environmentId: controlEnvironment.id,
                  organizationId: controlOrganization.id,
                  completedAfter: new Date(Date.now() + 60_000),
                  idempotencyKey: "control-datetime",
                });
                expect(parseWaitpointId(control.waitpoint.id).format).toBe("legacy");
                expect(await prisma.waitpoint.count({ where: { id: control.waitpoint.id } })).toBe(
                  1
                );
                expect(await store.probeWaitpointPresence(control.waitpoint.id)).toBe("absent");
              }
              // Keep the scheduling window short while the block is installed.
              const completedAfter = new Date(Date.now() + 1000);
              const { waitpoint, isCached } = await engine.createDateTimeWaitpoint({
                runId: run.id,
                projectId: env.project.id,
                environmentId: env.id,
                organizationId: orgId,
                completedAfter,
                idempotencyKey: "independent-datetime",
              });

              expect(isCached).toBe(false);
              expect(parseWaitpointId(waitpoint.id).format).toBe(enabled ? "b32hexW" : "legacy");
              expect(await store.probeWaitpointPresence(waitpoint.id)).toBe(
                enabled ? "present" : "absent"
              );
              expect(await prisma.waitpoint.count({ where: { id: waitpoint.id } })).toBe(
                enabled ? 0 : 1
              );

              const blockOperation = enabled
                ? await engine.waitpointSystem.buildStoreBlockOperation({
                    runId: run.id,
                    waitpointId: waitpoint.id,
                    organizationId: orgId,
                  })
                : undefined;
              await engine.blockRunWithWaitpoint({
                runId: run.id,
                waitpoints: waitpoint.id,
                projectId: env.project.id,
                organizationId: orgId,

                blockOperation,
              });

              const blocked = await engine.getRunExecutionData({ runId: run.id });
              expect(blocked?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

              // The real scheduled completion and fanout must resume this run.
              await vi.waitFor(
                async () => {
                  const ed = await engine.getRunExecutionData({ runId: run.id });
                  expect(
                    ed?.snapshot.executionStatus,
                    "run never reached the expected execution status"
                  ).toBe("EXECUTING");
                  expect(ed?.completedWaitpoints).toContainEqual(
                    expect.objectContaining({
                      id: waitpoint.id,
                      type: "DATETIME",
                      outputIsError: false,
                    })
                  );
                },
                { timeout: 10_000, interval: 100 }
              );
              const replay = await engine.createDateTimeWaitpoint({
                runId: run.id,
                projectId: env.project.id,
                environmentId: env.id,
                organizationId: orgId,
                completedAfter: new Date(Date.now() + 60_000),
                idempotencyKey: "independent-datetime",
              });
              expect(replay.isCached).toBe(true);
              expect(replay.waitpoint.id).toBe(waitpoint.id);
              expect(replay.waitpoint.completedAfter).toEqual(completedAfter);
              expect((await store.readBlockState(run.id)).pendingIds).toEqual([]);
              expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
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
      "keyed DATETIME preserves cached identities, deadlines and expiry in its owning store",
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          resolveDial: () => "off",
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          const orgId = env.organization.id;
          await setupBackgroundWorker(engine, env, ["waiter-task"]);
          const run = await triggerRun(engine, env, prisma, {
            friendlyId: RunId.generate().friendlyId,
            taskIdentifier: "waiter-task",
          });
          await dequeueAndStart(engine, "c_waiter_idem");

          const base = {
            runId: run.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: orgId,
            completedAfter: new Date(Date.now() + 60_000),
          };

          // A changed request deadline cannot replace the first winner's deadline.
          const first = await engine.createDateTimeWaitpoint({ ...base, idempotencyKey: "dt-1" });
          const second = await engine.createDateTimeWaitpoint({
            ...base,
            completedAfter: new Date(0),
            idempotencyKey: "dt-1",
          });
          expect(second.isCached).toBe(true);
          expect(second.waitpoint.id).toBe(first.waitpoint.id);
          expect(second.waitpoint.completedAfter).toEqual(base.completedAfter);
          expect(parseWaitpointId(first.waitpoint.id).format).toBe("b32hexW");
          expect(await prisma.waitpoint.count({ where: { id: first.waitpoint.id } })).toBe(0);
          expect(await store.probeWaitpointPresence(first.waitpoint.id)).toBe("present");
          const tokenReuse = await engine.waitpointSystem.createManualWaitpoint({
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: orgId,
            idempotencyKey: "dt-1",
          });
          expect(tokenReuse).toMatchObject({
            isCached: true,
            waitpoint: { id: first.waitpoint.id, type: "DATETIME" },
          });
          const old = await prisma.waitpoint.create({
            data: {
              ...WaitpointId.generate(),
              type: "DATETIME",
              environmentId: env.id,
              projectId: env.project.id,
              idempotencyKey: "old-pg",
              userProvidedIdempotencyKey: true,
              completedAfter: base.completedAfter,
            },
          });
          expect(
            (await engine.createDateTimeWaitpoint({ ...base, idempotencyKey: "old-pg" })).waitpoint
              .id
          ).toBe(old.id);

          const expiredPg = await prisma.waitpoint.create({
            data: {
              ...WaitpointId.generate(),
              type: "DATETIME",
              environmentId: env.id,
              projectId: env.project.id,
              idempotencyKey: "expired-pg",
              userProvidedIdempotencyKey: true,
              idempotencyKeyExpiresAt: new Date(Date.now() - 1000),
              completedAfter: base.completedAfter,
            },
          });
          const migrated = await engine.createDateTimeWaitpoint({
            ...base,
            idempotencyKey: "expired-pg",
          });
          expect(parseWaitpointId(migrated.waitpoint.id).format).toBe("b32hexW");
          const retired = await prisma.waitpoint.findUniqueOrThrow({ where: { id: expiredPg.id } });
          expect(retired.inactiveIdempotencyKey).toBe("expired-pg");
          expect(retired.idempotencyKey).not.toBe("expired-pg");
          expect(retired.completedAfter).toEqual(expiredPg.completedAfter);

          // Strict expiry still mints a fresh waitpoint once the key has expired.
          const expired = await engine.createDateTimeWaitpoint({
            ...base,
            idempotencyKey: "dt-exp",
            idempotencyKeyExpiresAt: new Date(Date.now() - 1000),
          });
          const afterExpiry = await engine.createDateTimeWaitpoint({
            ...base,
            idempotencyKey: "dt-exp",
          });
          expect(afterExpiry.waitpoint.id).not.toBe(expired.waitpoint.id);
          expect(afterExpiry.isCached).toBe(false);
        } finally {
          await engine.quit();
          await store.quit();

          await snapshotStore.quit();
        }
      }
    );
  });
});
