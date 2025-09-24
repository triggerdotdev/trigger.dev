import { logger, task } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export const simpleSuccessTask = task({
  id: "otel/simple-success-task",
  run: async (payload: any, { ctx }) => {
    logger.debug("Hello debug");
    logger.log("Hello log");
    logger.info("Hello info");
    logger.warn("Hello warn");
    logger.error("Hello error");

    await setTimeout(5000);

    return { message: "Hello, world!" };
  },
});
