import { keyedWaitpointTest as containerTest } from "./utils/keyedWaitpointTest.js";
import { RedisSnapshotStore } from "@internal/run-store";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  generateWaitpointId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import { createRedisClient } from "@internal/redis";
import { waitpointStoreBarrier } from "./utils/waitpointStoreBarrier.js";
import {
  fanoutIndexKeys,
  fanoutPartition,
  organizationPendingSourceIndexKey,
  idempotencyReceiptKey,
  waitpointKeys,
} from "../waitpointCoordinator/keys.js";
import { describe, expect, vi } from "vitest";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import {
  WaitpointNotFoundError,
  WaitpointStoreCoordinator,
} from "../waitpointCoordinator/storeCoordinator.js";
import { workerCatalog } from "../workerCatalog.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("storeWaitpointSourceExpiry", () => {
  containerTest(
    "finite keyed completion survives its deadline and source expiry before receipt ACK",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const barrier = await waitpointStoreBarrier(redisOptions);
      const store = new WaitpointStoreCoordinator({
        redisOptions: barrier.redisOptions,
        terminalRetentionMs: 200,
      });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        workerDisabled: true,
      });
      const redis = createRedisClient(redisOptions);
      let recovery: Promise<void> | undefined;
      let restarted: ReturnType<typeof makeEngine> | undefined;
      let restartedStore: WaitpointStoreCoordinator | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const key = "finite-early-completion";
        const created = await engine.createDateTimeWaitpoint({
          runId: generateRunOpsId(),
          projectId: env.project.id,
          environmentId: env.id,
          organizationId: env.organization.id,
          completedAfter: new Date(Date.now() + 1000),
          idempotencyKey: key,
          idempotencyKeyExpiresAt: new Date(Date.now() + 200),
        });
        const id = created.waitpoint.id;
        const job = await engine["worker"].getJob(`recoverDateTimeWaitpoint:${id}`);
        const payload = workerCatalog.recoverDateTimeWaitpoint.schema.parse(job!.item);
        const receipt = idempotencyReceiptKey(payload.keyedCreation!.scope, key, id);
        await engine.completeWaitpoint({
          id,
          organizationId: env.organization.id,
          onlyIfPending: true,
          output: { value: '{"early":"winner"}', type: "application/json", isError: false },
        });
        const original = (await store.readCompletedRecords([id])).get(id)!;
        expect(original.completion?.output).toEqual({ inline: '{"early":"winner"}' });
        expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1);
        expect(await redis.pttl(receipt)).toBe(-1);
        await expect
          .poll(() => Date.now() >= payload.completedAfter.getTime(), {
            timeout: 5000,
            interval: 20,
            message: "persisted DATETIME deadline never became due",
          })
          .toBe(true);
        expect((await store.readCompletedRecords([id])).get(id)).toEqual(original);
        // Hold the real ACK request after terminal proof and source release are durable.
        barrier.pause(
          (args) => args[2] === "1" && args[3] === receipt && args[4] === `completed:${id}`
        );
        recovery = engine.waitpointSystem.recoverDateTimeWaitpoint(payload);
        await expect
          .poll(() => barrier.held, {
            timeout: 5000,
            interval: 10,
            message: "receipt ACK never reached its durable boundary",
          })
          .toBe(true);
        expect(await redis.get(receipt)).toBe(`completed:${id}`);
        expect(await redis.pttl(receipt)).toBe(-1);
        await expect
          .poll(() => redis.exists(waitpointKeys(id).record), {
            timeout: 5000,
            interval: 20,
            message: "released completed source never actually expired",
          })
          .toBe(0);
        // A new engine replays the persisted job using terminal evidence after real source expiry.
        restartedStore = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 200 });
        restarted = makeEngine(prisma, redisOptions, {
          store: restartedStore,
          snapshotStore,
          workerDisabled: true,
        });
        const ackStartedAt = Date.now();
        await restarted.waitpointSystem.recoverDateTimeWaitpoint(payload);
        expect(await redis.exists(waitpointKeys(id).record)).toBe(0);
        expect(await redis.pttl(receipt)).toBeGreaterThan(0);
        expect(await redis.pttl(receipt)).toBeLessThanOrEqual(
          Math.max(0, payload.keyedCreation!.acceptUntil - ackStartedAt) + 200
        );
        barrier.release();
        await recovery;
        recovery = undefined;
        await expect
          .poll(() => redis.exists(receipt), {
            timeout: 5000,
            interval: 20,
            message: "acknowledged keyed receipt never expired",
          })
          .toBe(0);
        await restarted.waitpointSystem.recoverDateTimeWaitpoint(payload);
        expect(await redis.exists(waitpointKeys(id).record)).toBe(0);
        // A late application callback uses the real engine producer and its durable queue arm.
        // The missing-source response is preserved, but delivery must retire its discovery hints.
        await expect(
          restarted.completeWaitpoint({
            id,
            organizationId: env.organization.id,
            onlyIfPending: true,
          })
        ).rejects.toBeInstanceOf(WaitpointNotFoundError);
        const fanout = await restarted["worker"].getJob(`deliverWaitpointFanout:${id}`);
        expect(fanout).not.toBeNull();
        const partition = fanoutPartition(id);
        const due = fanoutIndexKeys(partition).due;
        const owned = organizationPendingSourceIndexKey(env.organization.id, partition);
        expect(await redis.zscore(due, id)).not.toBeNull();
        expect(await redis.zscore(owned, id)).not.toBeNull();
        await restarted["worker"]["jobs"].deliverWaitpointFanout({
          ...fanout!,
          payload: workerCatalog.deliverWaitpointFanout.schema.parse(fanout!.item),
        });
        expect(await redis.zscore(due, id)).toBeNull();
        expect(await redis.zscore(owned, id)).toBeNull();
        expect(await restarted["worker"].getJob(`deliverWaitpointFanout:${id}`)).toBeNull();
      } finally {
        barrier.release();
        await recovery?.catch(() => undefined);
        await restarted?.quit();
        await restartedStore?.quit();
        await engine.quit();
        await store.quit();
        await redis.quit();
        await barrier.close();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "phase-2 failure and premature continuation retain the exact block through source expiry and recovery",
    async ({ prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"`
      );
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 1000 });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore,
        // Far beyond the test: the prearmed recovery is released explicitly below.
        recoveryDelayMs: 60_000,
        resolveDial: () => "off",
      });
      const cached: Array<{ cachedRunId?: string; blockedRunId: string; hasError: boolean }> = [];
      engine.eventBus.on("cachedRunCompleted", (event) => {
        cached.push(event);
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["expiry-parent", "expiry-child"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "expiry-parent",
        });
        await dequeueAndStart(engine, "expiry-recovery-parent");
        const output = '{"stable":"retained"}';
        const child = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "expiry-child",
        });
        const childAttempt = await dequeueAndStart(engine, "expiry-recovery-child");
        await engine.completeRunAttempt({
          runId: child.id,
          snapshotId: childAttempt.snapshot.id,
          completion: { id: child.id, ok: true, output, outputType: "application/json" },
        });
        const childId = child.id;
        const id = deriveWaitpointIdFromAnchor(childId, "RUN")!;
        // Seed the historical source directly: its original completion/fanout jobs already converged.
        // This late parent must rely exclusively on its own prearmed registration recovery.
        const now = new Date().toISOString();
        await store.createIfAbsent({
          record: {
            id,
            friendlyId: WaitpointId.toFriendlyId(id),
            type: "RUN",
            environmentId: env.id,
            projectId: env.project.id,
            completedByTaskRunId: childId,
            userProvidedIdempotencyKey: false,
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
          status: "PENDING",
        });
        await store.complete({
          waitpointId: id,
          completion: {
            completedAt: now,
            output: { inline: output },
            outputType: "application/json",
            outputIsError: false,
          },
        });
        const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
          runId: parent.id,
          waitpointId: id,
          organizationId: env.organization.id,
        });
        // Absorption commits the early receipt before the blocked snapshot. A real DB
        // constraint interrupts the later write, leaving the prearmed recovery obligation.
        await prisma.$executeRawUnsafe(`ALTER TABLE "TaskRunExecutionSnapshot"
          ADD CONSTRAINT "test_interrupt_blocked_snapshot"
          CHECK (description <> 'Run was blocked by a waitpoint.')`);
        await expect(
          engine.blockRunWithWaitpoint({
            runId: parent.id,
            waitpoints: id,
            organizationId: env.organization.id,
            projectId: env.project.id,
            blockOperation,
            spanIdToComplete: "expiry-cached-span",
          })
        ).rejects.toThrow(/constraint|check/i);
        // A duplicate completion can deliver continuation before phase 2 recovers. The initial
        // EXECUTING snapshot is not proof of a resume: retain this exact block and its early receipt.
        const beforePrematureContinuation = await engine.runStore.findLatestExecutionSnapshot(
          parent.id
        );
        expect(beforePrematureContinuation?.executionStatus).toBe("EXECUTING");
        expect(
          await engine.waitpointSystem.continueRunIfUnblocked({
            runId: parent.id,
            organizationId: env.organization.id,
          })
        ).toMatchObject({ status: "skipped" });
        expect(await store.currentBlockId(parent.id)).toBe(blockOperation!.id);
        expect((await store.readBlockState(parent.id)).handoff).toBe("owed");
        expect((await engine.runStore.findLatestExecutionSnapshot(parent.id))?.id).toBe(
          beforePrematureContinuation?.id
        );
        await prisma.$executeRawUnsafe(`ALTER TABLE "TaskRunExecutionSnapshot"
          DROP CONSTRAINT "test_interrupt_blocked_snapshot"`);
        const expiry = createRedisClient(redisOptions);
        try {
          await expiry.pexpire(waitpointKeys(id).record, 1);
          await expect
            .poll(() => expiry.exists(waitpointKeys(id).record), {
              timeout: 2000,
              interval: 20,
              message: "completed source never expired after durable receipt",
            })
            .toBe(0);
        } finally {
          expiry.disconnect();
        }
        expect(await store.probeWaitpointPresence(id)).toBe("absent");
        expect(
          (await store.readCompletedRecords([id], parent.id)).get(id)?.completion?.output
        ).toEqual({ inline: output });
        expect((await store.readBlockState(parent.id)).handoff).toBe("owed");
        // Release the real prearmed recovery only now, from the already-expired source.
        // Catches: prearmed block recovery resuming the parent before source expiry, or never armed.
        const recoveryJobId = `recoverWaitpointBlock:${parent.id}:${blockOperation!.absorptionId}`;
        expect(await engine["worker"].getJob(recoveryJobId)).toMatchObject({ attempt: 0 });
        await engine["worker"].reschedule(recoveryJobId, new Date());
        await vi.waitFor(
          async () => {
            const data = await engine.getRunExecutionData({ runId: parent.id });
            expect(
              data?.snapshot.executionStatus,
              "run never reached the expected execution status"
            ).toBe("EXECUTING");
            expect(data?.completedWaitpoints).toMatchObject([
              { id, output, completedByTaskRun: { id: childId } },
            ]);
            expect(cached).toContainEqual(
              expect.objectContaining({
                span: expect.objectContaining({ id: "expiry-cached-span" }),
                cachedRunId: childId,
                blockedRunId: parent.id,
                hasError: false,
              })
            );
          },
          { timeout: 8000, interval: 100 }
        );
      } finally {
        await engine.quit();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );

  for (const tokenType of ["DATETIME", "MANUAL"] as const) {
    containerTest(
      `unkeyed ${tokenType} deadline never resurrects an expired early completion`,
      async ({ prisma, redisOptions }) => {
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 200 });
        const engine = makeEngine(prisma, redisOptions, { store, snapshotStore });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["early-datetime"]);
          const run = await triggerRun(engine, env, prisma, {
            friendlyId: `run_${generateRunOpsId()}`,
            taskIdentifier: "early-datetime",
          });
          const createParams = {
            runId: run.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
          };
          const deadline = new Date(Date.now() + 2000);
          const created =
            tokenType === "MANUAL"
              ? await engine.createManualWaitpoint({ ...createParams, timeout: deadline })
              : await engine.createDateTimeWaitpoint({
                  runId: run.id,
                  projectId: env.project.id,
                  environmentId: env.id,
                  organizationId: env.organization.id,
                  completedAfter: new Date(Date.now() + 2000),
                });
          const id = created.waitpoint.id;
          const jobId = `recoverDateTimeWaitpoint:${id}`;
          const queued = await engine["worker"].getJob(jobId);
          const payload = workerCatalog.recoverDateTimeWaitpoint.schema.parse(queued!.item);
          expect(payload.creationAcceptUntil).toBeGreaterThan(Date.now());
          await engine.completeWaitpoint({
            id,
            organizationId: env.organization.id,
            onlyIfPending: true,
            output: { value: '{"early":"winner"}', type: "application/json", isError: false },
          });
          const original = (await store.readCompletedRecords([id])).get(id)!;
          expect(original.completion?.output).toEqual({ inline: '{"early":"winner"}' });
          await engine.waitpointSystem.recoverDateTimeWaitpoint(payload);
          expect((await store.readCompletedRecords([id])).get(id)).toEqual(original);
          await vi.waitFor(
            async () =>
              expect(
                await store.probeWaitpointPresence(id),
                "waitpoint source never reached its expected presence"
              ).toBe("absent"),
            { timeout: 10_000, interval: 20 }
          );
          // The actual persisted deadline runs after real expiry. It retries during the publication
          // window, rather than replacing the first completion with a newly created null result.
          await vi.waitFor(
            async () => {
              expect(
                (await engine["worker"].getJob(jobId))?.attempt,
                "recovery job never left the worker queue"
              ).toBeGreaterThan(0);
            },
            { timeout: 6000, interval: 20 }
          );
          expect(await store.probeWaitpointPresence(id)).toBe("absent");
          await expect(engine.waitpointSystem.recoverDateTimeWaitpoint(payload)).rejects.toThrow(
            "publication is not yet fenced"
          );
          // An old unfenced payload must fail closed while missing, never recreate or silently ACK.
          await expect(
            engine.waitpointSystem.recoverDateTimeWaitpoint({
              ...payload,
              creationAcceptUntil: undefined,
            })
          ).rejects.toThrow("publication is not yet fenced");
          expect(await store.probeWaitpointPresence(id)).toBe("absent");
        } finally {
          await engine.quit();
          await store.quit();
          await snapshotStore.quit();
        }
      }
    );
  }

  containerTest(
    "unkeyed DATETIME publication fence handles immediate deadlines and closed unpublished attempts",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 200 });
      const coordinator = new StoreWaitpointCoordinator({ store });
      const engine = makeEngine(prisma, redisOptions, { store, snapshotStore, coordinator });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const creationAcceptUntil = Date.now() + 3000;
        let payload!: Parameters<typeof engine.waitpointSystem.recoverDateTimeWaitpoint>[0];
        let jobId = "";
        const created = await coordinator.createDateTimeWaitpoint({
          projectId: env.project.id,
          environmentId: env.id,
          completedAfter: new Date(Date.now() - 1000),
          creationAcceptUntil,
          beforeStoreCreate: async (waitpointId) => {
            jobId = `recoverDateTimeWaitpoint:${waitpointId}`;
            payload = {
              waitpointId,
              projectId: env.project.id,
              environmentId: env.id,
              organizationId: env.organization.id,
              completedAfter: new Date(Date.now() - 1000),
              creationAcceptUntil,
            };
            await engine["worker"].enqueue({ id: jobId, job: "recoverDateTimeWaitpoint", payload });
            // Force the real deadline handler to observe the write-ahead job BEFORE publication.
            await vi.waitFor(
              async () => {
                expect(
                  (await engine["worker"].getJob(jobId))?.attempt,
                  "recovery job never left the worker queue"
                ).toBeGreaterThan(0);
              },
              { timeout: 2000, interval: 10 }
            );
            await engine["worker"].enqueue({
              id: jobId,
              job: "recoverDateTimeWaitpoint",
              payload,
              availableAt: new Date(creationAcceptUntil + 100),
            });
          },
        });
        expect(await store.probeWaitpointPresence(created.waitpoint.id)).toBe("present");
        await vi.waitFor(
          async () => {
            expect(
              await engine["worker"].getJob(jobId),
              "recovery job never left the worker queue"
            ).toBeNull();
          },
          { timeout: 5000, interval: 10 }
        );
        // Retry happens after the acceptance fence: an already published PENDING source still completes.
        expect(Date.now()).toBeGreaterThan(creationAcceptUntil);
        const completed = (await store.readCompletedRecords([created.waitpoint.id])).get(
          created.waitpoint.id
        )!;
        expect(completed.status).toBe("COMPLETED");
        await engine.waitpointSystem.recoverDateTimeWaitpoint(payload);
        expect(
          (await store.readCompletedRecords([created.waitpoint.id])).get(created.waitpoint.id)
        ).toEqual(completed);
        await vi.waitFor(
          async () =>
            expect(
              await store.probeWaitpointPresence(created.waitpoint.id),
              "waitpoint source never reached its expected presence"
            ).toBe("absent"),
          { timeout: 10_000, interval: 20 }
        );
        // Replay after completion/expiry and before the queue's ACK has no authority to recreate.
        await engine.waitpointSystem.recoverDateTimeWaitpoint(payload);
        expect(await store.probeWaitpointPresence(created.waitpoint.id)).toBe("absent");

        const unpublished = generateWaitpointId("DATETIME");
        const closed = { ...payload, waitpointId: unpublished };
        const closedJob = `recoverDateTimeWaitpoint:${unpublished}`;
        await engine["worker"].enqueue({
          id: closedJob,
          job: "recoverDateTimeWaitpoint",
          payload: closed,
        });
        await vi.waitFor(
          async () =>
            expect(
              await engine["worker"].getJob(closedJob),
              "recovery job never left the worker queue"
            ).toBeNull(),
          { timeout: 10_000, interval: 20 }
        );
        await expect(
          store.createDateTimeCandidate(
            {
              id: unpublished,
              friendlyId: WaitpointId.toFriendlyId(unpublished),
              type: "DATETIME",
              projectId: env.project.id,
              environmentId: env.id,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              userProvidedIdempotencyKey: false,
              tags: [],
            },
            creationAcceptUntil
          )
        ).rejects.toThrow("creation window closed");
        await engine.waitpointSystem.recoverDateTimeWaitpoint(closed);
        expect(await store.probeWaitpointPresence(unpublished)).toBe("absent");
      } finally {
        await engine.quit();
        await store.quit();
        await snapshotStore.quit();
      }
    }
  );
});
