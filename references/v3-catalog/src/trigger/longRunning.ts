import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const longRunning = task({
  id: "long-running",
  run: async (payload: { message: string }, { ctx }) => {
    logger.info("Long running", { payload });

    await new Promise((resolve) => setTimeout(resolve, 20000));

    await wait.for({ seconds: 10 });

    await new Promise((resolve) => setTimeout(resolve, 20000));
  },
});

export const longRunningParent = task({
  id: "long-running-parent",
  run: async (payload: { message: string }) => {
    logger.info("Long running parent", { payload });

    const result = await longRunning.triggerAndWait({ message: "child" });

    return {
      finished: new Date().toISOString(),
      result,
    };
  },
});

export const longRunningWithDotInName = task({
  id: "long.running.with.dot",
  run: async (payload: { message: string }) => {
    logger.info("Long running payloadd", { payload });

    // Wait for 3 minutes
    await new Promise((resolve) => setTimeout(resolve, 3 * 60 * 1000));

    return {
      finished: new Date().toISOString(),
    };
  },
});
