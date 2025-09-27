import { logger, task } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export const simpleSuccessTask = task({
  id: "otel/simple-success-task",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello log 1", { ctx });
    logger.info("Hello info 1");
    logger.warn("Hello warn 1");
    logger.error("Hello error 1");

    await setTimeout(15000);

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

export const failureWithRetries = task({
  id: "otel/failure-with-retries",
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: any, { ctx }) => {
    await setTimeout(15000);

    throw new Error("Hello error");
  },
});

export const taskWithChildTasks = task({
  id: "otel/task-with-child-tasks",
  run: async (payload: any, { ctx }) => {
    await simpleSuccessTask.triggerAndWait({});
  },
});
