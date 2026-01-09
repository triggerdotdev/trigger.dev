import { logger, task, wait } from "@trigger.dev/sdk/v3";


export const ErrorTask = task({
  id: "simple-throw-error",
  maxDuration: 60,
  run: async (payload: any, { ctx }) => {
    logger.log("This task is about to throw an error!", { payload, ctx });

    await wait.for({ seconds: 9 });
    throw new Error("This is an expected test error from ErrorTask!");
  },
  onFailure: async ({ payload, error, ctx }) => {
    logger.warn("ErrorTask failed!", { payload, error, ctx });
  }
});
