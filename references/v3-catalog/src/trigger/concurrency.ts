import { logger, task, type Context, wait } from "@trigger.dev/sdk/v3";

export const oneAtATime = task({
  id: "on-at-a-time",
  queue: {
    concurrencyLimit: 1,
  },
  run: async ({ payload, ctx }: { payload: { message: string }; ctx: Context }) => {
    logger.info("One at a time task payload", { payload });

    await wait.for({ seconds: 5 });

    return {
      finished: new Date().toISOString(),
    };
  },
});
