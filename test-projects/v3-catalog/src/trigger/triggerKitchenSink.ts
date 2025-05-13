import { tasks, task } from "@trigger.dev/sdk/v3";

export const triggerKitchenSink = task({
  id: "trigger-kitchen-sink",
  run: async (payload: { message: string }) => {
    await triggerKitchenSinkChild.trigger({
      message: `${payload.message} - 2.b`,
    });

    await tasks.trigger<typeof triggerKitchenSinkChild>("trigger-kitchen-sink-child", {
      message: `${payload.message} - 2.c`,
    });

    await triggerKitchenSinkChild.triggerAndWait({
      message: `${payload.message} - 2.b`,
    });

    await tasks.triggerAndWait<typeof triggerKitchenSinkChild>("trigger-kitchen-sink-child", {
      message: `${payload.message} - 2.c`,
    });

    await triggerKitchenSinkChild.batchTrigger([
      {
        payload: {
          message: `${payload.message} - 2.c`,
        },
      },
      {
        payload: {
          message: `${payload.message} - 2.cc`,
        },
      },
    ]);

    await tasks.batchTrigger<typeof triggerKitchenSinkChild>("trigger-kitchen-sink-child", [
      {
        payload: {
          message: `${payload.message} - 2.c`,
        },
      },
      {
        payload: {
          message: `${payload.message} - 2.cc`,
        },
      },
    ]);

    await triggerKitchenSinkChild.batchTriggerAndWait([
      {
        payload: {
          message: `${payload.message} - 2.d`,
        },
      },
      {
        payload: {
          message: `${payload.message} - 2.dd`,
        },
      },
    ]);

    await tasks.batchTriggerAndWait<typeof triggerKitchenSinkChild>("trigger-kitchen-sink-child", [
      {
        payload: {
          message: `${payload.message} - 2.d`,
        },
      },
      {
        payload: {
          message: `${payload.message} - 2.dd`,
        },
      },
    ]);

    return {
      hello: "world",
    };
  },
});

export const triggerKitchenSinkChild = task({
  id: "trigger-kitchen-sink-child",
  run: async (payload: { message: string }) => {
    return {
      foo: payload.message,
    };
  },
});
