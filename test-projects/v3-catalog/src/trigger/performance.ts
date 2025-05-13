import { logger, task } from "@trigger.dev/sdk/v3";

export const performance = task({
  id: "performance",
  run: async ({ count, subtaskDuration = 30_000 }: { count: number; subtaskDuration?: number }) => {
    const payloads = Array.from({ length: count }, (_, i) => ({
      payload: {
        durationMs: subtaskDuration,
      },
    }));

    await longTask.batchTrigger(payloads);
  },
});

export const longTask = task({
  id: "long-task",
  run: async ({ durationMs }: { durationMs: number }) => {
    //sleep for durationMs
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    logger.info("long task done");
  },
});
