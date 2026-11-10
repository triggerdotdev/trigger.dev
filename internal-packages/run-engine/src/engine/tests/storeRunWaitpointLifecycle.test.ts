import { PrismaClient } from "@trigger.dev/database";
import { deriveRunWaitpointId } from "../waitpointCoordinator/runWaitpointId.js";
import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { hasStoreWaitpoints, RedisSnapshotStore } from "@internal/run-store";
import { createRedisClient } from "@internal/redis";
import { generateRunOpsId, RunId } from "@trigger.dev/core/v3/isomorphic";

import { waitpointStoreBarrier } from "./utils/waitpointStoreBarrier.js";
import { describe, expect, vi } from "vitest";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("storeRunWaitpointLifecycle", () => {
  containerTest(
    "legacy completion avoids redundant flag SQL with and without store wiring",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const flagPrisma = new PrismaClient({
        datasources: { db: { url: postgresContainer.getConnectionUri() } },
        log: [{ emit: "event", level: "query" }],
      });
      let flagQueries = 0;
      flagPrisma.$on("query", () => flagQueries++);
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        for (const wired of [false, true]) {
          const engine = makeEngine(prisma, redisOptions, {
            store: wired ? store : undefined,
            snapshotStore,
            resolveDial: () => "off",
            // A real indexed org override lookup; the separate client records only flag SQL.
            isWaitpointStoreEnabled: async (organizationId, loadedFlags) => {
              const flags =
                loadedFlags ??
                (
                  await flagPrisma.organization.findFirst({
                    where: { id: organizationId },
                    select: { featureFlags: true },
                  })
                )?.featureFlags;
              return (
                typeof flags === "object" &&
                flags !== null &&
                "waitpointStoreEnabled" in flags &&
                flags.waitpointStoreEnabled === true
              );
            },
          });
          try {
            await setupBackgroundWorker(engine, env, ["child-task"]);
            for (const outcome of ["success", "cancel"] as const) {
              for (const associated of [false, true]) {
                const child = await triggerRun(engine, env, prisma, {
                  friendlyId: RunId.generate().friendlyId,
                  taskIdentifier: "child-task",
                });
                const attempt =
                  outcome === "success"
                    ? await dequeueAndStart(engine, `flag_sql_${wired}_${associated}_${outcome}`)
                    : undefined;
                const beforeAssociation = flagQueries;
                const waitpoint = associated
                  ? await engine.waitpointSystem.getOrCreateRunWaitpoint({
                      runId: child.id,
                      projectId: env.project.id,
                      environmentId: env.id,
                      organizationId: env.organization.id,
                    })
                  : undefined;
                expect(flagQueries - beforeAssociation).toBe(wired && associated ? 1 : 0);
                const before = flagQueries;
                if (outcome === "success") {
                  await engine.completeRunAttempt({
                    runId: child.id,
                    snapshotId: attempt!.snapshot.id,
                    completion: { id: child.id, ok: true, output: "", outputType: "text/plain" },
                  });
                } else {
                  await engine.cancelRun({ runId: child.id, organizationId: env.organization.id });
                }
                const count = flagQueries - before;
                console.log(
                  `legacy flag SQL wired=${wired} associated=${associated} outcome=${outcome}: ${count}`
                );
                expect(count).toBe(
                  wired ? (outcome === "success" ? 3 : 2) + Number(associated) : 1
                );
                if (waitpoint) {
                  const completed = await prisma.waitpoint.findUniqueOrThrow({
                    where: { id: waitpoint.id },
                  });
                  expect(completed.status).toBe("COMPLETED");
                  if (outcome === "success") expect(completed.output).toBeNull();
                  else
                    expect(JSON.parse(completed.output!)).toMatchObject({ type: "STRING_ERROR" });
                } else {
                  expect(
                    await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })
                  ).toBe(0);
                  expect(
                    (await prisma.taskRun.findUniqueOrThrow({ where: { id: child.id } })).status
                  ).toBe(outcome === "success" ? "COMPLETED_SUCCESSFULLY" : "CANCELED");
                }
              }
            }
          } finally {
            await engine.quit();
          }
        }
      } finally {
        await flagPrisma.$disconnect();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );
  containerTest(
    "rejected native children retire only their own recovery, preserving committed same-ID recovery",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        recoveryDelayMs: 60_000,
        resolveDial: () => "off",
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        for (const field of ["idempotencyKey", "oneTimeUseToken"] as const) {
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: RunId.generate().friendlyId,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, `rejected_${field}`);
          const collision = { [field]: `collision_${crypto.randomUUID()}` };
          const winner = await triggerRun(engine, env, prisma, {
            friendlyId: RunId.generate().friendlyId,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
            delayUntil: new Date(Date.now() + 60_000),
            ...collision,
          });
          const loser = RunId.generate();
          await expect(
            triggerRun(engine, env, prisma, {
              friendlyId: loser.friendlyId,
              taskIdentifier: "child-task",
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              ...collision,
            })
          ).rejects.toMatchObject({
            name:
              field === "idempotencyKey"
                ? "RunDuplicateIdempotencyKeyError"
                : "RunOneTimeUseTokenError",
          });
          expect(await prisma.taskRun.findUnique({ where: { id: loser.id } })).toBeNull();
          expect(await engine["worker"].getJob(`recoverRunWaitpoint:${loser.id}`)).toBeNull();
          expect(await prisma.taskRun.findUnique({ where: { id: winner.id } })).not.toBeNull();
          expect((await store.describeWaitpoint(deriveRunWaitpointId(winner.id)!)).outcome).toBe(
            "exists"
          );

          const invalid = RunId.generate();
          await expect(
            engine.createFailedTaskRun({
              friendlyId: invalid.friendlyId,
              environment: env,
              taskIdentifier: null as unknown as string,
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              error: { type: "STRING_ERROR", raw: "rejected invalid prefailed child" },
            })
          ).rejects.toMatchObject({ name: "PrismaClientValidationError" });
          expect(await engine["worker"].getJob(`recoverRunWaitpoint:${invalid.id}`)).toBeNull();

          // A same-ID retry may share a job with the original committed child. Never retire it.
          await engine.waitpointSystem.armRunWaitpointRecovery({
            runId: winner.id,
            parentRunId: parent.id,
            organizationId: env.organization.id,
            waitpointId: deriveRunWaitpointId(winner.id)!,
            blockOperation: (await engine.waitpointSystem.buildStoreBlockOperation({
              runId: parent.id,
              waitpointId: deriveRunWaitpointId(winner.id)!,
              organizationId: env.organization.id,
            }))!,
          });
          await expect(
            triggerRun(engine, env, prisma, {
              friendlyId: winner.friendlyId,
              taskIdentifier: "child-task",
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              ...collision,
            })
          ).rejects.toThrow();
          expect(await engine["worker"].getJob(`recoverRunWaitpoint:${winner.id}`)).not.toBeNull();
          await expect(
            engine.createFailedTaskRun({
              friendlyId: winner.friendlyId,
              environment: env,
              taskIdentifier: "child-task",
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              error: { type: "STRING_ERROR", raw: "rejected prefailed duplicate" },
            })
          ).rejects.toMatchObject({ code: "P2002" });
          expect(await engine["worker"].getJob(`recoverRunWaitpoint:${winner.id}`)).not.toBeNull();
        }
      } finally {
        await engine.quit();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );
  containerTest(
    "eager RUN publication replays cancellation committed before its source exists",
    async ({ prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
      );
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const barrier = await waitpointStoreBarrier(redisOptions);
      const producerStore = new WaitpointStoreCoordinator({ redisOptions: barrier.redisOptions });
      const engine = makeEngine(prisma, redisOptions, {
        store: producerStore,
        snapshotStore,
        workerDisabled: true,
        resolveDial: () => "off",
      });
      const cancellationEngine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        resolveDial: () => "off",
      });
      let original: ReturnType<typeof triggerRun> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "cancel_before_source_parent");
        const friendlyId = RunId.generate().friendlyId;
        const childId = RunId.fromFriendlyId(friendlyId);
        const waitpointId = deriveRunWaitpointId(childId)!;
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
            message: "RUN source write never reached Redis request boundary",
          })
          .toBe(true);
        expect(await store.probeWaitpointPresence(waitpointId)).toBe("absent");

        await cancellationEngine.cancelRun({
          runId: childId,
          organizationId: env.organization.id,
          reason: "cancelled before source publication",
        });
        expect(
          (await engine.getRunExecutionData({ runId: childId }))?.snapshot.executionStatus
        ).toBe("FINISHED");
        expect(await engine["worker"].queue.getJob(`ensureRunFinalized:${childId}`)).toBeNull();
        barrier.release();
        await original;

        const source = (await store.readCompletedRecords([waitpointId])).get(waitpointId)!;
        const output = JSON.stringify({
          raw: "cancelled before source publication",
          type: "STRING_ERROR",
        });
        expect(source.status).toBe("COMPLETED");
        expect(source.completion).toMatchObject({
          output: { inline: output },
          outputIsError: true,
        });
        await vi.waitFor(
          async () => {
            const resumed = await engine.getRunExecutionData({ runId: parent.id });
            expect(
              resumed?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("EXECUTING");
            expect(resumed?.completedWaitpoints).toContainEqual(
              expect.objectContaining({ id: waitpointId, output, outputIsError: true })
            );
          },
          { timeout: 10_000, interval: 20 }
        );
        expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: childId } })).toBe(0);
        expect((await store.readBlockState(parent.id)).pendingIds).not.toContain(waitpointId);
      } finally {
        barrier.release();
        await Promise.allSettled([original]);
        await engine.quit();
        await cancellationEngine.quit();
        await producerStore.quit();
        await barrier.close();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );
  containerTest(
    "parked expiry recovers after its terminal commit loses the finish enqueue",
    async ({ prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
      );
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const barrier = await waitpointStoreBarrier(redisOptions);
      const admin = createRedisClient(redisOptions);
      const queueUser = `parked_queue_${crypto.randomUUID()}`;
      const queuePassword = crypto.randomUUID();
      await admin.call("ACL", "SETUSER", queueUser, "on", `>${queuePassword}`, "~*", "+@all");
      let engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        workerDisabled: true,
        resolveDial: () => "off",
        workerRedisOptions: {
          ...barrier.redisOptions,
          username: queueUser,
          password: queuePassword,
          retryStrategy: () => null,
          maxRetriesPerRequest: 0,
        },
        finalizationGuardDelayMs: 100,
      });
      const setupEngine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        resolveDial: () => "off",
      });
      let expiry: Promise<unknown> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(setupEngine, env, ["parent-task", "child-task"]);
        const parent = await triggerRun(setupEngine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(setupEngine, "parked_enqueue_parent");
        const externalId = "parked-enqueue-missing-deployment";
        const child = await triggerRun(setupEngine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "child-task",
          parentTaskRunId: parent.id,
          resumeParentOnCompletion: true,
          parkedOnExternalDeploymentId: externalId,
        });
        const waitpointId = deriveRunWaitpointId(child.id)!;
        expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })).toBe(0);
        expect(await engine["worker"].getJob(`recoverRunWaitpoint:${child.id}`)).toBeNull();
        await setupEngine.quit();
        barrier.pause((args) =>
          args.some((arg) => arg.includes(`finishWaitpoint.externalDeploymentPark.${waitpointId}`))
        );
        expiry = engine.pendingVersionSystem
          .expireParkedExternalDeploymentRun({ runId: child.id, externalDeploymentId: externalId })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        await expect
          .poll(() => barrier.held, {
            timeout: 5000,
            interval: 10,
            message: "parked completion enqueue never reached the Redis request boundary",
          })
          .toBe(true);
        expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: child.id } })).status).toBe(
          "EXPIRED"
        );
        expect((await store.describeWaitpoint(waitpointId)).outcome).toBe("exists");
        await admin.call("ACL", "SETUSER", queueUser, "-eval", "-evalsha");
        barrier.release();
        expect(String(await expiry)).toMatch(/ACL|NOPERM|permission/i);
        await admin.call("ACL", "SETUSER", queueUser, "+@all");
        await engine.quit();
        engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          workerDisabled: true,
          resolveDial: () => "off",
          finalizationGuardDelayMs: 100,
        });
        expect(await engine["worker"].getJob(`ensureRunFinalized:${child.id}`)).not.toBeNull();
        expect(
          await engine["worker"].getJob(`finishWaitpoint.externalDeploymentPark.${waitpointId}`)
        ).toBeNull();
        // A retry sees EXPIRED and skips it; the write-ahead finalization job owns convergence.
        await engine.pendingVersionSystem.expireParkedExternalDeploymentRun({
          runId: child.id,
          externalDeploymentId: externalId,
        });
        expect((await store.describeWaitpoint(waitpointId)).outcome).toBe("exists");
        await engine.quit();
        engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          resolveDial: () => "off",
        });
        await expect
          .poll(
            async () =>
              (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus,
            {
              timeout: 10_000,
              interval: 20,
              message: "finalization guard never resumed the parent",
            }
          )
          .toBe("EXECUTING");
        const completed = (await store.readCompletedRecords([waitpointId])).get(waitpointId)!;
        expect(completed.status).toBe("COMPLETED");
        expect(completed.completion).toMatchObject({
          outputIsError: true,
          output: { inline: expect.stringContaining(externalId) },
        });
        expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })).toBe(0);
        await expect
          .poll(() => engine["worker"].getJob(`ensureRunFinalized:${child.id}`), {
            timeout: 5000,
            interval: 20,
            message: "completed finalization guard was never acknowledged",
          })
          .toBeNull();
      } finally {
        await admin.call("ACL", "SETUSER", queueUser, "+@all");
        barrier.release();
        await expiry;
        await engine.quit();
        await setupEngine.quit();
        await barrier.close();
        await admin.call("ACL", "DELUSER", queueUser);
        admin.disconnect();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );
  containerTest(
    "native RUN publication refuses rollback before either publication gate or lazy mutation",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      let allowedFlagReads: number | undefined;
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        resolveDial: () => "off",
        isWaitpointStoreEnabled: () => allowedFlagReads === undefined || allowedFlagReads-- > 0,
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "rollback_publish_parent");
        for (const window of ["outer", "inner", "lazy"] as const) {
          allowedFlagReads = undefined;
          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
          });
          if (window === "lazy") {
            // Enable planning and prearm; rollback at the router's publication check.
            allowedFlagReads = 5;
            await expect(
              engine.getOrCreateRunWaitpoint({
                runId: child.id,
                projectId: env.project.id,
                environmentId: env.id,
                organizationId: env.organization.id,
                blockingParentRunId: parent.id,
              })
            ).rejects.toThrow("Existing store waitpoint association is disabled");
          } else {
            const { plan } = await engine.waitpointSystem.planRunAssociatedWaitpoint({
              anchorRunId: child.id,
              parentRunId: parent.id,
              projectId: env.project.id,
              environmentId: env.id,
              organizationId: env.organization.id,
            });
            expect(plan.residency).toBe("store");
            allowedFlagReads = window === "outer" ? 0 : 1;
            await expect(
              engine.waitpointSystem.createAssociatedWaitpointRecord({
                runId: child.id,
                data: plan.data,
                organizationId: env.organization.id,
              })
            ).rejects.toThrow("Existing store waitpoint association is disabled");
          }
          expect(
            await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } }),
            `${window} rollback created a Postgres shadow`
          ).toBe(0);
          expect(
            hasStoreWaitpoints(
              (await prisma.taskRun.findUniqueOrThrow({ where: { id: child.id } })).annotations
            ),
            `${window} rollback changed the marker before refusing publication`
          ).toBe(false);
          expect(await store.probeWaitpointPresence(deriveRunWaitpointId(child.id)!)).toBe(
            "absent"
          );
        }
      } finally {
        await engine.quit();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );
});
