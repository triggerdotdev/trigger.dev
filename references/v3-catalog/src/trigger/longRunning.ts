import { logger, task, type Context, wait } from "@trigger.dev/sdk/v3";

export const longRunning = task({
  id: "long-running",
  run: async ({ payload, ctx }: { payload: { message: string }; ctx: Context }) => {
    logger.info("Long running payloadd", { payload });

    // Wait for 10 minutes
    await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));

    return {
      finished: new Date().toISOString(),
    };
  },
});
