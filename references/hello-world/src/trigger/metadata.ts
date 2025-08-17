import { logger, metadata, task, wait } from "@trigger.dev/sdk";
import { setTimeout } from "node:timers/promises";

export const metadataTestTask = task({
  id: "metadata-tester",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 1000,
    factor: 1.5,
  },
  run: async (payload: any, { ctx, signal }) => {
    let iteration = 0;

    while (!signal.aborted) {
      await setTimeout(1000);

      iteration++;

      metadata.set(`test-key-${iteration}`, `test-value-${iteration}`);
      metadata.append(`test-keys-${iteration}`, `test-value-${iteration}`);
      metadata.increment(`test-counter-${iteration}`, 1);

      await setTimeout(1000);
    }

    logger.info("Run completed", { iteration });

    return {
      success: true,
    };
  },
  onCancel: async ({ runPromise }) => {
    await metadata.flush();
    await runPromise;
  },
});

export const parentTask = task({
  id: "metadata-parent-task",
  run: async (payload: any, { ctx }) => {
    // will not be set
    metadata.root.set("test.root.set", true);
    metadata.parent.set("test.parent.set", true);
    metadata.set("test.set", "test");

    logger.info("logging metadata.current()", { current: metadata.current() });

    await childTask.triggerAndWait({});

    return {
      ok: true,
    };
  },
});

export const childTask = task({
  id: "metadata-child-task",
  run: async (payload: any, { ctx }) => {
    // will not be set
    metadata.root.set("child.root.before", true);
    await wait.for({ seconds: 15 });
    // will be set
    metadata.root.set("child.root.after", true);
    return { ok: true };
  },
});
