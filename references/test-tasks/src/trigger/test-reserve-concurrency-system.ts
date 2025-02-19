import { BatchResult, logger, queue, task, wait } from "@trigger.dev/sdk/v3";
import assert from "assert";
import {
  updateEnvironmentConcurrencyLimit,
  waitForRunStatus,
  getEnvironmentStats,
} from "../utils.js";

export const describeReserveConcurrencySystem = task({
  id: "describe/reserve-concurrency-system",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: any, { ctx }) => {
    await testRetryPriority.triggerAndWait({ holdDelayMs: 10_000 }).unwrap();

    logger.info("✅ Tested retry priority, now testing resume priority");

    await testResumePriority.triggerAndWait({ initialDelayMs: 5_000, useBatch: false }).unwrap();
    await testResumePriority.triggerAndWait({ initialDelayMs: 30_000, useBatch: false }).unwrap();

    logger.info("✅ Tested resume priority with triggerAndWait");

    await testResumePriority.triggerAndWait({ initialDelayMs: 5_000, useBatch: true }).unwrap();
    await testResumePriority.triggerAndWait({ initialDelayMs: 30_000, useBatch: true }).unwrap();

    logger.info("✅ Tested resume priority with batchTriggerAndWait");

    await testResumeDurationPriority.triggerAndWait({ waitDurationInSeconds: 30 }).unwrap();
    await testResumeDurationPriority.triggerAndWait({ waitDurationInSeconds: 65 }).unwrap();

    logger.info("✅ Tested resume duration priority with wait.for");

    await testEnvReserveConcurrency
      .triggerAndWait({ envConcurrencyLimit: 4, holdTaskCount: 1, useBatch: false })
      .unwrap();

    logger.info("✅ Tested env reserve concurrency system with triggerAndWait");

    await testEnvReserveConcurrency
      .triggerAndWait({ envConcurrencyLimit: 4, holdTaskCount: 1, useBatch: true })
      .unwrap();

    logger.info("✅ Tested env reserve concurrency system with batchTriggerAndWait");

    await testQueueReserveConcurrency.triggerAndWait({ useBatch: false }).unwrap();

    logger.info("✅ Tested queue reserve concurrency system with triggerAndWait");

    await testQueueReserveConcurrency.triggerAndWait({ useBatch: true }).unwrap();

    logger.info("✅ Tested queue reserve concurrency system with batchTriggerAndWait");
  },
});

export const testRetryPriority = task({
  id: "test/retry-priority",
  retry: {
    maxAttempts: 1,
  },
  run: async ({ holdDelayMs = 10_000 }: { holdDelayMs: number }, { ctx }) => {
    const startEnvStats = await getEnvironmentStats(ctx.environment.id);

    // We need to test the reserve concurrency system
    // 1. Retries are prioritized over new runs
    //    Setup: Trigger a run that fails and will re-attempt in 5 seconds
    //           Trigger another run that uses the same concurrency, and hits the max concurrency of that queue
    //           Trigger a run on that same queue before the retry is attempted
    //           The "hold" run will then complete and the retry should be dequeued
    //           Once the retry completes successfully, the 3rd run should be dequeued

    const failureRun = await retryTask.trigger(
      { delayMs: 0, throwError: true, failureCount: 1 },
      { tags: ["failure"] }
    );
    await waitForRunStatus(failureRun.id, ["EXECUTING", "REATTEMPTING"]);

    logger.info("Failure run is executing, triggering a run that will hit the concurrency limit");

    const holdRun = await retryTask.trigger(
      { delayMs: holdDelayMs, throwError: false, failureCount: 0 },
      { tags: ["hold"] }
    );
    await waitForRunStatus(holdRun.id, ["EXECUTING"]);

    logger.info("Hold run is executing, triggering a run that will be queued");

    const queuedRun = await retryTask.trigger(
      { delayMs: 0, throwError: false, failureCount: 0 },
      { tags: ["queued"] }
    );

    logger.info("Queued run is queued, waiting for the hold run to complete");

    const completedFailureRun = await waitForRunStatus(failureRun.id, ["COMPLETED"]);
    const completedQueuedRun = await waitForRunStatus(queuedRun.id, ["COMPLETED"]);

    logger.info("Runs completed", {
      completedFailureRun,
      completedQueuedRun,
    });

    // Now we need to assert the completedFailureRun.completedAt is before completedQueuedRun.completedAt
    assert(
      completedFailureRun.finishedAt! < completedQueuedRun.finishedAt!,
      "Failure run should complete before queued run"
    );

    // Now lets make sure all the runs are completed
    await waitForRunStatus(holdRun.id, ["COMPLETED"]);

    const envStats = await getEnvironmentStats(ctx.environment.id);

    logger.info("Environment stats", envStats);

    assert(
      startEnvStats.reserveConcurrency - envStats.reserveConcurrency === 0,
      "Reserve concurrency should be 0"
    );

    logger.info("✅ Failure run completed before queued run");
  },
});

