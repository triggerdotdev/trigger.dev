import { Context, logger, task } from "@trigger.dev/sdk/v3";

export const simpleParentTask = task({
  id: "simple-parent-task",
  run: async (payload: { message: string }) => {
    await simpleChildTask.trigger({
      payload: {
        message: `${payload.message} - 2.a`,
      },
    });

    await simpleChildTask.triggerAndWait({
      payload: {
        message: `${payload.message} - 2.b`,
      },
    });

    await simpleChildTask.batchTrigger({
      items: [
        {
          payload: {
            message: `${payload.message} - 2.c`,
          },
        },
      ],
    });

    await simpleChildTask.batchTriggerAndWait({
      items: [
        {
          payload: {
            message: `${payload.message} - 2.d`,
          },
        },
      ],
    });

    return {
      hello: "world",
    };
  },
});

export const simpleChildTask = task({
  id: "simple-child-task",
  run: async (payload: { message: string }, { ctx }) => {
    logger.log("Simple child task payload", { payload, ctx });
  },
});
