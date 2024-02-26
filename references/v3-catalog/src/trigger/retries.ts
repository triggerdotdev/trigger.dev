import { type Context, task, logger } from "@trigger.dev/sdk/v3";
import { cache } from "./utils/cache";

export const taskWithRetries = task({
  id: "task-with-retries",
  retry: {
    maxAttempts: 10,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    randomize: false,
  },
  run: async ({ payload, ctx }: { payload: string; ctx: Context }) => {
    const user = await cache("user", async () => {
      return logger.trace("fetch-user", async (span) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        span.setAttribute("user.id", "1");

        return {
          id: "1",
          name: "John Doe",
          fetchedAt: new Date(),
        };
      });
    });

    logger.info("Fetched user", { user });

    if (ctx.attempt.number <= 9) {
      throw new Error(`Attempt ${ctx.attempt.number} failed: ${payload}`);
    }

    return {
      result: "success",
      payload,
    };
  },
});
