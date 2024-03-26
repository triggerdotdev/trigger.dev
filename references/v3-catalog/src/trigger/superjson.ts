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
      set: new Set([1, 2, 3, 4, 5, 6, 7, 8]),
      map: new Map([
        ["foo", "bar"],
        ["baz", "qux"],
      ]),
      error: new Error("foo"),
      url: new URL("https://trigger.dev"),
    };
  },
});

export const superHugeOutputTask = task({
  id: "super-huge-output-task",
  run: async () => {
    // Returning an object that has 1000 keys, with each key having a value of 100 characters
    return Array.from({ length: 1000 }, (_, i) => [
      i.toString(),
      i.toString().padStart(100, "0"),
    ]).reduce(
      (acc, [key, value]) => {
        acc[key] = value;
        return acc;
      },
      {} as Record<string, string>
    );
  },
});
