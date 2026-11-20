import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { setTimeout } from "node:timers/promises";
import type { TaskRun } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { RunEngine } from "../index.js";
import { LockAcquisitionTimeoutError } from "../locking.js";
import { edgeField, runBlockKeys } from "../waitpointCoordinator/keys.js";
import { deriveRunWaitpointId } from "../waitpointCoordinator/runWaitpointId.js";
import { triggerRun, dequeueAndStart } from "./utils/storeRunWaitpointLifecycleFixtures.js";
import {
  attachCachedRun,
  createFailedItem,
  expectBatchResolvedOnce,
  fireRecoveryNow,
  itemPayload,
  newFriendlyId,
  positionFields,
  setupBatchParent,
  storeBatchHarness,
  triggerItem,
  type StoreBatchHarness,
} from "./utils/storeBatchHarness.js";

// Above the sum of the oracle's bounded polls, so a slow run fails on a named condition.
vi.setConfig({ testTimeout: 180_000 });

const count = 3;
const lockRetry = { maxAttempts: 3, baseDelay: 50, maxDelay: 100, maxTotalWaitTime: 300 };

async function waitForJobGone(engine: RunEngine, jobId: string) {
  const deadline = performance.now() + 15_000;
  while ((await engine["worker"].getJob(jobId)) && performance.now() < deadline)
    await setTimeout(20);
  expect(await engine["worker"].getJob(jobId), `${jobId} never finished`).toBeFalsy();
}

function holdRunLock(engine: RunEngine, runId: string) {
  let locked!: () => void;
  let release!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const holder = engine["runLock"].lock("holdRun", [runId], async () => {
    locked();
    await released;
  });
  return {
    isLocked,
    async release() {
      release();
      await holder;
    },
  };
}

/** Kill the producer's store from the first command after `friendlyId`'s child row commits. */
function failAfterChildCommits(h: StoreBatchHarness, friendlyId: string) {
  const id = RunId.fromFriendlyId(friendlyId);
  h.faults.arm({
    mode: "throw",
    from: true,
    when: async () => (await h.prisma.taskRun.count({ where: { id } })) > 0,
  });
  return id;
}

async function status(h: StoreBatchHarness, runId: string) {
  return (await h.prisma.taskRun.findUniqueOrThrow({ where: { id: runId } })).status;
}

