import { logger, task, wait } from "@trigger.dev/sdk/v3";

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
