import { logger, task } from "@trigger.dev/sdk";

export const circularPayloadParentTask = task({
  id: "circular-payload-parent",
  run: async (payload: any) => {
    const circularReferencePayload = {
      name: "Alice",
      details: {
        age: 30,
        email: "alice@example.com",
      },
    };

    // @ts-expect-error - This is a circular reference
    circularReferencePayload.details.user = circularReferencePayload;

    await circularPayloadChildTask.triggerAndWait(circularReferencePayload);

    return {
      message: "Hello, world!",
    };
  },
});

export const circularPayloadChildTask = task({
  id: "circular-payload-child",
  run: async (payload: any) => {
    logger.log("response", { response: payload.response });

    return {
      message: "Hello, world!",
    };
  },
});
