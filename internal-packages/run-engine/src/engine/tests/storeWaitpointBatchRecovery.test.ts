import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
} from "@internal/run-store";
import type { RedisOptions } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import {
  generateRunOpsId,
  generateWaitpointId,
  SnapshotId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { getLatestExecutionSnapshot } from "../systems/executionSnapshotSystem.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import type { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { workerCatalog } from "../workerCatalog.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

import { restrictedWaitpointStore } from "./utils/storeRunWaitpointLifecycleFixtures.js";
import { waitpointKeys } from "../waitpointCoordinator/keys.js";

describe("storeWaitpointBatchRecovery", () => {
  async function fixture(prisma: PrismaClient, redisOptions: RedisOptions) {
    const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const runStore = new TaskRunExecutionSnapshotStore(delegate, {
      store: snapshotStore,
      mode: "redis-only",
      resolveDial: () => "redis-only",
      residencyResolver: new SnapshotResidencyResolver({ store: snapshotStore }),
      resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
      logicalRunStoreRoute: "logical:1",
    });
    const { store, admin, username, close } = await restrictedWaitpointStore(redisOptions);
    const coordinator = new StoreWaitpointCoordinator({ store });
    const engine = new RunEngine({
      prisma,
      store: runStore,
      completionGuardDelayMs: 60_000,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: {
        redis: redisOptions,
        masterQueueConsumersDisabled: true,
        processWorkerQueueDebounceMs: 50,
      },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
        },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("batch-registration-recovery"),
      waitpointStoreEnabled: () => true,
      waitpointStore: store,
      waitpointFanoutStore: store,
      waitpointRouting: {
        store: coordinator,
        mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => true },
      },
    });
    return {
      engine,
      store,
      async recoveries(runId: string) {
        // Inspect actual durable jobs; never duplicate the batch absorption identity algorithm.
        const actualIds: string[] = await engine["worker"].queue["redis"].hkeys("items");
        const ids = actualIds.filter((id) => id.startsWith(`recoverWaitpointBlock:${runId}:`));
        return Promise.all(
          ids.map(async (id) => {
            const job = await engine["worker"].getJob(id);
            return {
              id,
              job: job!,
              payload: workerCatalog.recoverWaitpointBlock.schema.parse(job!.item),
            };
          })
        );
      },
      async rejectAbsorption(operation: () => Promise<unknown>) {
        await admin.call("ACL", "SETUSER", username, "-eval", "-evalsha");
        try {
          await expect(operation()).rejects.toThrow(/ACL|permission|NOPERM/i);
        } finally {
          await admin.call("ACL", "SETUSER", username, "+eval", "+evalsha");
        }
      },
      async rejectRegistration(waitpointId: string, operation: () => Promise<unknown>) {
        const key = waitpointKeys(waitpointId).watchers;
        expect(await admin.exists(key)).toBe(0);
        await admin.set(key, "wrong-type");
        try {
          await expect(operation()).rejects.toThrow("WRONGTYPE");
        } finally {
          await admin.del(key);
        }
      },
      async quit() {
        await engine.quit();
        await close();
        await snapshotStore.quit();
      },
    };
  }

  async function startParent(engine: RunEngine, prisma: PrismaClient) {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await setupBackgroundWorker(engine, environment, "batch-recovery-parent");
    const run = await engine.trigger(
      {
        number: 1,
        friendlyId: `run_${generateRunOpsId()}`,
        environment,
        taskIdentifier: "batch-recovery-parent",
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "batch-recovery-trace",
        spanId: "batch-recovery-span",
        workerQueue: "main",
        queue: "task/batch-recovery-parent",
        isTest: false,
        tags: [],
      },
      prisma
    );
    const dequeued = await vi.waitFor(
      async () => {
        const rows = await engine.dequeueFromWorkerQueue({
          blockingPopTimeoutSeconds: 1,
          consumerId: "batch-recovery-parent",
          workerQueue: "main",
        });
        expect(rows, "waitpoint condition never settled: rows").toHaveLength(1);
        return rows;
      },
      { timeout: 10_000, interval: 100 }
    );
    await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued[0]!.snapshot.id });
    return { run, environment };
  }

  async function sharedSource(
    store: WaitpointStoreCoordinator,
    environment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>
  ) {
    const waitpointId = generateWaitpointId("RUN");
    const now = new Date().toISOString();
    await store.createIfAbsent({
      record: {
        id: waitpointId,
        friendlyId: WaitpointId.toFriendlyId(waitpointId),
        type: "RUN",
        environmentId: environment.id,
        projectId: environment.project.id,
        createdAt: now,
        updatedAt: now,
        userProvidedIdempotencyKey: false,
        tags: [],
        completedByTaskRunId: "shared-child",
      },
      status: "PENDING",
    });
    return waitpointId;
  }

  for (const batched of [true, false]) {
    containerTest(
      `queued ${batched ? "batch" : "old non-batch"} recovery leaves pre-absorption failure for the caller retry to preserve its result`,
      async ({ prisma, redisOptions }) => {
        const f = await fixture(prisma, redisOptions);
        const { engine, store } = f;
        try {
          const { run, environment } = await startParent(engine, prisma);
          const waitpointId = await sharedSource(store, environment);
          const batchRow = await prisma.batchTaskRun.create({
            data: {
              id: generateRunOpsId(),
              friendlyId: `batch_${generateRunOpsId()}`,
              runtimeEnvironmentId: environment.id,
            },
          });
          const batch = batched ? { id: batchRow.id, index: 7 } : undefined;
          const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
            runId: run.id,
            waitpointId,
            organizationId: environment.organization.id,
          });
          const request = {
            runId: run.id,
            waitpoints: waitpointId,
            projectId: environment.project.id,
            organizationId: environment.organization.id,
            batch,
            spanIdToComplete: "cached-shared-child",
            blockOperation,
          };
          await f.rejectAbsorption(() => engine.blockRunWithWaitpoint(request));
          expect((await store.readBlockState(run.id)).edges).toEqual([]);
          const queued = await f.recoveries(run.id);
          expect(queued).toHaveLength(1);
          const { id: jobId, job: armed, payload } = queued[0]!;
          const absorptionId = payload.blockOperation.absorptionId;
          expect(armed).not.toBeNull();
          // Retries of the original caller retain the same queued obligation and identity.
          await f.rejectAbsorption(() => engine.blockRunWithWaitpoint(request));
          expect((await f.recoveries(run.id)).map(({ id }) => id)).toEqual([jobId]);
          expect(await engine["worker"].getJob(jobId)).toEqual(armed);
          if (batched) {
            expect(payload.batch).toEqual(batch);
            expect(absorptionId).not.toBe(blockOperation!.absorptionId);
          } else {
            // The old queued payload has no batch field and keeps its original operation identity.
            expect(armed!.item).not.toHaveProperty("batch");
            expect(payload.batch).toBeUndefined();
            expect(absorptionId).toBe(blockOperation!.absorptionId);
          }
          await engine.waitpointSystem.recoverWaitpointBlock(payload);
          expect((await store.readBlockState(run.id)).edges).toEqual([]);
          // Both production batch processors retry a failed trigger call (or replace it with a
          // pre-failed item); the recovery guard is not acceptance of a missing result position.
          await engine.blockRunWithWaitpoint(request);
          expect(await engine["worker"].getJob(jobId)).toBeNull();
          const recovered = await store.readBlockState(run.id);
          expect(recovered.edges).toHaveLength(1);
          expect(recovered.edges[0]).toMatchObject({
            waitpointId,
            spanIdToComplete: "cached-shared-child",
            ...(batched ? { batchId: batch!.id, batchIndex: 7 } : {}),
          });
          if (!batched) {
            expect(recovered.edges[0]!.batchId).toBeUndefined();
            expect(recovered.edges[0]!.batchIndex).toBeUndefined();
          }
          // A real batch returns its complete ordered result set. Supply the other positions without
          // dropping position 7: its successful caller retry retained the original edge and span.
          if (batch) {
            for (let index = 0; index < batch.index; index++) {
              await engine.blockRunWithWaitpoint({
                ...request,
                batch: { id: batch.id, index },
                spanIdToComplete: `other-cached-position-${index}`,
              });
            }
          }
          await engine.completeWaitpoint({
            id: waitpointId,
            organizationId: environment.organization.id,
            output: {
              value: '{"message":"shared child failed"}',
              type: "application/json",
              isError: true,
            },
          });
          // Real fanout and continuation must expose the original slot to the runtime resolver.
          await vi.waitFor(
            async () => {
              const resumed = await engine.getRunExecutionData({ runId: run.id });
              expect(
                resumed?.snapshot.executionStatus,
                "run never reached the expected execution status"
              ).toBe("EXECUTING");
              const results = resumed!.completedWaitpoints.filter((w) => w.id === waitpointId);
              expect(results).toHaveLength(batched ? 8 : 1);
              const result = results.find((w) => w.index === batch?.index)!;
              expect(result).toMatchObject({
                output: '{"message":"shared child failed"}',
                outputIsError: true,
              });
              expect(result.index).toBe(batch?.index);
              expect(result.completedByTaskRun?.batch?.id).toBe(batch?.id);
            },
            { timeout: 10_000 }
          );
          // A delayed copy still carries the original cycle and cannot install a new block after resume.
          await engine.waitpointSystem.recoverWaitpointBlock(payload);
          expect((await store.readBlockState(run.id)).edges).toEqual([]);
          expect(await engine["worker"].getJob(jobId)).toBeNull();
        } finally {
          await f.quit();
        }
      }
    );
  }

  containerTest(
    "shared-child batch positions retain independent recovery guards and absorption contributions",
    async ({ prisma, redisOptions }) => {
      const f = await fixture(prisma, redisOptions);
      const { engine, store } = f;
      try {
        const { run, environment } = await startParent(engine, prisma);
        const waitpointId = await sharedSource(store, environment);
        const batchId = generateRunOpsId();
        const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
          runId: run.id,
          waitpointId,
          organizationId: environment.organization.id,
        });
        const request = {
          runId: run.id,
          waitpoints: waitpointId,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
          blockOperation,
        };
        for (const index of [7, 8]) {
          await f.rejectRegistration(waitpointId, () =>
            engine.blockRunWithWaitpoint({
              ...request,
              batch: { id: batchId, index },
              spanIdToComplete: `cached-${index}`,
            })
          );
        }
        const queued = (await f.recoveries(run.id)).sort(
          (a, b) => a.payload.batch!.index! - b.payload.batch!.index!
        );
        const identities = queued.map(({ payload }) => payload.blockOperation.absorptionId);
        expect(identities[0]).not.toBe(identities[1]);
        const contributions = identities.map((absorptionId) => ({
          runId: run.id,
          blockId: blockOperation!.id,
          absorptionId,
        }));
        expect(await store.readContribution(contributions[0]!)).toEqual([`${waitpointId}#7`]);
        expect(await store.readContribution(contributions[1]!)).toEqual([`${waitpointId}#8`]);
        const jobIds = identities.map((id) => `recoverWaitpointBlock:${run.id}:${id}`);
        const jobs = await Promise.all(jobIds.map((id) => engine["worker"].getJob(id)));
        expect(jobs.every(Boolean)).toBe(true);
        const payloads = jobs.map((job) =>
          workerCatalog.recoverWaitpointBlock.schema.parse(job!.item)
        );
        expect(payloads.map((p) => p.batch?.index)).toEqual([7, 8]);
        await engine.waitpointSystem.recoverWaitpointBlock(payloads[0]!);
        expect(await engine["worker"].getJob(jobIds[0]!)).toBeNull();
        expect(await engine["worker"].getJob(jobIds[1]!)).toEqual(jobs[1]);
        expect(await store.readContribution(contributions[0]!)).toEqual([]);
        expect(await store.readContribution(contributions[1]!)).toEqual([`${waitpointId}#8`]);
        // A delayed compensation for the converged position cannot drain either indexed edge.
        await engine.waitpointSystem.ensureAbsorptionCompensated({
          ...contributions[0]!,
          organizationId: environment.organization.id,
        });
        expect((await store.readBlockState(run.id)).edges).toHaveLength(2);
        // Compensation removes only the interrupted position. Recovery cannot resurrect that
        // compensated dependency; an explicit caller retry must accept it again.
        await engine.waitpointSystem.ensureAbsorptionCompensated({
          ...contributions[1]!,
          organizationId: environment.organization.id,
        });
        expect((await store.readBlockState(run.id)).edges.map((edge) => edge.batchIndex)).toEqual([
          7,
        ]);
        await engine.waitpointSystem.recoverWaitpointBlock(payloads[1]!);
        expect((await store.readBlockState(run.id)).edges.map((edge) => edge.batchIndex)).toEqual([
          7,
        ]);
        await engine.blockRunWithWaitpoint({
          ...request,
          batch: { id: batchId, index: 8 },
          spanIdToComplete: "cached-8",
        });
        expect(await engine["worker"].getJob(jobIds[1]!)).toBeNull();
        expect(
          (await store.readBlockState(run.id)).edges.map((edge) => edge.batchIndex).sort()
        ).toEqual([7, 8]);
        expect(await store.readContribution(contributions[1]!)).toEqual([]);
      } finally {
        await f.quit();
      }
    }
  );

  for (const terminal of [true, false]) {
    containerTest(
      `obsolete block recovery retires its exact contribution after ${terminal ? "cancellation" : "a newer block"}`,
      async ({ prisma, redisOptions }) => {
        const f = await fixture(prisma, redisOptions);
        const { engine, store } = f;
        try {
          const { run, environment } = await startParent(engine, prisma);
          const waitpointId = await sharedSource(store, environment);
          const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
            runId: run.id,
            waitpointId,
            organizationId: environment.organization.id,
          });
          const request = {
            runId: run.id,
            waitpoints: waitpointId,
            projectId: environment.project.id,
            organizationId: environment.organization.id,
            blockOperation,
          };
          await f.rejectRegistration(waitpointId, () => engine.blockRunWithWaitpoint(request));
          const identity = {
            runId: run.id,
            blockId: blockOperation!.id,
            absorptionId: blockOperation!.absorptionId,
          };
          expect(await store.readContribution(identity)).toEqual([`${waitpointId}#`]);
          const jobId = `recoverWaitpointBlock:${run.id}:${identity.absorptionId}`;
          const queued = await engine["worker"].getJob(jobId);
          const payload = workerCatalog.recoverWaitpointBlock.schema.parse(queued!.item);
          let nextIdentity: typeof identity | undefined;
          if (terminal) {
            await engine.cancelRun({
              runId: run.id,
              organizationId: environment.organization.id,
              finalizeRun: true,
            });
            expect(
              (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus
            ).toBe("FINISHED");
          } else {
            const transitionId = SnapshotId.generate().id;
            await engine.waitpointSystem.prepareFailedAttemptCleanup({
              runId: run.id,
              organizationId: environment.organization.id,
              transitionId,
              tx: prisma,
            });
            const cur = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
            await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
              snapshotId: transitionId,
              run: { id: run.id, status: cur.runStatus, attemptNumber: cur.attemptNumber },
              snapshot: { executionStatus: "EXECUTING", description: "retry transition (test)" },
              previousSnapshotId: cur.id,
              environmentId: environment.id,
              environmentType: environment.type,
              projectId: environment.project.id,
              organizationId: environment.organization.id,
            });
            await engine.waitpointSystem.ensureBlockersCleanedUp({
              runId: run.id,
              organizationId: environment.organization.id,
              blockId: identity.blockId,
              transitionId,
            });
            const nextOperation = await engine.waitpointSystem.buildStoreBlockOperation({
              runId: run.id,
              waitpointId,
              organizationId: environment.organization.id,
            });
            expect(nextOperation!.id).not.toBe(identity.blockId);
            await f.rejectRegistration(waitpointId, () =>
              engine.blockRunWithWaitpoint({ ...request, blockOperation: nextOperation })
            );
            nextIdentity = {
              runId: run.id,
              blockId: nextOperation!.id,
              absorptionId: nextOperation!.absorptionId,
            };
            expect(await store.readContribution(nextIdentity)).toEqual([`${waitpointId}#`]);
          }
          const stateBefore = await store.readBlockState(run.id);
          // Terminal release owns eager cleanup, independent of whether this recovery job survives.
          // A newer non-terminal cycle still leaves this exact old contribution for compensation.
          expect(await store.readContribution(identity)).toEqual(
            terminal ? [] : [`${waitpointId}#`]
          );
          // Execute the persisted payload through the actual handler, then replay it once more.
          await engine["worker"].enqueue({ id: jobId, job: "recoverWaitpointBlock", payload });
          await vi.waitFor(
            async () =>
              expect(
                await engine["worker"].getJob(jobId),
                "recovery job never left the worker queue"
              ).toBeNull(),
            {
              timeout: 5000,
            }
          );
          expect(await store.readContribution(identity)).toEqual([]);
          expect(await store.readBlockState(run.id)).toEqual(stateBefore);
          await engine.waitpointSystem.recoverWaitpointBlock(payload);
          expect(await store.readBlockState(run.id)).toEqual(stateBefore);
          if (nextIdentity)
            expect(await store.readContribution(nextIdentity)).toEqual([`${waitpointId}#`]);
        } finally {
          await f.quit();
        }
      }
    );
  }
});