export const testResumePriority = task({
  id: "test/resume-priority",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    { initialDelayMs = 5_000, useBatch = false }: { initialDelayMs: number; useBatch: boolean },
    { ctx }
  ) => {
    const startEnvStats = await getEnvironmentStats(ctx.environment.id);

    // 2. Resumed runs are prioritized over new runs
    const resumeRun = await resumeParentTask.trigger(
      { delayMs: initialDelayMs, triggerChildTask: true, useBatch },
      { tags: ["resume"] }
    );
    await waitForRunStatus(resumeRun.id, ["EXECUTING", "FROZEN"]);

    logger.info("Resume run is executing, triggering a run that should be queued");
    const queuedRun = await resumeParentTask.trigger(
      { delayMs: 1_000, triggerChildTask: false, useBatch },
      { tags: ["queued"] }
    );
    await waitForRunStatus(queuedRun.id, ["QUEUED"]);

    const completedResumeRun = await waitForRunStatus(resumeRun.id, ["COMPLETED"]);
    const completedQueuedRun = await waitForRunStatus(queuedRun.id, ["COMPLETED"]);

    logger.info("Runs completed", {
      completedResumeRun,
      completedQueuedRun,
    });

    // Now we need to assert the completedResumeRun.completedAt is before completedQueuedRun.completedAt
    assert(
      completedResumeRun.finishedAt! < completedQueuedRun.finishedAt!,
      "Resume run should complete before queued run"
    );

    const envStats = await getEnvironmentStats(ctx.environment.id);

    assert(
      startEnvStats.reserveConcurrency - envStats.reserveConcurrency === 0,
      "Reserve concurrency should be 0"
    );

    logger.info("✅ Resume run completed before queued run");
  },
});

export const testResumeDurationPriority = task({
  id: "test/resume-duration-priority",
  retry: {
    maxAttempts: 1,
  },
  run: async ({ waitDurationInSeconds = 5 }: { waitDurationInSeconds: number }, { ctx }) => {
    const startEnvStats = await getEnvironmentStats(ctx.environment.id);

    // 2. Resumed runs are prioritized over new runs
    const resumeRun = await durationWaitTask.trigger(
      { waitDurationInSeconds, doWait: true },
      { tags: ["resume"] }
    );
    await waitForRunStatus(resumeRun.id, ["EXECUTING", "FROZEN"]);

    logger.info(
      "Resume run is executing, triggering a run that will hold the concurrency until both the resume run and the queued run are in the queue"
    );

    if (ctx.environment.type !== "DEVELOPMENT") {
      const holdRun = await durationWaitTask.trigger(
        { waitDurationInSeconds: waitDurationInSeconds + 10, doWait: false },
        { tags: ["hold"] }
      );
      await waitForRunStatus(holdRun.id, ["EXECUTING"]);

      logger.info("Hold run is executing, triggering a run that should be queued");
    }

    const queuedRun = await durationWaitTask.trigger(
      { waitDurationInSeconds: 1, doWait: false },
      { tags: ["queued"] }
    );
    await waitForRunStatus(queuedRun.id, ["QUEUED"]);

    const completedResumeRun = await waitForRunStatus(resumeRun.id, ["COMPLETED"]);
    const completedQueuedRun = await waitForRunStatus(queuedRun.id, ["COMPLETED"]);

    logger.info("Runs completed", {
      completedResumeRun,
      completedQueuedRun,
    });

    // Now we need to assert the completedResumeRun.completedAt is before completedQueuedRun.completedAt
    assert(
      completedResumeRun.finishedAt! < completedQueuedRun.finishedAt!,
      "Resume run should complete before queued run"
    );

    const envStats = await getEnvironmentStats(ctx.environment.id);

    assert(
      startEnvStats.reserveConcurrency - envStats.reserveConcurrency === 0,
      "Reserve concurrency should be 0"
    );

    logger.info("✅ Resume run completed before queued run");
  },
});

