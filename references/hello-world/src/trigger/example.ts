import { logger, task, wait } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload: any, { ctx }) => {
    logger.debug("debug: Hello, world!", { payload });
    logger.info("info: Hello, world!", { payload });
    logger.log("log: Hello, world!", { payload });
    logger.warn("warn: Hello, world!", { payload });
    logger.error("error: Hello, world!", { payload });

    await wait.for({ seconds: 5 });

    return {
      message: "Hello, world!",
    };
  },
});

export const parentTask = task({
  id: "parent",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world from the parent", { payload });
    await childTask.triggerAndWait({ message: "Hello, world!" });
  },
});

export const childTask = task({
  id: "child",
  run: async (payload: any, { ctx }) => {
    logger.info("Hello, world from the child", { payload });

    if (Math.random() > 0.5) {
      throw new Error("Random error at start");
    }

    await setTimeout(10000);

    if (Math.random() > 0.5) {
      throw new Error("Random error at end");
    }
  },
});
