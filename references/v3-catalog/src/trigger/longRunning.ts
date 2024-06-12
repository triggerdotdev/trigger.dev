import { logger, task, wait, usage } from "@trigger.dev/sdk/v3";

export const longRunning = task({
  id: "long-running",
  machine: {
    preset: "medium-2x",
  },
  run: async (payload: { message: string }, { ctx }) => {
    logger.info("Long running payloadddd", { payload });

    if (ctx.machine) {
      logger.info("Machine preset", { preset: ctx.machine });
    }

    logger.info("Cost and duration", { cost: ctx.run.costInCents, duration: ctx.run.durationMs });

    // Wait for 3 minutes
    await new Promise((resolve) => setTimeout(resolve, 5000));

    let currentUsage = usage.getCurrent();

    logger.info("Current Cost and duration (before wait)", {
      cost: currentUsage.costInCents,
      duration: currentUsage.durationMs,
    });

    await wait.for({ seconds: 5 });

    currentUsage = usage.getCurrent();

    logger.info("Current Cost and duration (after wait)", {
      cost: currentUsage.costInCents,
      duration: currentUsage.durationMs,
    });

    throw new Error(`This is an error at ${new Date().toISOString()}`);
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