export const testEnvReserveConcurrency = task({
  id: "test/env-reserve-concurrency",
  retry: {
    maxAttempts: 1,
  },
  run: async (
    {
      envConcurrencyLimit = 3,
      holdTaskCount = 1,
      useBatch = false,
    }: { envConcurrencyLimit: number; holdTaskCount: number; useBatch: boolean },
    { ctx }
  ) => {
    const startEnvStats = await getEnvironmentStats(ctx.environment.id);

    // 3. When a task triggerAndWaits another task, the parent run should be added to the envs reserve concurrency
    //    Giving the environment "back" another concurrency slot. Another task (not the parent task) can then be dequeued
    //    We need to be able to "fill" the env concurrency (sans 1), then trigger the parent task. The parent task then triggerAndWaits
    //    a child task. We need to make sure the child task executes
    await updateEnvironmentConcurrencyLimit(ctx.environment.id, envConcurrencyLimit);

    const holdBatch = await delayTask.batchTrigger(
      Array.from({ length: holdTaskCount }, (_, i) => ({
        payload: { delayMs: 30_000 },
        options: { tags: ["hold"] },
      }))
    );

    // Wait for the hold tasks to be executing
    await Promise.all(holdBatch.runs.map((run) => waitForRunStatus(run.id, ["EXECUTING"])));

    // Now we will trigger a parent task that will trigger a child task
    const parentRun = await genericParentTask.trigger(
      { delayMs: 1_000, triggerChildTask: true, useBatch },
      { tags: ["parent"] }
    );

    // Once the parentRun starts executing, we will be at the max concurrency limit
    await waitForRunStatus(parentRun.id, ["EXECUTING"], 5); // timeout after 5 seconds, to ensure the parent task is executing

    // But because the parent task triggers a child task, the env reserve concurrency will allow the child task to execute
    logger.info("Parent task is executing, waiting for child task to complete");

    await waitForRunStatus(parentRun.id, ["COMPLETED"], 10); // timeout after 10 seconds, to ensure the child task finished before the delay runs

    logger.info(
      "Parent task completed, which means the child task completed. Now waiting for the hold tasks to complete"
    );

    const envStats = await getEnvironmentStats(ctx.environment.id, "task/generic-parent-task");

    assert(
      startEnvStats.reserveConcurrency - envStats.reserveConcurrency === 0,
      "Reserve concurrency should be 0"
    );
    assert(
      envStats.queueCurrentConcurrency === 0,
      "generic-parent-task current concurrency should be 0"
    );
    assert(
      envStats.queueReserveConcurrency === 0,
      "generic-parent-task reserve concurrency should be 0"
    );

    const childStats = await getEnvironmentStats(ctx.environment.id, "task/generic-child-task");

    assert(
      childStats.queueReserveConcurrency === 0,
      "generic-child-task reserve concurrency should be 0"
    );
    assert(
      childStats.queueCurrentConcurrency === 0,
      "generic-child-task current concurrency should be 0"
    );

    // Wait for the hold tasks to be completed
    await Promise.all(holdBatch.runs.map((run) => waitForRunStatus(run.id, ["COMPLETED"])));

    await updateEnvironmentConcurrencyLimit(ctx.environment.id, 100);

    logger.info("✅ Environment reserve concurrency system is working as expected");
  },
});

export const testQueueReserveConcurrency = task({
  id: "test/queue-reserve-concurrency",
  retry: {
    maxAttempts: 1,
  },
  run: async ({ useBatch = false }: { useBatch: boolean }, { ctx }) => {
    const startEnvStats = await getEnvironmentStats(ctx.environment.id);
    // This test ensures that when triggerAndWait is called where the parent and the child share a queue,
    // the queue reserve concurrency is used to allow the child to execute.
    // We also want to test that the queue can only "reserve" at most up to the concurrency limit, and if
    // the reservation fails, the child task will fail
    const rootRecursiveRun = await recursiveTask.trigger(
      { delayMs: 1_000, depth: 1, useBatch },
      { tags: ["root"] }
    );

    const completedRootRun = await waitForRunStatus(rootRecursiveRun.id, ["COMPLETED"], 20);

    assert(completedRootRun.status === "COMPLETED", "Root recursive run should be completed");

    const failingRootRecursiveRun = await recursiveTask.trigger(
      { delayMs: 1_000, depth: 2, useBatch },
      { tags: ["failing-root"] }
    );

    const failedRootRun = await waitForRunStatus(failingRootRecursiveRun.id, ["COMPLETED"], 20);

    assert(!failedRootRun.output?.ok, "Child of failing root run should fail");

    const envStats = await getEnvironmentStats(ctx.environment.id, "task/recursive-task");

    logger.info("Environment stats", envStats);

    assert(
      startEnvStats.reserveConcurrency - envStats.reserveConcurrency === 0,
      "Env reserve concurrency should be 0"
    );
    assert(
      envStats.queueCurrentConcurrency === 0,
      "queue-reserve-concurrency current concurrency should be 0"
    );
    assert(
      envStats.queueReserveConcurrency === 0,
      "queue-reserve-concurrency reserve concurrency should be 0"
    );
  },
});

