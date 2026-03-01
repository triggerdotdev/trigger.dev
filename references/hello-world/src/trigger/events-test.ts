import { event, task, logger } from "@trigger.dev/sdk";
import { z } from "zod";

// Define event with ordering config
export const testEvent = event({
  id: "test.greeting",
  schema: z.object({
    name: z.string(),
    message: z.string(),
  }),
  ordering: {
    concurrencyLimit: 2,
  },
});

// Slow subscriber with concurrencyLimit: 1 for ordering
// The concurrencyLimit:1 ensures per-key ordering when used with orderingKey
export const slowWorker = task({
  id: "slow-greeting-worker",
  on: testEvent,
  queue: { concurrencyLimit: 1 },
  run: async (payload) => {
    const start = Date.now();
    logger.info(`[slow-worker] START "${payload.name}" at ${new Date().toISOString()}`);
    await new Promise((r) => setTimeout(r, 2000));
    logger.info(`[slow-worker] END "${payload.name}" after ${Date.now() - start}ms`);
    return { name: payload.name, duration: Date.now() - start };
  },
});
