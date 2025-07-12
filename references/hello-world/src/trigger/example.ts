import { batch, logger, task, tasks, timeout, wait } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";
import { ResourceMonitor } from "../resourceMonitor.js";

export const helloWorldTask = task({
  id: "hello-world",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 1000,
    factor: 1.5,
  },
  onStart: async ({ payload, ctx, init }) => {
    logger.info("Hello, world from the onStart hook", { payload, init });
  },
  run: async (payload: any, { ctx }) => {
    logger.info("Hello, world from the init", { ctx, payload });
    logger.info("env vars", {
      env: process.env,
    });

    logger.debug("debug: Hello, world!", { payload });
    logger.info("info: Hello, world!", { payload });
    logger.log("log: Hello, world!", { payload });
    logger.warn("warn: Hello, world!", { payload });
    logger.error("error: Hello, world!", { payload });

    logger.trace("my trace", async (span) => {
      logger.debug("some log", { span });
    });

    await setTimeout(payload.sleepFor ?? 180_000);

    if (payload.throwError) {
      throw new Error("Forced error to cause a retry");
    }

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
  machine: "medium-1x",
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
  onCancel: async ({ payload }) => {
    logger.info("Hello, world from the onCancel hook", { payload });
  },
});

export const cancelExampleTask = task({
  id: "cancel-example",
  // Signal will be aborted when the task is cancelled 👇
  run: async (payload: { timeoutInSeconds: number }, { signal }) => {
    logger.info("Hello, world from the cancel task", {
      timeoutInSeconds: payload.timeoutInSeconds,
    });

    // This is a global hook that will be called if the task is cancelled
    tasks.onCancel(async () => {
      logger.info("global task onCancel hook but inside of the run function baby!");
    });

    await logger.trace("timeout", async (span) => {
      try {
        // We pass the signal to setTimeout to abort the timeout if the task is cancelled
        await setTimeout(payload.timeoutInSeconds * 1000, undefined, { signal });
      } catch (error) {
        // If the timeout is aborted, this error will be thrown, we can handle it here
        logger.error("Timeout error", { error });
      }
    });

    logger.info("Hello, world from the cancel task after the timeout", {
      timeoutInSeconds: payload.timeoutInSeconds,
    });

    return {
      message: "Hello, world!",
    };
  },
  onCancel: async ({ payload, runPromise }) => {
    logger.info("Hello, world from the onCancel hook", { payload });
    // You can await the runPromise to get the output of the task
    const output = await runPromise;

    logger.info("Hello, world from the onCancel hook after the run", { payload, output });

    // You can do work inside the onCancel hook, up to 30 seconds
    await setTimeout(10_000);

    logger.info("Hello, world from the onCancel hook after the timeout", { payload });
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

export const circularReferenceTask = task({
  id: "circular-reference",
  run: async (payload: { message: string }, { ctx }) => {
    logger.info("Hello, world from the circular reference task", { message: payload.message });

    // Create an object
    const user = {
      name: "Alice",
      details: {
        age: 30,
        email: "alice@example.com",
      },
    };

    // Create the circular reference
    // @ts-expect-error - This is a circular reference
    user.details.user = user;

    // Now user.details.user points back to the user object itself
    // This creates a circular reference that standard JSON can't handle

    return {
      user,
    };
  },
});

export const largeAttributesTask = task({
  id: "large-attributes",
  machine: "large-1x",
  run: async ({ length = 100000 }: { length: number }, { signal, ctx }) => {
    // Create a large deeply nested object/array of objects that have more than 10k attributes when flattened
    const start = performance.now();

    const largeObject = Array.from({ length }, (_, i) => ({
      a: i,
      b: i,
      c: i,
    }));

    const end = performance.now();

    console.log(`[${length}] Time taken to create the large object: ${end - start}ms`);

    const start2 = performance.now();

    logger.info("Hello, world from the large attributes task", { largeObject });

    const end2 = performance.now();

    console.log(`[${length}] Time taken to log the large object: ${end2 - start2}ms`);

    class MyClass {
      constructor(public name: string) {}
    }

    logger.info("Lets log some weird stuff", {
      error: new Error("This is an error"),
      func: () => {
        logger.info("This is a function");
      },
      date: new Date(),
      bigInt: BigInt(1000000000000000000),
      symbol: Symbol("symbol"),
      myClass: new MyClass("MyClass"),
      file: new File([], "test.txt"),
      stream: new ReadableStream(),
      map: new Map([["key", "value"]]),
      set: new Set([1, 2, 3]),
      promise: Promise.resolve("Hello, world!"),
      promiseRejected: Promise.reject(new Error("This is a rejected promise")),
      promisePending: Promise.resolve("Hello, world!"),
    });
  },
});
