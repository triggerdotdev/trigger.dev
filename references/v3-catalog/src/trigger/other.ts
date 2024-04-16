import { logger, task, wait } from "@trigger.dev/sdk/v3";
import { setTimeout } from "node:timers/promises";

export const loggingTask = task({
  id: "logging-task-2",
  run: async () => {
    console.log("Hello world");
  },
});

export const waitForever = task({
  id: "wait-forever",
  run: async (payload: { freeze?: boolean }) => {
    if (payload.freeze) {
      await wait.for({ years: 9999 });
    } else {
      await logger.trace("Waiting..", async () => {
        await setTimeout(2147483647);
      });
    }
  },
});
