import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { RedisSnapshotStore } from "@internal/run-store";
import { deriveWaitpointIdFromAnchor, generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient } from "@internal/redis";
import { waitpointStoreBarrier } from "./utils/waitpointStoreBarrier.js";
import { describe, expect, vi } from "vitest";
import { StoreWaitpointBlockCycleAdvanced } from "../errors.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { waitpointKeys } from "../waitpointCoordinator/keys.js";
import { workerCatalog } from "../workerCatalog.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("storeWaitpointLazyAssociation", () => {
  describe("Store RUN lazy association (getOrCreateRunWaitpoint)", () => {
    containerTest(
      "debounce rejects a stale block operation after recovery resumes the parent",
      async ({ prisma, redisOptions }) => {
        const barrier = await waitpointStoreBarrier(redisOptions);
        const snapshotStore = new RedisSnapshotStore({
          redisOptions: barrier.redisOptions,
          completedTtlMs: 60_000,
        });
        const cancellationSnapshots = new RedisSnapshotStore({
          redisOptions,
          completedTtlMs: 60_000,
        });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          workerDisabled: true,
          recoveryDelayMs: 60_000,
        });
        const cancellationEngine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore: cancellationSnapshots,
          recoveryDelayMs: 60_000,
        });
        const raw = createRedisClient(redisOptions);
        const events: string[] = [];
        for (const owner of [engine, cancellationEngine])
          owner.eventBus.on("cachedRunCompleted", ({ span }) => events.push(span.id));
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
          for (const recoveryFirst of [false, true]) {
            const parent = await triggerRun(engine, env, prisma, {
              friendlyId: `run_${generateRunOpsId()}`,
              taskIdentifier: "parent-task",
            });
            await dequeueAndStart(engine, "debounce-gap-parent");
            const debounce = { key: generateRunOpsId(), delay: "1h", mode: "leading" as const };
            const child = await triggerRun(engine, env, prisma, {
              friendlyId: `run_${generateRunOpsId()}`,
              taskIdentifier: "child-task",
              debounce,
              delayUntil: new Date(Date.now() + 3_600_000),
            });
            const spanId = `cached-${generateRunOpsId()}`;
            let waitpointId!: string;
            let callbackEntered = false;
            const foreground = triggerRun(engine, env, prisma, {
              friendlyId: `run_${generateRunOpsId()}`,
              taskIdentifier: "child-task",
              debounce,
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              onDebounced: async ({ waitpoint, blockRun }) => {
                waitpointId = waitpoint.id;
                if (recoveryFirst) {
                  const queued = await engine["worker"].getJob(`recoverRunWaitpoint:${child.id}`);
                  const payload = workerCatalog.recoverRunWaitpoint.schema.parse(queued!.item);
                  // Establish an accepted registration before recovery competes with the later
                  // foreground callback; source-publication intent alone cannot add this edge.
                  await cancellationEngine.blockRunWithWaitpoint({
                    runId: parent.id,
                    waitpoints: waitpointId,
                    projectId: env.project.id,
                    organizationId: env.organization.id,
                    blockOperation: payload.blockOperation,
                  });
                  expect((await store.readBlockState(parent.id)).pendingIds).toEqual([waitpointId]);
                  await engine["worker"]["jobs"].recoverRunWaitpoint({ payload });
                }
                barrier.pause(
                  (args) => args[2] === "4" && args.length === 7 && args[3]!.includes(parent.id),
                  "reply"
                );
                callbackEntered = true;
                if (blockRun) await blockRun(spanId);
                return spanId;
              },
            }).then(
              () => undefined,
              (error: unknown) => error
            );
            await expect
              .poll(() => callbackEntered && barrier.held, {
                timeout: 5000,
                interval: 10,
                message:
                  "debounced parent snapshot read never reached its real Redis reply boundary",
              })
              .toBe(true);
            await cancellationEngine.cancelRun({ runId: child.id });
            let resumedSnapshotId: string | undefined;
            if (recoveryFirst) {
              await vi.waitFor(
                async () => {
                  const resumed = await cancellationEngine.getRunExecutionData({
                    runId: parent.id,
                  });
                  expect(
                    resumed?.snapshot.executionStatus,
                    "run never reached the expected execution status"
                  ).toBe("EXECUTING");
                  expect(resumed?.completedWaitpoints).toContainEqual(
                    expect.objectContaining({ id: waitpointId, outputIsError: true })
                  );
                  expect(await raw.hlen(waitpointKeys(waitpointId).watchers)).toBe(0);
                  resumedSnapshotId = resumed?.snapshot.id;
                },
                { timeout: 10_000, interval: 20 }
              );
            }
            barrier.release();
            const error = await foreground;
            if (recoveryFirst) {
              expect(error).toBeInstanceOf(StoreWaitpointBlockCycleAdvanced);
              expect(events).not.toContain(spanId);
              expect((await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.id).toBe(
                resumedSnapshotId
              );
            } else {
              expect(error).toBeUndefined();
              expect(events.filter((id) => id === spanId)).toHaveLength(1);
            }
          }
        } finally {
          barrier.release();
          await raw.quit();
          await engine.quit();
          await cancellationEngine.quit();
          await cancellationSnapshots.quit();
          await store.quit();
          await snapshotStore.quit();
          await barrier.close();
        }
      }
    );

    for (const enabled of [false, true]) {
      containerTest(
        `debounce callback ${enabled ? "awaits native registration" : "preserves disabled legacy ordering"}`,
        async ({ prisma, redisOptions }) => {
          const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
          const store = new WaitpointStoreCoordinator({ redisOptions });
          const engine = makeEngine(prisma, redisOptions, { store, snapshotStore, enabled });
          const events: string[] = [];
          engine.eventBus.on("cachedRunCompleted", ({ span }) => {
            events.push(span.id);
          });
          try {
            const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
            await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
            const parent = await triggerRun(engine, env, prisma, {
              friendlyId: `run_${generateRunOpsId()}`,
              taskIdentifier: "parent-task",
            });
            await dequeueAndStart(engine, "debounce-publication-parent");
            const debounce = { key: generateRunOpsId(), delay: "1h", mode: "leading" as const };
            const child = await triggerRun(engine, env, prisma, {
              friendlyId: `run_${generateRunOpsId()}`,
              taskIdentifier: "child-task",
              debounce,
              delayUntil: new Date(Date.now() + 3_600_000),
            });
            const spanId = `cached-${generateRunOpsId()}`;
            await triggerRun(engine, env, prisma, {
              friendlyId: `run_${generateRunOpsId()}`,
              taskIdentifier: "child-task",
              debounce,
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              onDebounced: async ({ blockRun }) => {
                expect(!!blockRun).toBe(enabled);
                if (blockRun) await blockRun(spanId);
                const parentState = await engine.getRunExecutionData({ runId: parent.id });
                expect(parentState?.snapshot.executionStatus).toBe(
                  enabled ? "EXECUTING_WITH_WAITPOINTS" : "EXECUTING"
                );
                return spanId;
              },
            });
            expect(
              (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
            ).toBe("EXECUTING_WITH_WAITPOINTS");
            await engine.cancelRun({ runId: child.id });
            await vi.waitFor(
              () => {
                expect(
                  events.filter((id) => id === spanId),
                  "waitpoint condition never settled: events.filter((id) => id === spanId)"
                ).toHaveLength(1);
              },
              { timeout: 10_000, interval: 20 }
            );
          } finally {
            await engine.quit();
            await store.quit();
            await snapshotStore.quit();
          }
        }
      );
    }

    for (const completeBeforeForeground of [false, true]) {
      containerTest(
        `lazy recovery preserves the foreground cached span when the child completes ${completeBeforeForeground ? "before" : "after"} foreground registration`,
        async ({ prisma, redisOptions }) => {
          const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
          const store = new WaitpointStoreCoordinator({ redisOptions });
          const engine = makeEngine(prisma, redisOptions, {
            store,
            snapshotStore,
            recoveryDelayMs: 60_000,
          });
          const raw = createRedisClient(redisOptions);
          const events: Array<{ span: { id: string }; blockedRunId: string }> = [];
          engine.eventBus.on("cachedRunCompleted", (event) => {
            events.push(event);
          });
          try {
            const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
            await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
            const parent = await triggerRun(engine, env, prisma, {
              friendlyId: `run_${generateRunOpsId()}`,
              taskIdentifier: "parent-task",
            });
            await dequeueAndStart(engine, "lazy-span-parent");
            const child = await triggerRun(engine, env, prisma, {
              friendlyId: `run_${generateRunOpsId()}`,
              taskIdentifier: "child-task",
            });
            const association = await engine.getOrCreateRunWaitpoint({
              runId: child.id,
              projectId: env.project.id,
              environmentId: env.id,
              organizationId: env.organization.id,
              blockingParentRunId: parent.id,
            });
            const captured = await engine["worker"].getJob(`recoverRunWaitpoint:${child.id}`);
            const payload = workerCatalog.recoverRunWaitpoint.schema.parse(captured!.item);
            // Recover an accepted edge whose foreground span has not yet been attached.
            await engine.blockRunWithWaitpoint({
              runId: parent.id,
              waitpoints: association.id,
              projectId: env.project.id,
              organizationId: env.organization.id,
              blockOperation: payload.blockOperation,
            });
            await engine["worker"]["jobs"].recoverRunWaitpoint({ payload });
            const watchers = () => raw.hgetall(waitpointKeys(association.id).watchers);
            expect(Object.values(await watchers()).map((value) => JSON.parse(value))).toEqual([
              expect.not.objectContaining({ spanIdToComplete: expect.any(String) }),
            ]);
            const completeChild = async () => {
              const attempt = await dequeueAndStart(engine, "lazy-span-child");
              expect(attempt.run.id).toBe(child.id);
              await engine.completeRunAttempt({
                runId: child.id,
                snapshotId: attempt.snapshot.id,
                completion: {
                  id: child.id,
                  ok: true,
                  output: "42",
                  outputType: "application/json",
                },
              });
            };
            const expectResumed = async () => {
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
                      output: "42",
                      outputIsError: false,
                    })
                  );
                  expect(await raw.hlen(waitpointKeys(association.id).watchers)).toBe(0);
                },
                { timeout: 10_000, interval: 20 }
              );
            };
            if (completeBeforeForeground) {
              await completeChild();
              await expectResumed();
              expect(events).toHaveLength(0);
            }
            // Idempotency/debounce create their trace span before capturing the CURRENT operation.
            // A recovery that already resumed the parent must not make the caller reuse its old cycle.
            const spanId = `cached-${generateRunOpsId()}`;
            const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
              runId: parent.id,
              waitpointId: association.id,
              organizationId: env.organization.id,
            });
            expect(blockOperation?.cycleAnchor === payload.blockOperation.cycleAnchor).toBe(
              !completeBeforeForeground
            );
            await engine.blockRunWithWaitpoint({
              runId: parent.id,
              waitpoints: association.id,
              projectId: env.project.id,
              organizationId: env.organization.id,
              spanIdToComplete: spanId,
              blockOperation,
            });
            if (!completeBeforeForeground) {
              expect(Object.values(await watchers()).map((value) => JSON.parse(value))).toEqual([
                expect.objectContaining({ spanIdToComplete: spanId }),
              ]);
              await completeChild();
            }
            await expectResumed();
            expect(events).toEqual([
              expect.objectContaining({
                span: expect.objectContaining({ id: spanId }),
                blockedRunId: parent.id,
                cachedRunId: child.id,
                hasError: false,
              }),
            ]);
          } finally {
            await raw.quit();
            await engine.quit();
            await store.quit();
            await snapshotStore.quit();
          }
        }
      );
    }

    containerTest(
      "lazily mints a store RUN waitpoint by the blocking parent, and reuses it (no second mint)",
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
          await dequeueAndStart(engine, "c_parent_l");

          // A standalone child (no waiting parent) → no waitpoint yet.
          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
          });
          const derivedId = deriveWaitpointIdFromAnchor(child.id, "RUN")!;
          expect(await store.probeWaitpointPresence(derivedId)).toBe("absent");

          // A late waiter lazily creates the child's waitpoint; the blocking parent is redis-primary → store.
          const first = await engine.getOrCreateRunWaitpoint({
            runId: child.id,
            projectId: env.project.id,
            environmentId: env.id,
            blockingParentRunId: parent.id,
            organizationId: orgId,
          });
          expect(first.id).toBe(derivedId);
          expect(await store.probeWaitpointPresence(derivedId)).toBe("present");
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })).toBe(
            0
          );

          // A second late waiter reuses the SAME waitpoint — no competing/duplicate mint.
          const second = await engine.getOrCreateRunWaitpoint({
            runId: child.id,
            projectId: env.project.id,
            environmentId: env.id,
            blockingParentRunId: parent.id,
            organizationId: orgId,
          });
          expect(second.id).toBe(derivedId);
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

    containerTest(
      "an already-completed child yields a completed store waitpoint so a late parent never hangs",
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
          await dequeueAndStart(engine, "c_parent_c");

          // A standalone child, driven to success BEFORE any waitpoint exists.
          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
          });
          const childAttempt = await dequeueAndStart(engine, "c_child_c");
          await engine.completeRunAttempt({
            runId: child.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: child.id,
              ok: true,
              output: '{"done":true}',
              outputType: "application/json",
            },
          });

          // The late waiter's lazy create observes the terminal run and completes the store waitpoint.
          const waitpoint = await engine.getOrCreateRunWaitpoint({
            runId: child.id,
            projectId: env.project.id,
            environmentId: env.id,
            blockingParentRunId: parent.id,
            organizationId: orgId,
          });
          expect(waitpoint.id).toBe(deriveWaitpointIdFromAnchor(child.id, "RUN"));
          const desc = await store.describeWaitpoint(waitpoint.id);
          expect(desc.outcome === "exists" ? desc.status : undefined).toBe("COMPLETED");
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

  containerTest(
    "late registration of a failed-at-creation child completes its store association without a snapshot",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const options = { store, snapshotStore, enabled: true };
      const engine = makeEngine(prisma, redisOptions, options);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "late-failure-parent");
        const failed = await engine.createFailedTaskRun({
          friendlyId: `run_${generateRunOpsId()}`,
          environment: env,
          taskIdentifier: "child-task",
          error: { type: "STRING_ERROR", raw: "failed before waiting" },
        });
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: failed.id } })).toBe(
          0
        );
        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: failed.id,
          projectId: env.project.id,
          environmentId: env.id,
          organizationId: env.organization.id,
          blockingParentRunId: parent.id,
        });
        expect(waitpoint.id).toBe(deriveWaitpointIdFromAnchor(failed.id, "RUN"));
        expect(waitpoint.status).toBe("COMPLETED");
        expect(waitpoint.outputIsError).toBe(true);
        const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
          runId: parent.id,
          waitpointId: waitpoint.id,
          organizationId: env.organization.id,
        });
        await engine.blockRunWithWaitpoint({
          runId: parent.id,
          waitpoints: waitpoint.id,
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
            expect(data?.completedWaitpoints).toContainEqual(
              expect.objectContaining({
                id: waitpoint.id,
                outputIsError: true,
                output: expect.stringContaining("failed before waiting"),
              })
            );
          },
          { timeout: 10_000 }
        );
        expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: failed.id } })).toBe(
          0
        );
        options.enabled = false;
        const disabledFailure = await engine.createFailedTaskRun({
          friendlyId: `run_${generateRunOpsId()}`,
          environment: env,
          taskIdentifier: "child-task",
          error: { type: "STRING_ERROR", raw: "disabled unchanged" },
        });
        // The existing off path still requires a snapshot; this change adds no legacy lazy mutation.
        await expect(
          engine.getOrCreateRunWaitpoint({
            runId: disabledFailure.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
            blockingParentRunId: parent.id,
          })
        ).rejects.toThrow();
        expect(
          await prisma.waitpoint.count({ where: { completedByTaskRunId: disabledFailure.id } })
        ).toBe(0);
      } finally {
        await engine.quit();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );
});
