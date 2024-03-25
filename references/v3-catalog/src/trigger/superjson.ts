import { logger, task } from "@trigger.dev/sdk/v3";

export const superParentTask = task({
  id: "super-parent-task",
  run: async () => {
    const result = await superChildTask.triggerAndWait({
      payload: {},
    });

    logger.log(`typeof result.date = ${typeof result.date}`);
    logger.log(`typeof result.regex = ${typeof result.regex}`);
    logger.log(`typeof result.bigint = ${typeof result.bigint}`);
    logger.log(`typeof result.set = ${typeof result.set}`);
    logger.log(`typeof result.map = ${typeof result.map}`);
    logger.log(`typeof result.error = ${typeof result.error}`);
    logger.log(`typeof result.url = ${typeof result.url}`);

    return {
      result,
    };
  },
});

export const superChildTask = task({
  id: "super-child-task",
  run: async () => {
    return {
      date: new Date(),
      regex: /foo/,
      bigint: BigInt(123),
      set: new Set([1, 2, 3]),
      map: new Map([["foo", "bar"]]),
      error: new Error("foo"),
      url: new URL("https://trigger.dev"),
    };
  },
});
