import { logger, task, wait } from "@trigger.dev/sdk/v3";
import slugify from "@sindresorhus/slugify";

export const loggingTask = task({
  id: "logging-task",
  run: async () => {
    console.log(`Hello world 9 ${slugify("foo bar")}`);

    return null;
  },
});

export const lotsOfLogs = task({
  id: "lots-of-logs",
  run: async (payload: { count: number }) => {
    for (let i = 0; i < payload.count; i++) {
      logger.info(`Hello world ${i} ${slugify("foo bar")}`);
      await wait.for({ seconds: 0.1 });
    }
  },
});