export const recursiveTask = task({
  id: "recursive-task",
  queue: {
    concurrencyLimit: 1,
  },
  retry: {
    maxAttempts: 1,
  },
  run: async (
    { delayMs, depth, useBatch = false }: { delayMs: number; depth: number; useBatch: boolean },
    { ctx }
  ) => {
    if (depth === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    if (useBatch) {
      const batchResult = await recursiveTask.batchTriggerAndWait([
        {
          payload: { delayMs, depth: depth - 1, useBatch },
          options: { tags: ["recursive"] },
        },
      ]);

      const firstRun = batchResult.runs[0] as any;

      return {
        ok: firstRun.ok,
      };
    } else {
      const result = (await recursiveTask.triggerAndWait({
        delayMs,
        depth: depth - 1,
        useBatch,
      })) as any;

      return {
        ok: result.ok,
      };
    }
  },
});

export const singleQueue = queue({
  name: "single-queue",
  concurrencyLimit: 1,
});

export const delayTask = task({
  id: "delay-task",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: { delayMs: number }, { ctx }) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
  },
});

export const retryTask = task({
  id: "retry-task",
  queue: singleQueue,
  retry: {
    maxAttempts: 10,
    minTimeoutInMs: 5_000, // Will retry in 5 seconds
    maxTimeoutInMs: 5_000,
  },
  run: async (payload: { delayMs: number; throwError: boolean; failureCount: number }, { ctx }) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delayMs));

    if (payload.throwError && ctx.attempt.number <= payload.failureCount) {
      throw new Error("Error");
    }
  },
});

export const durationWaitTask = task({
  id: "duration-wait-task",
  queue: {
    concurrencyLimit: 1,
  },
  run: async (
    {
      waitDurationInSeconds = 5,
      doWait = true,
    }: { waitDurationInSeconds: number; doWait: boolean },
    { ctx }
  ) => {
    if (doWait) {
      await wait.for({ seconds: waitDurationInSeconds });
    } else {
      await new Promise((resolve) => setTimeout(resolve, waitDurationInSeconds * 1000));
    }
  },
});

export const resumeParentTask = task({
  id: "resume-parent-task",
  queue: {
    concurrencyLimit: 1,
  },
  run: async (
    {
      delayMs = 5_000,
      triggerChildTask,
      useBatch = false,
    }: { delayMs: number; triggerChildTask: boolean; useBatch: boolean },
    { ctx }
  ) => {
    if (triggerChildTask) {
      if (useBatch) {
        const batchResult = await resumeChildTask.batchTriggerAndWait([
          {
            payload: { delayMs },
            options: { tags: ["resume-child"] },
          },
        ]);

        unwrapBatchResult(batchResult);
      } else {
        await resumeChildTask.triggerAndWait({ delayMs }, { tags: ["resume-child"] }).unwrap();
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  },
});

export const resumeChildTask = task({
  id: "resume-child-task",
  run: async (payload: { delayMs: number }, { ctx }) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
  },
});

export const genericParentTask = task({
  id: "generic-parent-task",
  run: async (
    {
      delayMs = 5_000,
      triggerChildTask,
      useBatch = false,
    }: { delayMs: number; triggerChildTask: boolean; useBatch: boolean },
    { ctx }
  ) => {
    if (triggerChildTask) {
      if (useBatch) {
        const batchResult = await genericChildTask.batchTriggerAndWait([
          {
            payload: { delayMs },
            options: { tags: ["resume-child"] },
          },
        ]);

        return unwrapBatchResult(batchResult);
      } else {
        await genericChildTask.triggerAndWait({ delayMs }, { tags: ["resume-child"] }).unwrap();
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  },
});

function unwrapBatchResult(batchResult: BatchResult<string, any>) {
  if (batchResult.runs.some((run) => !run.ok)) {
    throw new Error(`Child task failed: ${batchResult.runs.find((run) => !run.ok)?.error}`);
  }

  return batchResult.runs;
}

export const genericChildTask = task({
  id: "generic-child-task",
  run: async (payload: { delayMs: number }, { ctx }) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
  },
});
