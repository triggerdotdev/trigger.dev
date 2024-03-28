import { logger, task, wait } from "@trigger.dev/sdk/v3";
import slugify from "@sindresorhus/slugify";

export const loggingTask = task({
  id: "logging-task",
  run: async () => {
    logger.error("This is an error message");
    logger.warn("This is a warning message");
    logger.log("This is a log message");
    logger.info("This is an info message");
    logger.debug("This is a debug message");
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
