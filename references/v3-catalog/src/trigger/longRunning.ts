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

export const longRunningWithLotsOfLogs = task({
  id: "long-running-lots-of-logs",
  run: async (payload: { message: string }) => {
    const largeObject = Array.from({ length: 256 }, (_, i) => i).reduce((acc, i) => {
      acc[i] = "a".repeat(100);
      return acc;
    }, {} as any);

    // Log 10000 times over 3 minutes
    for (let i = 0; i < 20000; i++) {
      logger.info("Log number " + i, { largeObject });
      await new Promise((resolve) => setTimeout(resolve, 18));
    }

    return {
      finished: new Date().toISOString(),
    };
  },
});
