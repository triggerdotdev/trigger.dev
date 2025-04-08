import { batch, logger, queue, task, wait } from "@trigger.dev/sdk";
import assert from "node:assert";
import { setTimeout } from "node:timers/promises";

// Queue with concurrency limit and release enabled
const releaseEnabledQueue = queue({
  name: "release-concurrency-test-queue-enabled",
  concurrencyLimit: 2,
  releaseConcurrencyOnWaitpoint: true,
});

// Queue with concurrency limit but release disabled
const releaseDisabledQueue = queue({
  name: "release-concurrency-test-queue-disabled",
  concurrencyLimit: 2,
  releaseConcurrencyOnWaitpoint: false,
});

// Task that runs on the release-enabled queue
const releaseEnabledTask = task({
  id: "release-concurrency-enabled-task",
  queue: releaseEnabledQueue,
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: { id: string; waitSeconds: number }, { ctx }) => {
    const startedAt = Date.now();
    logger.info(`Run ${payload.id} started at ${startedAt}`);

    // Wait and release concurrency
    await wait.for({ seconds: payload.waitSeconds, releaseConcurrency: true });

    const resumedAt = Date.now();
    await setTimeout(2000); // Additional work after resuming
    const completedAt = Date.now();

    return { id: payload.id, startedAt, resumedAt, completedAt };
  },
});

// Task that runs on the release-disabled queue
const releaseDisabledTask = task({
  id: "release-concurrency-disabled-task",
  queue: releaseDisabledQueue,
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: { id: string; waitSeconds: number }, { ctx }) => {
    const startedAt = Date.now();
    logger.info(`Run ${payload.id} started ${startedAt}`);

    // Wait without releasing concurrency
    await wait.for({ seconds: payload.waitSeconds });

    const resumedAt = Date.now();
    await setTimeout(2000);
    const completedAt = Date.now();

    return { id: payload.id, startedAt, resumedAt, completedAt };
  },
});

// Main test task
export const waitReleaseConcurrencyTestTask = task({
  id: "wait-release-concurrency-test",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload, { ctx }) => {
    logger.info("Starting wait release concurrency test");

    // Test 1: Queue with release enabled
    logger.info("Testing queue with release enabled");
    const enabledResults = await batch.triggerAndWait([
      { id: releaseEnabledTask.id, payload: { id: "e1", waitSeconds: 6 } },
      { id: releaseEnabledTask.id, payload: { id: "e2", waitSeconds: 6 } },
      { id: releaseEnabledTask.id, payload: { id: "e3", waitSeconds: 6 } },
    ]);

    // Verify all tasks completed
    assert(
      enabledResults.runs.every((r) => r.ok),
      "All enabled tasks should complete"
    );

    // Get executions sorted by start time
    const enabledExecutions = enabledResults.runs
      .map((r) => r.output)
      .sort((a, b) => a.startedAt - b.startedAt);

    // Verify that task e3 could start before e1 and e2 completed
    // (because concurrency was released during wait)
    const e3 = enabledExecutions.find((e) => e.id === "e3");
    const e1e2CompletedAt = Math.max(
      ...enabledExecutions.filter((e) => ["e1", "e2"].includes(e.id)).map((e) => e.completedAt)
    );

    assert(
      e3.startedAt < e1e2CompletedAt,
      "Task e3 should start before e1/e2 complete due to released concurrency"
    );

    logger.info("✅ test with release enabled");

    // Test 2: Queue with release disabled
    logger.info("Testing queue with release disabled");
    const disabledResults = await batch.triggerAndWait([
      { id: releaseDisabledTask.id, payload: { id: "d1", waitSeconds: 6 } },
      { id: releaseDisabledTask.id, payload: { id: "d2", waitSeconds: 6 } },
      { id: releaseDisabledTask.id, payload: { id: "d3", waitSeconds: 6 } },
    ]);

    // Verify all tasks completed
    assert(
      disabledResults.runs.every((r) => r.ok),
      "All disabled tasks should complete"
    );

    // Get executions sorted by start time
    const disabledExecutions = disabledResults.runs
      .map((r) => r.output)
      .sort((a, b) => a.startedAt - b.startedAt);

    // Verify that task d3 could NOT start before d1 or d2 completed
    // (because concurrency was not released during wait)
    const d3 = disabledExecutions.find((e) => e.id === "d3");
    const d1d2CompletedAt = Math.max(
      ...disabledExecutions.filter((e) => ["d1", "d2"].includes(e.id)).map((e) => e.completedAt)
    );

    assert(
      d3.startedAt >= d1d2CompletedAt,
      "Task d3 should not start before d1/d2 complete when concurrency is not released"
    );

    logger.info("✅ test with release disabled");

    return {
      enabledQueueResults: {
        executions: enabledExecutions,
        concurrencyReleased: true,
      },
      disabledQueueResults: {
        executions: disabledExecutions,
        concurrencyReleased: false,
      },
    };
  },
});
