import { batch, logger, queue, task } from "@trigger.dev/sdk";
import { setTimeout } from "node:timers/promises";

// Queue with concurrency limit for CK tests
const ckQueue = queue({
  name: "ck-test-queue",
  concurrencyLimit: 2,
});

// Worker task: simulates work with a concurrency key
export const ckWorkerTask = task({
  id: "ck-worker-task",
  queue: ckQueue,
  retry: { maxAttempts: 1 },
  run: async (payload: { id: string; waitMs: number }) => {
    const startedAt = Date.now();
    logger.info(`CK worker ${payload.id} started`);
    await setTimeout(payload.waitMs);
    const completedAt = Date.now();
    logger.info(`CK worker ${payload.id} completed`);
    return { id: payload.id, startedAt, completedAt };
  },
});

// Test 1: Multiple CKs should each get their own concurrency slot
export const ckBasicTest = task({
  id: "ck-basic-test",
  retry: { maxAttempts: 1 },
  maxDuration: 120,
  run: async () => {
    logger.info("Testing basic CK behavior: multiple CKs run concurrently");

    // Trigger 3 runs with different CKs - all should be able to run
    // because each CK gets its own concurrency tracking
    const results = await batch.triggerAndWait([
      {
        id: ckWorkerTask.id,
        payload: { id: "user-1", waitMs: 3000 },
        options: { concurrencyKey: "user-1" },
      },
      {
        id: ckWorkerTask.id,
        payload: { id: "user-2", waitMs: 3000 },
        options: { concurrencyKey: "user-2" },
      },
      {
        id: ckWorkerTask.id,
        payload: { id: "user-3", waitMs: 3000 },
        options: { concurrencyKey: "user-3" },
      },
    ]);

    if (!results.runs.every((r) => r.ok)) {
      throw new Error("Not all CK runs completed successfully");
    }

    const executions = results.runs
      .map((r) => r.output)
      .sort((a, b) => a.startedAt - b.startedAt);

    logger.info("CK basic test executions", { executions });

    return { executions };
  },
});

// Test 2: Same CK should respect concurrency limit
export const ckSameConcurrencyTest = task({
  id: "ck-same-concurrency-test",
  retry: { maxAttempts: 1 },
  maxDuration: 120,
  run: async () => {
    logger.info("Testing same CK concurrency: runs with same CK respect queue limit");

    // Trigger 4 runs all with the same CK
    // Queue limit is 2, so at most 2 should run concurrently
    const results = await batch.triggerAndWait([
      {
        id: ckWorkerTask.id,
        payload: { id: "same-1", waitMs: 4000 },
        options: { concurrencyKey: "shared-key" },
      },
      {
        id: ckWorkerTask.id,
        payload: { id: "same-2", waitMs: 4000 },
        options: { concurrencyKey: "shared-key" },
      },
      {
        id: ckWorkerTask.id,
        payload: { id: "same-3", waitMs: 4000 },
        options: { concurrencyKey: "shared-key" },
      },
      {
        id: ckWorkerTask.id,
        payload: { id: "same-4", waitMs: 4000 },
        options: { concurrencyKey: "shared-key" },
      },
    ]);

    if (!results.runs.every((r) => r.ok)) {
      throw new Error("Not all same-CK runs completed successfully");
    }

    const executions = results.runs
      .map((r) => r.output)
      .sort((a, b) => a.startedAt - b.startedAt);

    // Check max concurrent: with same CK and limit 2, should be <= 2
    let maxConcurrent = 0;
    for (const current of executions) {
      const concurrent = executions.filter(
        (e) =>
          e.startedAt <= current.startedAt &&
          e.completedAt > current.startedAt
      ).length;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }

    logger.info("Same CK concurrency result", { maxConcurrent, executions });

    if (maxConcurrent > 2) {
      throw new Error(`Expected max 2 concurrent with same CK, got ${maxConcurrent}`);
    }

    return { executions, maxConcurrent };
  },
});

// Test 3: Many CKs - the scenario that motivated the CK index
export const ckManyKeysTest = task({
  id: "ck-many-keys-test",
  retry: { maxAttempts: 1 },
  maxDuration: 180,
  run: async () => {
    logger.info("Testing many CKs: all should complete without starving");

    // Trigger 20 runs each with a different CK
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: ckWorkerTask.id,
      payload: { id: `prospect-${i}`, waitMs: 2000 },
      options: { concurrencyKey: `prospect-${i}` },
    }));

    const results = await batch.triggerAndWait(items);

    const succeeded = results.runs.filter((r) => r.ok).length;
    const failed = results.runs.filter((r) => !r.ok).length;

    logger.info("Many CKs test result", { succeeded, failed, total: results.runs.length });

    if (failed > 0) {
      throw new Error(`${failed} of ${results.runs.length} runs failed`);
    }

    return { succeeded, total: results.runs.length };
  },
});

// Test 4: Mixed CK and non-CK triggers on same queue
export const ckMixedTest = task({
  id: "ck-mixed-test",
  retry: { maxAttempts: 1 },
  maxDuration: 120,
  run: async () => {
    logger.info("Testing mixed CK and non-CK on same queue");

    const results = await batch.triggerAndWait([
      // Non-CK runs
      {
        id: ckWorkerTask.id,
        payload: { id: "no-ck-1", waitMs: 2000 },
      },
      {
        id: ckWorkerTask.id,
        payload: { id: "no-ck-2", waitMs: 2000 },
      },
      // CK runs
      {
        id: ckWorkerTask.id,
        payload: { id: "with-ck-1", waitMs: 2000 },
        options: { concurrencyKey: "tenant-a" },
      },
      {
        id: ckWorkerTask.id,
        payload: { id: "with-ck-2", waitMs: 2000 },
        options: { concurrencyKey: "tenant-b" },
      },
    ]);

    const succeeded = results.runs.filter((r) => r.ok).length;
    const failed = results.runs.filter((r) => !r.ok).length;

    logger.info("Mixed test result", { succeeded, failed });

    if (failed > 0) {
      throw new Error(`${failed} runs failed in mixed CK/non-CK test`);
    }

    return { succeeded, total: results.runs.length };
  },
});
