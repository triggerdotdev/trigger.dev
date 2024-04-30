import { logger, task } from "@trigger.dev/sdk/v3";

export const longRunning = task({
  id: "long-running",
  run: async (payload: { message: string }) => {
    logger.info("Long running payloadd", { payload });

    // Wait for 3 minutes
    await new Promise((resolve) => setTimeout(resolve, 3 * 60 * 1000));

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
