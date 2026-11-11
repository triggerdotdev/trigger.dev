import {
  keyedWaitpointTest as containerTest,
  registerTestKeyLane,
} from "./utils/keyedWaitpointTest.js";
import { PrismaClient } from "@trigger.dev/database";
import { createWaitpointStoreEnabledResolver } from "../../../../../apps/webapp/app/v3/utils/waitpointStoreEnabled.server.js";
import { RedisSnapshotStore } from "@internal/run-store";
import { deriveWaitpointIdFromAnchor, generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient } from "@internal/redis";
import { workerCatalog } from "../workerCatalog.js";
import { waitpointStoreBarrier } from "./utils/waitpointStoreBarrier.js";
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

describe("storeWaitpointConcurrentRecovery", () => {
  containerTest(
    "keyed creation and native reuse resolve the real DB flag before owning the only PG connection",
    async ({ prisma, postgresContainer, redisOptions }) => {
      const url = new URL(postgresContainer.getConnectionUri());
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("pool_timeout", "1");
      const single = new PrismaClient({
        datasources: { db: { url: url.toString() } },
        log: [{ emit: "event", level: "query" }],
      });
      const lane = registerTestKeyLane(single, url.toString());
      const queries: string[] = [];
      single.$on("query", (event) => queries.push(event.query));
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const enabled = createWaitpointStoreEnabledResolver(() => undefined, single);
      const engine = makeEngine(single, redisOptions, {
        store,
        snapshotStore,
        workerDisabled: true,
        isWaitpointStoreEnabled: enabled,
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: true } },
        });
        const args = {
          runId: generateRunOpsId(),
          organizationId: env.organization.id,
          projectId: env.project.id,
          environmentId: env.id,
          completedAfter: new Date(Date.now() + 60_000),
          idempotencyKey: "single-connection-key",
        };
        const first = await engine.createDateTimeWaitpoint(args);
        const cached = await engine.createDateTimeWaitpoint({
          ...args,
          completedAfter: new Date(Date.now() + 120_000),
        });
        expect(first.isCached).toBe(false);
        expect(cached.isCached).toBe(true);
        expect(cached.waitpoint.id).toBe(first.waitpoint.id);
        expect(cached.waitpoint.completedAfter).toEqual(args.completedAfter);
        expect(await prisma.waitpoint.count({ where: { environmentId: env.id } })).toBe(0);

        // Explicit native reads refuse disabled/missing orgs before either native or PG reads.
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        await store.quit();
        queries.length = 0;
        expect(
          await engine.getStoreDateTimeWaitpoint({
            ...args,
            waitpointId: first.waitpoint.id,
          })
        ).toBeNull();
        expect(queries.length).toBeGreaterThan(0);
        expect(queries.every((query) => query.includes('"Organization"'))).toBe(true);
        queries.length = 0;
        expect(
          await engine.getStoreDateTimeWaitpoint({
            ...args,
            waitpointId: first.waitpoint.id,
            organizationId: undefined,
          })
        ).toBeNull();
        expect(queries).toEqual([]);
      } finally {
        await engine.quit();
        await store.quit();
        await snapshotStore.quit();
        await lane.close();
        await single.$disconnect();
      }
    }
  );

  for (const phase of ["before", "after"] as const) {
    containerTest(
      `RUN recovery handler converges when child finishes ${phase} association publication`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const { store, admin, username, close } = await restrictedWaitpointStore(redisOptions);
        const barrier = await waitpointStoreBarrier(redisOptions);
        const recoveryStore = new WaitpointStoreCoordinator({ redisOptions: barrier.redisOptions });
        const engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          recoveryDelayMs: 60_000,
        });
        const recoveryEngine = makeEngine(prisma, redisOptions, {
          store: recoveryStore,
          snapshotStore,
          recoveryDelayMs: 60_000,
        });
        let recovery: Promise<unknown> | undefined;
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, "race_parent");
          const child = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "child-task",
          });
          const attempt = await dequeueAndStart(engine, "race_child");
          await admin.call("ACL", "SETUSER", username, "-hset");
          await expect(
            engine.getOrCreateRunWaitpoint({
              runId: child.id,
              projectId: env.project.id,
              environmentId: env.id,
              blockingParentRunId: parent.id,
              organizationId: env.organization.id,
            })
          ).rejects.toThrow(/ACL|permission|NOPERM/i);
          await admin.call("ACL", "SETUSER", username, "+hset");
          const waitpointId = deriveWaitpointIdFromAnchor(child.id, "RUN")!;
          const blockOperation = (await engine.waitpointSystem.buildStoreBlockOperation({
            runId: parent.id,
            waitpointId,
            organizationId: env.organization.id,
          }))!;
          expect(
            await engine["worker"].queue.getJob(`recoverRunWaitpoint:${child.id}`)
          ).not.toBeNull();
          barrier.pause(
            (args) =>
              args[2] === "2" &&
              args[3] === `wp:v1:{${waitpointId}}` &&
              args[4] === `wp:v1:{${waitpointId}}:related` &&
              args[5]!.includes('"type":"RUN"'),
            phase === "before" ? "request" : "reply"
          );
          // Exercise the actual registered callback, including its subsequent child-publication lock.
          recovery = recoveryEngine["worker"]["jobs"].recoverRunWaitpoint({
            payload: {
              runId: child.id,
              parentRunId: parent.id,
              organizationId: env.organization.id,
              waitpointId,
              blockOperation,
            },
          });
          await expect
            .poll(() => barrier.held, {
              timeout: 5000,
              interval: 10,
              message: `RUN recovery never reached the real ${phase} publication boundary`,
            })
            .toBe(true);
          expect(await store.probeWaitpointPresence(waitpointId)).toBe(
            phase === "before" ? "absent" : "present"
          );
          await engine.completeRunAttempt({
            runId: child.id,
            snapshotId: attempt.snapshot.id,
            completion: { id: child.id, ok: true, output: "42", outputType: "application/json" },
          });
          barrier.release();
          await recovery;
          const stored = (await store.readCompletedRecords([waitpointId])).get(waitpointId)!;
          expect(stored.status).toBe("COMPLETED");
          expect(stored.completion?.output).toEqual({ inline: "42" });
          expect((await store.readBlockState(parent.id)).edges).toEqual([]);
          expect(
            (await engine.getRunExecutionData({ runId: parent.id }))?.completedWaitpoints
          ).toEqual([]);
          // The failed lazy publication did not accept a wait. An explicit retry registers the
          // winning terminal source, independent of whether completion beat its publication.
          const association = await engine.getOrCreateRunWaitpoint({
            runId: child.id,
            projectId: env.project.id,
            environmentId: env.id,
            blockingParentRunId: parent.id,
            organizationId: env.organization.id,
          });
          await engine.blockRunWithWaitpoint({
            runId: parent.id,
            waitpoints: association.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
            blockOperation,
          });
          await vi.waitFor(
            async () => {
              const resumed = await engine.getRunExecutionData({ runId: parent.id });
              expect(
                resumed?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
              expect(resumed?.completedWaitpoints).toContainEqual(
                expect.objectContaining({ id: waitpointId, output: "42", outputIsError: false })
              );
            },
            { timeout: 10_000 }
          );
          expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })).toBe(
            0
          );
        } finally {
          barrier.release();
          barrier.release();
          await recovery?.catch(() => {});
          await recoveryEngine.quit();
          await engine.quit();
          await recoveryStore.quit();
          await close();
          await barrier.close();
          await snapshotStore.quit();
        }
      }
    );
  }

  for (const phase of ["begin", "reserve"] as const) {
    containerTest(
      `keyed producer connection loss fences delayed ${phase} after successor native MANUAL commit`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const barrier = await waitpointStoreBarrier(redisOptions);
        const store = new WaitpointStoreCoordinator({ redisOptions: barrier.redisOptions });
        const successorStore = new WaitpointStoreCoordinator({ redisOptions });
        const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
        const successorEngine = makeEngine(prisma, redisOptions, {
          store: successorStore,
          snapshotStore,
        });
        let first: Promise<unknown> | undefined;
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["keyed-fence-task"]);
          const run = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "keyed-fence-task",
          });
          const key = `keyed-fence-${phase}-${run.id}`;
          const deadline = new Date(Date.now() + 60_000);
          const base = {
            runId: run.id,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          };
          barrier.pause((args) =>
            phase === "begin"
              ? args[2] === "2" && args.length === 8 && args[4]!.includes(":idem-claim:")
              : args[2] === "3" && args.at(-2) === "reserve"
          );
          first = engine.createDateTimeWaitpoint({
            ...base,
            completedAfter: deadline,
            idempotencyKey: key,
          });
          // Attach rejection handling before deliberately terminating the owning transaction.
          const failed = first.then(
            () => ({ failed: false }),
            () => ({ failed: true })
          );
          await expect
            .poll(() => barrier.held, {
              timeout: 5000,
              interval: 10,
              message: `keyed ${phase} request never reached its real Redis boundary`,
            })
            .toBe(true);
          const lockKey = JSON.stringify([env.id, key]);
          const holders = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid::bigint = ((hashtextextended(${lockKey}, 0) >> 32) & 4294967295)
        AND objid::bigint = (hashtextextended(${lockKey}, 0) & 4294967295)
      `;
          expect(holders).toHaveLength(1);
          await prisma.$queryRaw`SELECT pg_terminate_backend(${holders[0].pid}::int)`;
          const successor = await successorEngine.waitpointSystem.createManualWaitpoint({
            ...base,
            idempotencyKey: key,
          });
          expect(successor.waitpoint.type).toBe("MANUAL");
          expect(successor.isCached).toBe(false);
          barrier.release();
          expect(await failed).toEqual({ failed: true });
          expect(
            (
              await engine.createDateTimeWaitpoint({
                ...base,
                completedAfter: deadline,
                idempotencyKey: key,
              })
            ).waitpoint.id
          ).toBe(successor.waitpoint.id);
          expect(
            await prisma.waitpoint.count({ where: { environmentId: env.id, idempotencyKey: key } })
          ).toBe(0);
          const actualItems: string[] = await engine["worker"].queue["redis"].hvals("items");
          const queued = actualItems
            .map((entry) => JSON.parse(entry) as { job: string; item: unknown })
            .filter((entry) => entry.job === "recoverDateTimeWaitpoint")
            .map((entry) => workerCatalog.recoverDateTimeWaitpoint.schema.parse(entry.item))
            .find((payload) => !payload.manual && payload.keyedCreation?.idempotencyKey === key);
          if (phase === "reserve") {
            expect(
              queued,
              "reservation never armed its DATETIME recovery obligation"
            ).toBeDefined();
            await expect
              .poll(
                async () => {
                  try {
                    await engine.waitpointSystem.recoverDateTimeWaitpoint(queued!);
                    return await store.probeWaitpointPresence(queued!.waitpointId);
                  } catch {
                    return "not-yet-fenced";
                  }
                },
                {
                  timeout: 5000,
                  interval: 20,
                  message: "delayed reservation never fenced and cleaned up its source candidate",
                }
              )
              .toBe("absent");
          }
        } finally {
          barrier.release();
          await first?.catch(() => {});
          await engine.quit();
          await successorEngine.quit();
          await store.quit();
          await successorStore.quit();
          await barrier.close();

          await snapshotStore.quit();
        }
      }
    );
  }

  containerTest(
    "keyed DATETIME recovery preserves explicit completion and never recreates a missing winner",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
      const probe = createRedisClient(redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["keyed-completed-task"]);
        const run = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "keyed-completed-task",
        });
        const deadline = new Date(Date.now() + 60_000);
        const first = await engine.createDateTimeWaitpoint({
          runId: run.id,
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
          completedAfter: deadline,
          idempotencyKey: "completed-key",
        });
        const job = await engine["worker"].getJob(`recoverDateTimeWaitpoint:${first.waitpoint.id}`);
        const armed = workerCatalog.recoverDateTimeWaitpoint.schema.parse(job!.item);
        const recovery = {
          waitpointId: first.waitpoint.id,
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
          completedAfter: deadline,
          keyedCreation: {
            ...armed.keyedCreation!,
          },
        };
        await engine.waitpointSystem.completeWaitpoint({
          id: first.waitpoint.id,
          organizationId: env.organization.id,
          output: { value: "false", type: "application/json", isError: false },
          onlyIfPending: true,
        });
        await engine.waitpointSystem.recoverDateTimeWaitpoint(recovery);
        const preserved = await engine.waitpointSystem.readExistingStoreDateTimeWaitpoint({
          waitpointId: first.waitpoint.id,
          organizationId: env.organization.id,
          environmentId: env.id,
          projectId: env.project.id,
        });
        expect(preserved).toMatchObject({
          status: "COMPLETED",
          output: "false",
          outputIsError: false,
        });
        expect(
          await engine.waitpointSystem.readExistingStoreDateTimeWaitpoint({
            waitpointId: first.waitpoint.id,
            organizationId: env.organization.id,
            environmentId: "wrong-env",
            projectId: env.project.id,
          })
        ).toBeNull();
        expect(
          await engine.waitpointSystem.readExistingStoreDateTimeWaitpoint({
            waitpointId: first.waitpoint.id,
            organizationId: env.organization.id,
            environmentId: env.id,
            projectId: "wrong-project",
          })
        ).toBeNull();
        // Terminal evidence permits retirement after source reclamation without resurrection.
        await probe.del(`wp:v1:{${first.waitpoint.id}}`);
        await engine.waitpointSystem.recoverDateTimeWaitpoint(recovery);
        expect(await store.probeWaitpointPresence(first.waitpoint.id)).toBe("absent");

        // A genuinely pending winner has no terminal proof: losing its source must fail closed.
        const pending = await engine.createDateTimeWaitpoint({
          runId: run.id,
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
          completedAfter: deadline,
          idempotencyKey: "missing-pending-key",
        });
        const pendingJob = await engine["worker"].getJob(
          `recoverDateTimeWaitpoint:${pending.waitpoint.id}`
        );
        const pendingRecovery = workerCatalog.recoverDateTimeWaitpoint.schema.parse(
          pendingJob!.item
        );
        await probe.del(`wp:v1:{${pending.waitpoint.id}}`);
        await expect(
          engine.waitpointSystem.recoverDateTimeWaitpoint(pendingRecovery)
        ).rejects.toThrow();
        expect(await store.probeWaitpointPresence(pending.waitpoint.id)).toBe("absent");
      } finally {
        probe.disconnect();
        await engine.quit();
        await store.quit();

        await snapshotStore.quit();
      }
    }
  );
});
