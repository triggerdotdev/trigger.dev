import { logger, task } from "@trigger.dev/sdk/v3";

export const superParentTask = task({
  id: "super-parent-task",
  run: async () => {
    const result = await superChildTask.triggerAndWait({
      payload: {
        foo: "bar",
      },
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
      set: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      map: new Map([
        ["foo", "bar"],
        ["baz", "qux"],
      ]),
      error: new Error("foo"),
      url: new URL("https://trigger.dev"),
    };
  },
});

export const superHugePayloadTask = task({
  id: "super-huge-payload-task",
  run: async () => {
    const largePayload = createLargeObject(1000, 100);

    const result = await superHugeOutputTask.triggerAndWait({
      payload: largePayload,
    });

    logger.log("Result from superHugeOutputTask: ", { result });

    const batchResult = await superHugeOutputTask.batchTriggerAndWait({
      items: [
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
        { payload: largePayload },
      ],
    });

    logger.log("Result from superHugeOutputTask batchTriggerAndWait: ", { batchResult });

    return {
      result,
    };
  },
});

export const superHugeOutputTask = task({
  id: "super-huge-output-task",
  run: async () => {
    return createLargeObject(1000, 100);
  },
});

function createLargeObject(i: number, length: number) {
  return Array.from({ length }, (_, i) => [i.toString(), i.toString().padStart(i, "0")]).reduce(
    (acc, [key, value]) => {
      acc[key] = value;
      return acc;
    },
    {} as Record<string, string>
  );
}
