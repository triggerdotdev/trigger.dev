import { logger, task } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export const simpleSuccessTask = task({
  id: "otel/simple-success-task",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello log 1");
    logger.info("Hello info 1");
    logger.warn("Hello warn 1");
    logger.error("Hello error 1");

    await setTimeout(5000);

    logger.log("Hello log 2");
    logger.info("Hello info 2");
    logger.warn("Hello warn 2");
    logger.error("Hello error 2");

    return { message: "Hello, world!" };
  },
});

export const simpleFailureTask = task({
  id: "otel/simple-failure-task",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: any, { ctx }) => {
    await setTimeout(5000);

    throw new Error("Hello error");
  },
});
