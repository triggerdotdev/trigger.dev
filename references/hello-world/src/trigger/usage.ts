import { logger, task, wait, usage } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export const usageExampleTask = task({
  id: "usage-example",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 1000,
    factor: 1.5,
  },
  run: async (payload: { throwError: boolean }, { ctx }) => {
    logger.info("run.ctx", { ctx });

    await setTimeout(1000);

    const currentUsage = usage.getCurrent();

    logger.info("currentUsage", { currentUsage });

    if (payload.throwError && ctx.attempt.number === 1) {
      throw new Error("Forced error to cause a retry");
    }

    await setTimeout(5000);

    const currentUsage2 = usage.getCurrent();

    logger.info("currentUsage2", { currentUsage2 });

    return {
      message: "Hello, world!",
    };
  },
});
