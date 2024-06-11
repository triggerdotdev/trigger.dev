import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const longRunning = task({
  id: "long-running",
  machine: {
    preset: "medium-2x",
  },
  run: async (payload: { message: string }) => {
    logger.info("Long running payloadddd", { payload });

    // Wait for 3 minutes
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await wait.for({ seconds: 5 });

    return {
      finished: new Date().toISOString(),
    };
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