describe("store batchTriggerAndWait positions", () => {
  // Catches: recovery admitting a child whose first attempt lost the parent lock beside the retry's child.
  containerTest(
    "an item whose first child lost the parent lock resolves to the retry's child; the first is retired",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, {
        lockRetry,
        recoveryDelayMs: 600_000,
      });
      try {
        const { engine, env } = h;
        const b = await setupBatchParent(h, count);
        await triggerItem(h, engine, b, 0);

        const lock = holdRunLock(engine, b.parent.id);
        await lock.isLocked;
        const firstFriendlyId = newFriendlyId();
        await expect(
          triggerItem(h, h.producer, b, 1, { friendlyId: firstFriendlyId })
        ).rejects.toBeInstanceOf(LockAcquisitionTimeoutError);
        await lock.release();
        const firstId = RunId.fromFriendlyId(firstFriendlyId);

        const retry = await triggerItem(h, engine, b, 1);
        // The BatchQueue's pre-failed fallback for the same item resolves to that child too.
        const fallback = await createFailedItem(h, engine, b, 1);
        await triggerItem(h, engine, b, 2);
        // The first child's recovery comes due after the retry took the position.
        await fireRecoveryNow(h, [firstId]);
        await waitForJobGone(engine, `recoverRunWaitpoint:${firstId}`);

        const { executions } = await expectBatchResolvedOnce(h, b);
        expect(fallback.id, "the fallback did not adopt the position's child").toBe(retry.id);
        expect(executions.has(firstId)).toBe(false);
        expect(await status(h, firstId)).toBe("SYSTEM_FAILURE");
        expect(await engine.runQueue.messageExists(env.organization.id, firstId)).toBeFalsy();
        // Catches: a retired duplicate child raising a task-failure alert.
        expect(h.failed.find((e) => e.run.id === firstId)?.suppressAlerts).toBe(true);
      } finally {
        await h.close();
      }
    }
  );

  // Catches: recovery admitting a child whose producer died at a store command after it committed.
  containerTest(
    "an item whose producer fails at a store command after its child commits resolves to the retry's child",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { recoveryDelayMs: 600_000 });
      try {
        const { engine } = h;
        const b = await setupBatchParent(h, count);
        await triggerItem(h, engine, b, 0);

        const firstFriendlyId = newFriendlyId();
        const firstId = failAfterChildCommits(h, firstFriendlyId);
        await expect(
          triggerItem(h, h.producer, b, 1, { friendlyId: firstFriendlyId })
        ).rejects.toThrow();
        expect(h.faults.fired).toBe(true);
        h.faults.disarm();

        await triggerItem(h, engine, b, 1);
        await triggerItem(h, engine, b, 2);
        await fireRecoveryNow(h, [firstId]);
        await waitForJobGone(engine, `recoverRunWaitpoint:${firstId}`);

        const { executions } = await expectBatchResolvedOnce(h, b);
        expect(executions.has(firstId)).toBe(false);
        expect(await status(h, firstId)).toBe("SYSTEM_FAILURE");
      } finally {
        await h.close();
      }
    }
  );

  // Catches: a redelivered item adding a second child at a position its first child already holds.
  containerTest(
    "a redelivered item resolves to the child that already holds its position",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { recoveryDelayMs: 600_000 });
      try {
        const { engine, env } = h;
        const b = await setupBatchParent(h, count);
        await triggerItem(h, engine, b, 0);
        const first = await triggerItem(h, engine, b, 1);
        const redeliveredFriendlyId = newFriendlyId();
        const redelivered = await triggerItem(h, engine, b, 1, {
          friendlyId: redeliveredFriendlyId,
        });
        await triggerItem(h, engine, b, 2);

        const redeliveredId = RunId.fromFriendlyId(redeliveredFriendlyId);
        expect(redelivered.id, "the redelivery did not resolve to the position's child").toBe(
          first.id
        );
        expect(await status(h, redeliveredId)).toBe("SYSTEM_FAILURE");
        expect(await engine.runQueue.messageExists(env.organization.id, redeliveredId)).toBeFalsy();
        // Catches: a retired child's recovery later admitting it into a position freed by compensation.
        expect(await engine["worker"].getJob(`recoverRunWaitpoint:${redeliveredId}`)).toBeFalsy();
        await expectBatchResolvedOnce(h, b);
      } finally {
        await h.close();
      }
    }
  );

  // Catches: a pre-failed fallback adding an error result at a position a child already holds.
  containerTest(
    "a pre-failed fallback for an item whose child holds the position resolves to that child",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions);
      try {
        const { engine } = h;
        const b = await setupBatchParent(h, count);
        const owner = await triggerItem(h, engine, b, 0);
        const fallbackFriendlyId = newFriendlyId();
        const fallback = await createFailedItem(h, engine, b, 0, fallbackFriendlyId);
        await triggerItem(h, engine, b, 1);
        // A fallback at a free position is still the item's result.
        await createFailedItem(h, engine, b, 2);

        expect(fallback.id).toBe(owner.id);
        // The unused failed run still completes its trace through runFailed, without an alert.
        const unused = RunId.fromFriendlyId(fallbackFriendlyId);
        expect(await status(h, unused)).toBe("SYSTEM_FAILURE");
        expect(h.failed.filter((e) => e.run.id === unused).map((e) => e.suppressAlerts)).toEqual([
          true,
        ]);
        await expectBatchResolvedOnce(h, b, { failedIndexes: [2] });
      } finally {
        await h.close();
      }
    }
  );

  for (const association of ["legacy", "store"] as const) {
    // Catches: a cached run attached to a held position adding a second result there.
    containerTest(
      `a cached run with a ${association} association cannot take a position another child holds`,
      async ({ prisma, redisOptions }) => {
        const h = await storeBatchHarness(prisma, redisOptions);
        try {
          const { engine, env } = h;
          const b = await setupBatchParent(h, count);
          await triggerItem(h, engine, b, 0);
          const owner = await triggerItem(h, engine, b, 1);
          await triggerItem(h, engine, b, 2);

          const cached = await triggerRun(engine, env, prisma, {
            friendlyId: newFriendlyId(),
            taskIdentifier: "child-task",
            idempotencyKey: `cached-${b.batchId}`,
            payload: JSON.stringify({ i: 1, cached: true }),
          });
          // A run first waited on without a parent keeps a Postgres association.
          if (association === "legacy")
            await engine.getOrCreateRunWaitpoint({
              runId: cached.id,
              projectId: env.project.id,
              environmentId: env.id,
            });
          // Catches: the item resolving to the cached run while the parent receives the owner's result.
          const attached = await attachCachedRun(h, engine, b, 1, cached);
          expect(attached.id, "the attach did not resolve to the position's run").toBe(owner.id);

          await expectBatchResolvedOnce(h, b, { ignoreRunIds: [cached.id] });
        } finally {
          await h.close();
        }
      }
    );

    // Catches: a retry child refused a position held by a cached run not resolving to that run.
    containerTest(
      `a retried item resolves to the cached run with a ${association} association that holds its position`,
      async ({ prisma, redisOptions }) => {
        const h = await storeBatchHarness(prisma, redisOptions);
        try {
          const { engine, env } = h;
          const b = await setupBatchParent(h, count);
          await triggerItem(h, engine, b, 0);
          const cached = await triggerRun(engine, env, prisma, {
            friendlyId: newFriendlyId(),
            taskIdentifier: "child-task",
            idempotencyKey: `cached-${b.batchId}`,
            payload: itemPayload(1),
          });
          if (association === "legacy")
            await engine.getOrCreateRunWaitpoint({
              runId: cached.id,
              projectId: env.project.id,
              environmentId: env.id,
            });
          await attachCachedRun(h, engine, b, 1, cached);
          const retry = await triggerItem(h, engine, b, 1);
          await triggerItem(h, engine, b, 2);

          expect(retry.id, "the retry did not resolve to the cached run").toBe(cached.id);
          await expectBatchResolvedOnce(h, b, { extraRunIds: [cached.id] });
        } finally {
          await h.close();
        }
      }
    );
  }

  // Catches: a debounced item redelivered after another child took its position adding a result.
  containerTest(
    "a debounced item whose position another child holds resolves to that child",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions);
      try {
        const { engine, env } = h;
        const b = await setupBatchParent(h, count);
        const owner = await triggerItem(h, engine, b, 0);
        await triggerItem(h, engine, b, 1);
        await triggerItem(h, engine, b, 2);
        // An existing debounced run attaching at a held position.
        const debounce = { key: `debounce-${b.batchId}`, delay: "30s" };
        const existing = await triggerRun(engine, env, prisma, {
          friendlyId: newFriendlyId(),
          taskIdentifier: "child-task",
          debounce,
          delayUntil: new Date(Date.now() + 30_000),
          payload: JSON.stringify({ debounced: true }),
        });
        const debounced = await triggerItem(h, engine, b, 0, {
          debounce,
          delayUntil: new Date(Date.now() + 30_000),
        });
        expect(debounced.id).toBe(owner.id);
        await expectBatchResolvedOnce(h, b, { ignoreRunIds: [existing.id] });
      } finally {
        await h.close();
      }
    }
  );

  // Catches: recovery publishing a child after its batch finished when the parent never held its edge.
  containerTest(
    "recovery that fires after the batch finished retires a child that never reached its position",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { recoveryDelayMs: 600_000 });
      try {
        const { engine, env } = h;
        const b = await setupBatchParent(h, count);
        await triggerItem(h, engine, b, 0);
        const firstFriendlyId = newFriendlyId();
        const firstId = failAfterChildCommits(h, firstFriendlyId);
        await expect(
          triggerItem(h, h.producer, b, 1, { friendlyId: firstFriendlyId })
        ).rejects.toThrow();
        h.faults.disarm();
        await triggerItem(h, engine, b, 1);
        await triggerItem(h, engine, b, 2);

        await expectBatchResolvedOnce(h, b, { extraRunIds: [firstId], lateRecovery: true });
        await fireRecoveryNow(h, [firstId]);
        await waitForJobGone(engine, `recoverRunWaitpoint:${firstId}`);
        expect(await status(h, firstId)).toBe("SYSTEM_FAILURE");
        expect(await engine.runQueue.messageExists(env.organization.id, firstId)).toBeFalsy();
      } finally {
        await h.close();
      }
    }
  );

  // Catches: recovery retiring an admitted child because its registration evidence was finalized.
  containerTest(
    "recovery publishes an admitted child whose producer could not publish it",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { recoveryDelayMs: 600_000 });
      try {
        const { engine, env } = h;
        const b = await setupBatchParent(h, count);
        await triggerItem(h, engine, b, 0);
        await triggerItem(h, engine, b, 2);
        // Item 1's child is admitted and finalized, then its producer dies before publishing it.
        const friendlyId = newFriendlyId();
        const childId = RunId.fromFriendlyId(friendlyId);
        h.producer.eventBus.on("executionSnapshotCreated", ({ run }) => {
          if (run.id === childId) throw new Error("producer died");
        });
        await expect(triggerItem(h, h.producer, b, 1, { friendlyId })).rejects.toThrow();
        expect(
          await h.redis.hexists(
            runBlockKeys(b.parent.id).edge,
            edgeField(deriveRunWaitpointId(childId)!, 1)
          )
        ).toBe(1);
        expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBeFalsy();

        await expectBatchResolvedOnce(h, b, { lateRecovery: true });
      } finally {
        await h.close();
      }
    }
  );
  // Catches: recovery retiring a child whose stalled producer still admits it, failing the item.
  containerTest(
    "a producer stalled past its child's recovery still yields one result and one execution",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { stallTimeoutMs: 30_000 });
      let original: Promise<{ id: string }> | undefined;
      try {
        const { engine } = h;
        const b = await setupBatchParent(h, count);
        await triggerItem(h, engine, b, 0);
        const friendlyId = newFriendlyId();
        const childId = RunId.fromFriendlyId(friendlyId);
        h.faults.arm({
          mode: "stall",
          when: async () => (await prisma.taskRun.count({ where: { id: childId } })) > 0,
        });
        original = triggerItem(h, h.producer, b, 1, { friendlyId });
        void original.catch(() => {});
        await h.faults.stall;
        await waitForJobGone(engine, `recoverRunWaitpoint:${childId}`);
        h.barrier.release();
        expect((await original).id).toBe(childId);
        await triggerItem(h, engine, b, 2);

        const { executions } = await expectBatchResolvedOnce(h, b);
        expect(executions.get(childId)).toBe(1);
      } finally {
        h.barrier.release();
        await original?.catch(() => {});
        await h.close();
      }
    }
  );

  // Catches: an index left with no result when every attempt and the fallback lost the parent lock.
  containerTest(
    "an item whose every attempt and fallback lost the parent lock resolves to its first child",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, {
        lockRetry,
        recoveryDelayMs: 600_000,
      });
      try {
        const { engine } = h;
        const b = await setupBatchParent(h, count);
        await triggerItem(h, engine, b, 0);
        await triggerItem(h, engine, b, 2);

        const lock = holdRunLock(engine, b.parent.id);
        await lock.isLocked;
        const ids = [newFriendlyId(), newFriendlyId(), newFriendlyId()];
        for (const friendlyId of ids.slice(0, 2))
          await expect(triggerItem(h, h.producer, b, 1, { friendlyId })).rejects.toBeInstanceOf(
            LockAcquisitionTimeoutError
          );
        await expect(createFailedItem(h, h.producer, b, 1, ids[2])).rejects.toBeInstanceOf(
          LockAcquisitionTimeoutError
        );
        await lock.release();
        // Nothing will retry the item. Recovery comes due for its first child first.
        const [firstId, ...rest] = ids.map((id) => RunId.fromFriendlyId(id));
        await fireRecoveryNow(h, [firstId!]);
        await waitForJobGone(engine, `recoverRunWaitpoint:${firstId}`);
        await fireRecoveryNow(h, rest);

        const { executions } = await expectBatchResolvedOnce(h, b);
        expect(executions.get(firstId!)).toBe(1);
        for (const id of rest) expect(await status(h, id)).toBe("SYSTEM_FAILURE");
      } finally {
        await h.close();
      }
    }
  );

  // Catches: a legacy-format child under a native header bypassing position ownership.
  containerTest(
    "legacy-format children under a native header own their positions, and a legacy retirement still alerts",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { lockRetry });
      try {
        const { engine } = h;
        const b = await setupBatchParent(h, count);
        // RUN mint falls back to Postgres after the native header was created.
        h.setRunMintReady(false);

        const lock = holdRunLock(engine, b.parent.id);
        await lock.isLocked;
        const lostFriendlyId = newFriendlyId();
        await expect(
          triggerItem(h, h.producer, b, 0, { friendlyId: lostFriendlyId })
        ).rejects.toBeInstanceOf(LockAcquisitionTimeoutError);
        await lock.release();
        const lostId = RunId.fromFriendlyId(lostFriendlyId);
        // The existing legacy retirement path is unchanged: it still alerts.
        const lostEvent = h.failed.find((e) => e.run.id === lostId);
        expect(lostEvent).toBeDefined();
        expect(lostEvent?.suppressAlerts).toBeUndefined();

        await triggerItem(h, engine, b, 0);
        const first = await triggerItem(h, engine, b, 1);
        expect(await prisma.waitpoint.count({ where: { completedByTaskRunId: first.id } })).toBe(1);
        const redeliveredFriendlyId = newFriendlyId();
        const redelivered = await triggerItem(h, engine, b, 1, {
          friendlyId: redeliveredFriendlyId,
        });
        expect(redelivered.id, "the redelivery did not resolve to the position's child").toBe(
          first.id
        );
        expect(await status(h, RunId.fromFriendlyId(redeliveredFriendlyId))).toBe("SYSTEM_FAILURE");
        await triggerItem(h, engine, b, 2);

        await expectBatchResolvedOnce(h, b, { alertedRunIds: [lostId] });
      } finally {
        await h.close();
      }
    }
  );
  // Catches: a failed retirement in recovery acking the job, leaving an unqueued PENDING child
  // that blocks batch completion forever.
  containerTest(
    "a recovery retirement that fails once is retried, and the batch still resolves",
    async ({ prisma, redisOptions }) => {
      const firstFriendlyId = newFriendlyId();
      const firstId = RunId.fromFriendlyId(firstFriendlyId);
      // The first attempt to release this child's key fails in Postgres. A sequence counts the
      // attempts outside the failing transaction. Installed before any engine holds a TaskRun lock.
      await prisma.$executeRawUnsafe(`CREATE SEQUENCE test_retire_fault`);
      await prisma.$executeRawUnsafe(`CREATE FUNCTION test_retire_fault() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.id = '${firstId}' AND OLD."idempotencyKey" IS NOT NULL AND NEW."idempotencyKey" IS NULL
            AND nextval('test_retire_fault') = 1 THEN
            RAISE EXCEPTION 'injected retirement fault';
          END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER test_retire_fault BEFORE UPDATE ON "TaskRun"
        FOR EACH ROW EXECUTE FUNCTION test_retire_fault()`);
      const h = await storeBatchHarness(prisma, redisOptions, {
        lockRetry,
        recoveryDelayMs: 600_000,
      });
      try {
        const { engine } = h;
        const b = await setupBatchParent(h, count);
        await triggerItem(h, engine, b, 0);

        const lock = holdRunLock(engine, b.parent.id);
        await lock.isLocked;
        await expect(
          triggerItem(h, h.producer, b, 1, {
            friendlyId: firstFriendlyId,
            idempotencyKey: `first-${b.batchId}`,
          })
        ).rejects.toBeInstanceOf(LockAcquisitionTimeoutError);
        await lock.release();
        await triggerItem(h, engine, b, 1);
        await triggerItem(h, engine, b, 2);

        await fireRecoveryNow(h, [firstId]);
        await waitForJobGone(engine, `recoverRunWaitpoint:${firstId}`);
        const [attempts] = await prisma.$queryRawUnsafe<{ last_value: bigint }[]>(
          `SELECT last_value FROM test_retire_fault`
        );
        expect(Number(attempts!.last_value), "the retirement was not retried").toBe(2);
        expect(await status(h, firstId)).toBe("SYSTEM_FAILURE");

        const { executions } = await expectBatchResolvedOnce(h, b);
        expect(executions.has(firstId)).toBe(false);
      } finally {
        await h.close();
      }
    }
  );
});

