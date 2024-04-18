import { logger, task } from "@trigger.dev/sdk/v3";

export const superParentTask = task({
  id: "super-parent-task",
  run: async () => {
    const result = await superChildTask.triggerAndWait({
      payload: {
        foo: "bar",
        whenToDo: new Date(),
      },
    });

    logger.log(`typeof result.date = ${typeof result.date}`);
    logger.log(`typeof result.regex = ${typeof result.regex}`);
    logger.log(`typeof result.bigint = ${typeof result.bigint}`);
    logger.log(`typeof result.set = ${typeof result.set}`);
    logger.log(`typeof result.map = ${typeof result.map}`);
    logger.log(`typeof result.error = ${typeof result.error}`);
    logger.log(`typeof result.url = ${typeof result.url}`);

    return "## super-parent-task completed";
  },
});

export const superChildTask = task({
  id: "super-child-task",
  run: async (payload: { whenToDo: Date; foo: string }) => {
    logger.log("super-child-task payload: ", { payload });
    logger.log(`typeof payload.whenToDo = ${typeof payload.whenToDo}`);
    logger.log(`typeof payload.foo = ${typeof payload.foo}`);

    return {
      date: new Date(),
      regex: /foo/,
      bigint: BigInt(123),
      set: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
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
    const largePayload = createLargeObject(1000, 128);

    const result = await superHugeOutputTask.triggerAndWait({
      payload: largePayload,
    });

    logger.log("Result from superHugeOutputTask: ", { result });

    const batchResult = await superHugeOutputTask.batchTriggerAndWait({
      items: [
        { payload: largePayload },
        {
          payload: {
            small: "object",
          },
        },
        { payload: largePayload },
        {
          payload: {
            small: "object",
          },
        },
        { payload: largePayload },
        {
          payload: {
            small: "object",
          },
        },
        { payload: largePayload },
        {
          payload: {
            small: "object",
          },
        },
        { payload: largePayload },
        {
          payload: {
            small: "object",
          },
        },
        { payload: largePayload },
        {
          payload: {
            small: "object",
          },
        },
        { payload: largePayload },
        {
          payload: {
            small: "object",
          },
        },
        { payload: largePayload },
        {
          payload: {
            small: "object",
          },
        },
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
  run: async (payload) => {
    return payload;
  },
});

export const superStringTask = task({
  id: "super-string-parent-task",
  run: async () => {
    const result = await superStringChildTask.triggerAndWait({
      payload: {
        foo: "bar",
      },
    });

    return result;
  },
});

export const superStringChildTask = task({
  id: "super-string-child-task",
  run: async () => {
    return "## super-string-child-task completed";
  },
});

export const superBadOutputTask = task({
  id: "super-bad-output-task",
  run: async () => {
    // Returning something that cannot be serialized

    return () => {};
  },
});

function createLargeObject(size: number, length: number) {
  return Array.from({ length }, (_, i) => [i.toString(), i.toString().padStart(size, "0")]).reduce(
    (acc, [key, value]) => {
      acc[key] = value;
      return acc;
    },
    {} as Record<string, string>
  );
}
