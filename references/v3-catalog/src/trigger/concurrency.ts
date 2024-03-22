import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const oneAtATime = task({
  id: "on-at-a-time",
  queue: {
    concurrencyLimit: 1,
  },
  run: async (payload: { message: string }) => {
    logger.info("One at a time task payload", { payload });

    await wait.for({ seconds: 5 });

    return {
      finished: new Date().toISOString(),
    };
  },
});
