import { BatchResult, logger, queue, task, wait } from "@trigger.dev/sdk/v3";

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
    maxAttempts: 2,
  },
  run: async (
    payload: { delayMs: number; throwError: boolean; failureCount: number; retryDelayMs?: number },
    { ctx }
  ) => {
    await new Promise((resolve) => setTimeout(resolve, payload.delayMs));

    if (payload.throwError && ctx.attempt.number <= payload.failureCount) {
      throw new Error("Error");
    }
  },
  handleError: async ({ ctx, payload, error }) => {
    if (!payload.throwError) {
      return {
        skipRetrying: true,
      };
    } else {
      return {
        retryDelayInMs: payload.retryDelayMs,
      };
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
    logger.debug("Running generic child task");

    await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
  },
});

export const eventLoopLagTask = task({
  id: "event-loop-lag-task",
  run: async ({ delayMs }: { delayMs: number }, { ctx }) => {
    const start = Date.now();
    while (Date.now() - start < delayMs) {
      // Do nothing
    }
  },
});