describe("store batch item after its batch finished", () => {
  // Catches: an item delivered after its batch completed publishing a second child for a finished
  // index (store format), or the same through the legacy-format child path under a native header.
  for (const format of ["store", "legacy"] as const) {
    containerTest(
      `${format}-format: an item delivered after the parent resumed from its batch does not queue a new child`,
      async ({ prisma, redisOptions }) => {
        const h = await storeBatchHarness(prisma, redisOptions, { recoveryDelayMs: 600_000 });
        try {
          const { engine, env } = h;
          const b = await setupBatchParent(h, count);
          const owners: TaskRun[] = [];
          for (let i = 0; i < count; i++) owners.push(await triggerItem(h, engine, b, i));
          await prisma.batchTaskRun.update({
            where: { id: b.batchId },
            data: { successfulRunCount: count },
          });
          // Execute the children until the parent resumes from the batch.
          const deadline = performance.now() + 30_000;
          let data = await engine.getRunExecutionData({ runId: b.parent.id });
          while (data?.snapshot.executionStatus !== "EXECUTING" && performance.now() < deadline) {
            for (const message of await engine.dequeueFromWorkerQueue({
              consumerId: "children",
              workerQueue: "main",
              blockingPopTimeoutSeconds: 0.2,
            })) {
              const attempt = await engine.startRunAttempt({
                runId: message.run.id,
                snapshotId: message.snapshot.id,
              });
              await engine.completeRunAttempt({
                runId: message.run.id,
                snapshotId: attempt.snapshot.id,
                completion: {
                  id: message.run.id,
                  ok: true,
                  output: "{}",
                  outputType: "application/json",
                },
              });
            }
            await engine.tryCompleteBatch({
              batchId: b.batchId,
              organizationId: env.organization.id,
            });
            data = await engine.getRunExecutionData({ runId: b.parent.id });
          }
          expect(data?.snapshot.executionStatus, "parent never resumed").toBe("EXECUTING");

          // RUN mint falls back to Postgres after the native header was created.
          if (format === "legacy") h.setRunMintReady(false);
          // The stalled or redelivered attempt for index 1 arrives now.
          const lateFriendlyId = newFriendlyId();
          const lateId = RunId.fromFriendlyId(lateFriendlyId);
          const late = await triggerItem(h, engine, b, 1, { friendlyId: lateFriendlyId });
          expect(
            await engine.runQueue.messageExists(env.organization.id, lateId),
            "the late child was queued for a finished index"
          ).toBeFalsy();
          const dequeued = await engine.dequeueFromWorkerQueue({
            consumerId: "children",
            workerQueue: "main",
            blockingPopTimeoutSeconds: 0.2,
          });
          expect(
            dequeued.map((m) => m.run.id),
            "a child was dequeued after the batch finished"
          ).toEqual([]);
          // Nothing holds the position any more: the item resolves to its retired child.
          expect(late.id).toBe(lateId);
          const legacyRows = await prisma.waitpoint.count({
            where: { completedByTaskRunId: lateId },
          });
          expect(legacyRows, "the late child took the wrong waitpoint format").toBe(
            format === "legacy" ? 1 : 0
          );
          expect(await status(h, lateId)).toBe("SYSTEM_FAILURE");
          expect(h.failed.filter((e) => e.run.id === lateId).map((e) => e.suppressAlerts)).toEqual([
            true,
          ]);
          expect(await engine["worker"].getJob(`recoverRunWaitpoint:${lateId}`)).toBeFalsy();
          expect(owners[1].id).not.toBe(lateId);
        } finally {
          await h.close();
        }
      }
    );
  }
});

