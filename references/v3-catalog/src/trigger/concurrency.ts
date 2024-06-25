import { logger, task, wait } from "@trigger.dev/sdk/v3";

import { env } from "../env";

export const oneAtATime = task({
  id: "on-at-a-time",
  queue: {
    concurrencyLimit: 1,
  },
  run: async (payload: { message: string }) => {
    logger.info("One at a time task payload", { payload, env });

    await wait.for({ seconds: 10 });

    return {
      finished: new Date().toISOString(),
    };
  },
});

export const testConcurrency = task({
  id: "test-concurrency",
  run: async ({ count = 10, delay = 5000 }: { count: number; delay: number }) => {
    logger.info(`Running ${count} tasks`);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    await testConcurrencyChild.batchTrigger(
      Array.from({ length: count }).map((_, index) => ({
        payload: {
          delay,
        },
      }))
    );

    logger.info(`All ${count} tasks triggered`);

    return {
      finished: new Date().toISOString(),
    };
  },
});

export const testConcurrencyChild = task({
  id: "test-concurrency-child",
  queue: {
    concurrencyLimit: 1,
  },
  run: async ({ delay = 5000 }: { delay: number }) => {
    logger.info(`Delaying for ${delay}ms`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    logger.info(`Delay of ${delay}ms completed`);

    return {
      completedAt: new Date(),
    };
  },
});
