import { logger, task } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

export const oomTask = task({
  id: "oom-task",
  machine: "micro",
  retry: {
    outOfMemory: {
      machine: "small-1x",
    },
  },
  run: async ({ succeedOnLargerMachine }: { succeedOnLargerMachine: boolean }, { ctx }) => {
    logger.info("running out of memory below this line");

    logger.info(`Running on ${ctx.machine?.name}`);

    await setTimeout(2000);

    if (ctx.machine?.name !== "micro" && succeedOnLargerMachine) {
      logger.info("Going to succeed now");
      return {
        success: true,
      };
    }

    let a = "a";

    try {
      while (true) {
        a += a;
      }
    } catch (error) {
      logger.error(error instanceof Error ? error.message : "Unknown error", { error });

      let b = [];
      while (true) {
        b.push(a.replace(/a/g, "b"));
      }
    }
  },
});
