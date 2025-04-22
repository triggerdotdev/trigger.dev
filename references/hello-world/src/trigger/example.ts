import { batch, logger, task, timeout, wait } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";
import { ResourceMonitor } from "../resourceMonitor.js";

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload: any, { ctx }) => {
    logger.info("Hello, world from the init", { ctx, payload });

    logger.debug("debug: Hello, world!", { payload });
    logger.info("info: Hello, world!", { payload });
    logger.log("log: Hello, world!", { payload });
    logger.warn("warn: Hello, world!", { payload });
    logger.error("error: Hello, world!", { payload });

    logger.trace("my trace", async (span) => {
      logger.debug("some log", { span });
    });

    logger.trace(
      "my trace",
      async (span) => {
        logger.debug("some log", { span });
      },
      {
        icon: "tabler-ad-circle",
      }
    );

    await wait.for({ seconds: 5 });

    return {
      message: "Hello, world!",
    };
  },
});

export const parentTask = task({
  id: "parent",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world from the parent", { payload });
    await childTask.triggerAndWait(
      { message: "Hello, world!" },
      {
        releaseConcurrency: true,
      }
    );
  },
});

export const batchParentTask = task({
  id: "batch-parent",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world from the parent", { payload });

    const results = await childTask.batchTriggerAndWait([
      { payload: { message: "Hello, world!" } },
      { payload: { message: "Hello, world 2!" } },
    ]);
    logger.log("Results", { results });

    const results2 = await batch.triggerAndWait<typeof childTask>([
      { id: "child", payload: { message: "Hello, world !" } },
      { id: "child", payload: { message: "Hello, world 2!" } },
    ]);
    logger.log("Results 2", { results2 });

    const results3 = await batch.triggerByTask([
      { task: childTask, payload: { message: "Hello, world !" } },
      { task: childTask, payload: { message: "Hello, world 2!" } },
    ]);
    logger.log("Results 3", { results3 });

    const results4 = await batch.triggerByTaskAndWait([
      {
        task: childTask,
        payload: { message: "Hello, world !" },
      },
      { task: childTask, payload: { message: "Hello, world 2!" } },
    ]);
    logger.log("Results 4", { results4 });
  },
});

export const childTask = task({
  id: "child",
  run: async (
    {
      message,
      failureChance = 0.3,
      duration = 3_000,
    }: { message?: string; failureChance?: number; duration?: number },
    { ctx }
  ) => {
    logger.info("Hello, world from the child", { message, failureChance });

    if (Math.random() < failureChance) {
      throw new Error("Random error at start");
    }

    await setTimeout(duration);

    if (Math.random() < failureChance) {
      throw new Error("Random error at end");
    }

    return {
      message,
    };
  },
});

export const maxDurationTask = task({
  id: "max-duration",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 2_000,
    factor: 1.4,
  },
  maxDuration: 5,
  run: async (payload: { sleepFor: number }, { signal, ctx }) => {
    await setTimeout(payload.sleepFor * 1000, { signal });
  },
});

export const maxDurationParentTask = task({
  id: "max-duration-parent",
  run: async (payload: { sleepFor?: number; maxDuration?: number }, { ctx, signal }) => {
    const result = await maxDurationTask.triggerAndWait(
      { sleepFor: payload.sleepFor ?? 10 },
      { maxDuration: timeout.None }
    );

    return result;
  },
});

export const batchTask = task({
  id: "batch",
  run: async (payload: { count: number }, { ctx }) => {
    logger.info("Starting batch task", { count: payload.count });

    const items = Array.from({ length: payload.count }, (_, i) => ({
      payload: { message: `Batch item ${i + 1}` },
    }));

    const results = await childTask.batchTriggerAndWait(items);

    logger.info("Batch task complete", { results });

    return {
      batchCount: payload.count,
      results,
    };
  },
});

const nonExportedTask = task({
  id: "non-exported",
  run: async (payload: { message: string }, { ctx }) => {
    logger.info("Hello, world from the non-exported task", { message: payload.message });
  },
});

export const hooksTask = task({
  id: "hooks",
  run: async (payload: { message: string }, { ctx }) => {
    logger.info("Hello, world from the hooks task", { message: payload.message });

    await wait.for({ seconds: 5 });

    return {
      message: "Hello, world!",
    };
  },
  init: async () => {
    return {
      foobar: "baz",
    };
  },
  onWait: async ({ payload, wait, ctx, init }) => {
    logger.info("Hello, world from the onWait hook", { payload, init, wait });
  },
  onResume: async ({ payload, wait, ctx, init }) => {
    logger.info("Hello, world from the onResume hook", { payload, init, wait });
  },
  onStart: async ({ payload, ctx, init }) => {
    logger.info("Hello, world from the onStart hook", { payload, init });
  },
  onSuccess: async ({ payload, output, ctx }) => {
    logger.info("Hello, world from the onSuccess hook", { payload, output });
  },
  onFailure: async ({ payload, error, ctx }) => {
    logger.info("Hello, world from the onFailure hook", { payload, error });
  },
  onComplete: async ({ ctx, payload, result }) => {
    logger.info("Hello, world from the onComplete hook", { payload, result });
  },
  handleError: async ({ payload, error, ctx, retry }) => {
    logger.info("Hello, world from the handleError hook", { payload, error, retry });
  },
  catchError: async ({ ctx, payload, error, retry }) => {
    logger.info("Hello, world from the catchError hook", { payload, error, retry });
  },
  cleanup: async ({ ctx, payload }) => {
    logger.info("Hello, world from the cleanup hook", { payload });
  },
});

export const resourceMonitorTest = task({
  id: "resource-monitor-test",
  run: async (payload: { dirName?: string; processName?: string }, { ctx }) => {
    logger.info("Hello, resources!", { payload });

    const resMon = new ResourceMonitor({
      ctx,
      dirName: payload.dirName ?? "/tmp",
      processName: payload.processName ?? "node",
    });

    resMon.startMonitoring(1_000);

    await resMon.logResourceSnapshot();

    await wait.for({ seconds: 5 });

    await resMon.logResourceSnapshot();

    resMon.stopMonitoring();

    return {
      message: "Hello, resources!",
    };
  },
});