describe("store triggerAndWait recovery", () => {
  // Catches: a single triggerAndWait failing after its parent accepted the child's edge, so the
  // SDK retry runs a second child.
  containerTest(
    "a single triggerAndWait whose registration fails after the parent accepted it runs one child",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions);
      try {
        const { engine, producer, env } = h;
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: newFriendlyId(),
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, `parent-${parent.id}`);
        const child = (on: RunEngine) => {
          const friendlyId = newFriendlyId();
          return triggerRun(on, env, prisma, {
            friendlyId,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
            payload: JSON.stringify({ friendlyId }),
          });
        };

        const edgeKey = runBlockKeys(parent.id).edge;
        // Fail the first store command after the parent durably absorbed the child's edge.
        h.faults.arm({ mode: "throw", when: async () => (await h.redis.hlen(edgeKey)) > 0 });
        // The SDK retries a failed unkeyed trigger as a fresh request with a fresh child id.
        await child(producer).catch(() => child(engine));
        expect(h.faults.fired, "fault never fired").toBe(true);
        const children = await prisma.taskRun.findMany({ where: { parentTaskRunId: parent.id } });
        await fireRecoveryNow(
          h,
          children.map((c) => c.id)
        );

        const executions = new Map<string, number>();
        const deadline = performance.now() + 30_000;
        let data = await engine.getRunExecutionData({ runId: parent.id });
        while (data?.snapshot.executionStatus !== "EXECUTING" && performance.now() < deadline) {
          for (const message of await engine.dequeueFromWorkerQueue({
            consumerId: "children",
            workerQueue: "main",
            blockingPopTimeoutSeconds: 0.2,
          })) {
            executions.set(message.run.id, (executions.get(message.run.id) ?? 0) + 1);
            const attempt = await engine.startRunAttempt({
              runId: message.run.id,
              snapshotId: message.snapshot.id,
            });
            await engine.completeRunAttempt({
              runId: message.run.id,
              snapshotId: attempt.snapshot.id,
              completion: {
                id: message.run.id,
                ok: true,
                output: "{}",
                outputType: "application/json",
              },
            });
          }
          data = await engine.getRunExecutionData({ runId: parent.id });
        }
        expect(data?.snapshot.executionStatus, "parent never resumed").toBe("EXECUTING");
        expect([...executions.keys()], "children executed for one triggerAndWait").toHaveLength(1);
        expect(data?.completedWaitpoints.filter((w) => w.type === "RUN")).toHaveLength(1);
      } finally {
        await h.close();
      }
    }
  );
  // Catches: recovery publishing a single child its parent never waited on.
  containerTest(
    "recovery retires a single child the parent never admitted, and publishes one it did",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions);
      try {
        const { engine, env } = h;
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: newFriendlyId(),
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, `parent-${parent.id}`);

        const orphanFriendlyId = newFriendlyId();
        const orphanId = failAfterChildCommits(h, orphanFriendlyId);
        await expect(
          triggerRun(h.producer, env, prisma, {
            friendlyId: orphanFriendlyId,
            taskIdentifier: "child-task",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
          })
        ).rejects.toThrow();
        h.faults.disarm();
        await waitForJobGone(engine, `recoverRunWaitpoint:${orphanId}`);
        expect(await status(h, orphanId)).toBe("SYSTEM_FAILURE");
        expect(await engine.runQueue.messageExists(env.organization.id, orphanId)).toBeFalsy();

        const child = await triggerRun(engine, env, prisma, {
          friendlyId: newFriendlyId(),
          taskIdentifier: "child-task",
          parentTaskRunId: parent.id,
          resumeParentOnCompletion: true,
        });
        expect(await engine.runQueue.messageExists(env.organization.id, child.id)).toBeTruthy();
        expect(await status(h, child.id)).toBe("PENDING");
      } finally {
        await h.close();
      }
    }
  );
  // Catches: a producer delayed past recovery admitting the child recovery retired, failing the wait.
  containerTest(
    "a producer stalled past recovery is refused for retry, and the retried wait runs one child",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { stallTimeoutMs: 30_000 });
      let original: Promise<unknown> | undefined;
      try {
        const { engine, env } = h;
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: newFriendlyId(),
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, `parent-${parent.id}`);
        const friendlyId = newFriendlyId();
        const childId = RunId.fromFriendlyId(friendlyId);
        h.faults.arm({
          mode: "stall",
          when: async () => (await prisma.taskRun.count({ where: { id: childId } })) > 0,
        });
        const child = { taskIdentifier: "child-task", parentTaskRunId: parent.id };
        original = triggerRun(h.producer, env, prisma, {
          ...child,
          friendlyId,
          resumeParentOnCompletion: true,
          payload: '"first"',
        });
        void original.catch(() => {});
        await h.faults.stall;
        await waitForJobGone(engine, `recoverRunWaitpoint:${childId}`);
        expect(await status(h, childId)).toBe("SYSTEM_FAILURE");
        h.barrier.release();
        await expect(original).rejects.toMatchObject({ status: 503 });

        // The caller retries the trigger, which waits on a new child.
        const retry = await triggerRun(engine, env, prisma, {
          ...child,
          friendlyId: newFriendlyId(),
          resumeParentOnCompletion: true,
          payload: '"retry"',
        });
        const attempt = await dequeueAndStart(engine, "retried-child");
        expect(attempt.run.id).toBe(retry.id);
        await engine.completeRunAttempt({
          runId: retry.id,
          snapshotId: attempt.snapshot.id,
          completion: { id: retry.id, ok: true, output: '"retry"', outputType: "application/json" },
        });
        await expect
          .poll(
            async () =>
              (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus,
            { timeout: 10_000, interval: 50, message: "parent never resumed" }
          )
          .toBe("EXECUTING");
        const resumed = await engine.getRunExecutionData({ runId: parent.id });
        expect(
          resumed!.completedWaitpoints
            .filter((w) => w.type === "RUN")
            .map((w) => [w.completedByTaskRun?.id, w.output])
        ).toEqual([[retry.id, '"retry"']]);
        expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBeFalsy();
      } finally {
        h.barrier.release();
        await original?.catch(() => {});
        await h.close();
      }
    }
  );

  for (const order of ["retired first", "attached first"] as const) {
    // Catches: a cached attach racing recovery giving a waiting parent a retired child's failure.
    containerTest(
      `a cached attach to an unadmitted child with recovery ${order} never receives a retirement`,
      async ({ prisma, redisOptions }) => {
        const h = await storeBatchHarness(prisma, redisOptions, { recoveryDelayMs: 600_000 });
        try {
          const { engine, env } = h;
          const parents = [];
          for (const name of ["birth", "cached"]) {
            const run = await triggerRun(engine, env, prisma, {
              friendlyId: newFriendlyId(),
              taskIdentifier: "parent-task",
            });
            await dequeueAndStart(engine, `${name}-${run.id}`);
            parents.push(run);
          }
          const [birthParent, cachedParent] = parents as [TaskRun, TaskRun];
          const friendlyId = newFriendlyId();
          const childId = failAfterChildCommits(h, friendlyId);
          await expect(
            triggerRun(h.producer, env, prisma, {
              friendlyId,
              taskIdentifier: "child-task",
              parentTaskRunId: birthParent.id,
              resumeParentOnCompletion: true,
              idempotencyKey: `shared-${friendlyId}`,
            })
          ).rejects.toThrow();
          h.faults.disarm();
          const cached = await prisma.taskRun.findUniqueOrThrow({ where: { id: childId } });
          const waitpointId = deriveRunWaitpointId(childId)!;
          const attach = async () => {
            await engine.getOrCreateRunWaitpoint({
              runId: childId,
              projectId: env.project.id,
              environmentId: env.id,
              blockingParentRunId: cachedParent.id,
              organizationId: env.organization.id,
            });
            const blockOperation = await engine.waitpointSystem.buildStoreBlockOperation({
              runId: cachedParent.id,
              waitpointId,
              organizationId: env.organization.id,
            });
            return engine.blockRunWithCachedRun({
              cachedRun: cached,
              runId: cachedParent.id,
              waitpoints: waitpointId,
              projectId: env.project.id,
              organizationId: env.organization.id,
              blockOperation,
            });
          };
          const recover = async () => {
            await fireRecoveryNow(h, [childId]);
            await waitForJobGone(engine, `recoverRunWaitpoint:${childId}`);
          };

          if (order === "retired first") {
            await recover();
            expect(await status(h, childId)).toBe("SYSTEM_FAILURE");
            // The stale cache hit is refused for retry rather than attached to the retirement.
            await expect(attach()).rejects.toMatchObject({ status: 503 });
            expect((await h.store.readBlockState(cachedParent.id)).edges).toEqual([]);
            return;
          }
          await attach();
          await recover();
          // The attached parent waits on the child, so recovery publishes it.
          const attempt = await dequeueAndStart(engine, "shared-child");
          expect(attempt.run.id).toBe(childId);
          await engine.completeRunAttempt({
            runId: childId,
            snapshotId: attempt.snapshot.id,
            completion: { id: childId, ok: true, output: '"ok"', outputType: "application/json" },
          });
          await expect
            .poll(
              async () =>
                (await engine.getRunExecutionData({ runId: cachedParent.id }))?.completedWaitpoints
                  .filter((w) => w.id === waitpointId)
                  .map((w) => w.outputIsError),
              { timeout: 10_000, interval: 50, message: "cached parent never got the result" }
            )
            .toEqual([false]);
        } finally {
          await h.close();
        }
      }
    );
  }
  // Catches: birth recovery retiring a keyed child another parent accepted but never watched.
  containerTest(
    "a cached attach that fails after its blocked snapshot still receives the child's result",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { recoveryDelayMs: 600_000 });
      try {
        const { engine, producer, env } = h;
        const parents = [];
        for (const name of ["birth", "cached"]) {
          const run = await triggerRun(engine, env, prisma, {
            friendlyId: newFriendlyId(),
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, `${name}-${run.id}`);
          parents.push(run);
        }
        const [birthParent, cachedParent] = parents as [TaskRun, TaskRun];
        const friendlyId = newFriendlyId();
        const childId = failAfterChildCommits(h, friendlyId);
        await expect(
          triggerRun(h.producer, env, prisma, {
            friendlyId,
            taskIdentifier: "child-task",
            parentTaskRunId: birthParent.id,
            resumeParentOnCompletion: true,
            idempotencyKey: `shared-${friendlyId}`,
          })
        ).rejects.toThrow();
        h.faults.disarm();
        const cached = await prisma.taskRun.findUniqueOrThrow({ where: { id: childId } });
        const waitpointId = deriveRunWaitpointId(childId)!;
        await producer.getOrCreateRunWaitpoint({
          runId: childId,
          projectId: env.project.id,
          environmentId: env.id,
          blockingParentRunId: cachedParent.id,
          organizationId: env.organization.id,
        });
        const blockOperation = await producer.waitpointSystem.buildStoreBlockOperation({
          runId: cachedParent.id,
          waitpointId,
          organizationId: env.organization.id,
        });
        // Fail B's first store command after its blocked snapshot commits: watcher registration.
        h.faults.arm({
          mode: "throw",
          when: async () =>
            (await engine.getRunExecutionData({ runId: cachedParent.id }))?.snapshot
              .executionStatus === "EXECUTING_WITH_WAITPOINTS",
        });
        await expect(
          producer.blockRunWithCachedRun({
            cachedRun: cached,
            runId: cachedParent.id,
            waitpoints: waitpointId,
            projectId: env.project.id,
            organizationId: env.organization.id,
            blockOperation,
          })
        ).rejects.toThrow("injected store fault");
        h.faults.disarm();
        expect((await h.store.readBlockState(cachedParent.id)).edges).toHaveLength(1);

        // The birth parent's older recovery runs before B's block recovery: it must wait for B's
        // registration, not retire the child.
        const birthJob = `recoverRunWaitpoint:${childId}`;
        await fireRecoveryNow(h, [childId]);
        await expect
          .poll(
            async () => {
              const job = await engine["worker"].getJob(birthJob);
              return !job || job.attempt > 0;
            },
            { timeout: 15_000, interval: 20, message: "the birth recovery never ran" }
          )
          .toBe(true);
        expect(await status(h, childId), "recovery retired a child B accepted").not.toBe(
          "SYSTEM_FAILURE"
        );
        const blockJob = `recoverWaitpointBlock:${cachedParent.id}:${blockOperation.absorptionId}`;
        expect(await engine["worker"].getJob(blockJob)).toBeTruthy();
        await engine["worker"].reschedule(blockJob, new Date());
        await waitForJobGone(engine, blockJob);
        // B's watcher is registered: the retried birth recovery publishes the child.
        await fireRecoveryNow(h, [childId]);
        await waitForJobGone(engine, birthJob);

        const attempt = await dequeueAndStart(engine, "shared-child");
        expect(attempt.run.id).toBe(childId);
        await engine.completeRunAttempt({
          runId: childId,
          snapshotId: attempt.snapshot.id,
          completion: { id: childId, ok: true, output: '"ok"', outputType: "application/json" },
        });
        await expect
          .poll(
            async () =>
              (await engine.getRunExecutionData({ runId: cachedParent.id }))?.completedWaitpoints
                .filter((w) => w.id === waitpointId)
                .map((w) => w.outputIsError),
            { timeout: 10_000, interval: 50, message: "cached parent never got the result" }
          )
          .toEqual([false]);
      } finally {
        await h.close();
      }
    }
  );
  // Catches: the trigger retiring a refused keyed batch child that another parent attached to
  // between its commit and the retirement.
  containerTest(
    "a refused keyed batch child another parent attached to is kept and delivers its result",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions, { recoveryDelayMs: 600_000 });
      try {
        const { engine, env } = h;
        const b = await setupBatchParent(h, count);
        // An unkeyed pre-failed run already holds position 1.
        const holder = await createFailedItem(h, engine, b, 1);
        const other = await triggerRun(engine, env, prisma, {
          friendlyId: newFriendlyId(),
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, `other-${other.id}`);

        const friendlyId = newFriendlyId();
        const childId = RunId.fromFriendlyId(friendlyId);
        const waitpointId = deriveRunWaitpointId(childId)!;
        // Another parent finds the child by its key once it commits, before the item settles.
        h.faults.arm({
          mode: "throw",
          when: async () => (await prisma.taskRun.count({ where: { id: childId } })) > 0,
          run: async () => {
            const cached = await prisma.taskRun.findUniqueOrThrow({ where: { id: childId } });
            await engine.getOrCreateRunWaitpoint({
              runId: childId,
              projectId: env.project.id,
              environmentId: env.id,
              blockingParentRunId: other.id,
              organizationId: env.organization.id,
            });
            await engine.blockRunWithCachedRun({
              cachedRun: cached,
              runId: other.id,
              waitpoints: waitpointId,
              projectId: env.project.id,
              organizationId: env.organization.id,
              blockOperation: await engine.waitpointSystem.buildStoreBlockOperation({
                runId: other.id,
                waitpointId,
                organizationId: env.organization.id,
              }),
            });
          },
        });
        const item = await triggerItem(h, h.producer, b, 1, {
          friendlyId,
          idempotencyKey: `shared-${friendlyId}`,
        });
        expect(h.faults.fired, "the other parent never attached").toBe(true);
        expect(item.id, "the item did not resolve to the position's run").toBe(holder.id);
        expect(
          await status(h, childId),
          "the trigger retired a child another parent awaits"
        ).not.toBe("SYSTEM_FAILURE");

        // The child's recovery publishes it for the other parent.
        await fireRecoveryNow(h, [childId]);
        await waitForJobGone(engine, `recoverRunWaitpoint:${childId}`);
        const attempt = await dequeueAndStart(engine, "shared-child");
        expect(attempt.run.id).toBe(childId);
        await engine.completeRunAttempt({
          runId: childId,
          snapshotId: attempt.snapshot.id,
          completion: { id: childId, ok: true, output: '"ok"', outputType: "application/json" },
        });
        await expect
          .poll(
            async () =>
              (await engine.getRunExecutionData({ runId: other.id }))?.completedWaitpoints
                .filter((w) => w.id === waitpointId)
                .map((w) => w.outputIsError),
            { timeout: 10_000, interval: 50, message: "the other parent never got the result" }
          )
          .toEqual([false]);
      } finally {
        await h.close();
      }
    }
  );
  for (const state of ["DELAYED", "PENDING_VERSION"] as const) {
    // Catches: recovery failing to retire a never-admitted child that is delayed or parked.
    containerTest(
      `recovery retires a never-admitted ${state} child that nothing waits on`,
      async ({ prisma, redisOptions }) => {
        const h = await storeBatchHarness(prisma, redisOptions);
        try {
          const { engine, env } = h;
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: newFriendlyId(),
            taskIdentifier: "parent-task",
          });
          await dequeueAndStart(engine, `parent-${parent.id}`);

          const friendlyId = newFriendlyId();
          const childId = failAfterChildCommits(h, friendlyId);
          await expect(
            triggerRun(h.producer, env, prisma, {
              friendlyId,
              taskIdentifier: "child-task",
              parentTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              ...(state === "DELAYED"
                ? { delayUntil: new Date(Date.now() + 60_000) }
                : { parkedOnExternalDeploymentId: `deployment-${friendlyId}` }),
            })
          ).rejects.toThrow();
          h.faults.disarm();
          expect(await status(h, childId)).toBe(state);

          await waitForJobGone(engine, `recoverRunWaitpoint:${childId}`);
          expect(await status(h, childId)).toBe("SYSTEM_FAILURE");
          expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBeFalsy();
          expect(h.failed.filter((e) => e.run.id === childId).map((e) => e.suppressAlerts)).toEqual(
            [true]
          );
          expect(
            (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
          ).toBe("EXECUTING");
        } finally {
          await h.close();
        }
      }
    );
  }
});

describe("store batch positions with the waitpoint store disabled", () => {
  // Catches: a disabled organization's batch items still issuing waitpoint store commands.
  containerTest(
    "items of a native batch created while enabled issue no store commands once disabled",
    async ({ prisma, redisOptions }) => {
      const h = await storeBatchHarness(prisma, redisOptions);
      try {
        const { env } = h;
        const b = await setupBatchParent(h, count);
        const positionsBefore = await positionFields(h, b.parent.id);
        const cached = await triggerRun(h.engine, env, prisma, {
          friendlyId: newFriendlyId(),
          taskIdentifier: "child-task",
          idempotencyKey: `cached-${b.batchId}`,
        });

        h.setStoreEnabled(false);
        h.faults.arm({ at: 0, mode: "throw" });
        await triggerItem(h, h.producer, b, 0);
        await triggerItem(h, h.producer, b, 0);
        await createFailedItem(h, h.producer, b, 1);
        await attachCachedRun(h, h.producer, b, 2, cached);
        expect(h.faults.commands, "store commands issued while the store was disabled").toBe(0);
        expect(await positionFields(h, b.parent.id)).toEqual(positionsBefore);
      } finally {
        await h.close();
      }
    }
  );
});
