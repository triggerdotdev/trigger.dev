import { logger, task, wait, usage } from "@trigger.dev/sdk/v3";

export const usagePlayground = task({
  id: "usage-playground",
  machine: {
    preset: "medium-2x",
  },
  run: async (payload: { duration: number }, { ctx }) => {
    if (ctx.machine) {
      logger.info("Machine preset", { preset: ctx.machine });
    }

    logger.info("Cost and duration", { cost: ctx.run.costInCents, duration: ctx.run.durationMs });

    await logger.trace("Doing some work...", async () => {
      await new Promise((resolve) => setTimeout(resolve, payload.duration));
    });

    let currentUsage = usage.getCurrent();

    logger.info("Current Cost and duration (before wait)", { currentUsage });

    await wait.for({ seconds: 5 });

    currentUsage = usage.getCurrent();

    logger.info("Current Cost and duration (after wait)", { currentUsage });

    throw new Error(`This is an error at ${new Date().toISOString()}`);
  },
});
