import { logger, task } from "@trigger.dev/sdk/v3";

export const priorityParent = task({
  id: "priority-parent",
  run: async (payload: any, { ctx }) => {
    logger.log("Hello, world from the parents", { payload });

    const batch1 = await priorityChild.batchTriggerAndWait([
      {
        payload: { order: 1 },
      },
      {
        payload: { order: 2 },
        options: { priority: 1 },
      },
      {
        payload: { order: 3 },
        options: { priority: 2 },
      },
    ]);
  },
});

export const priorityChild = task({
  id: "priority-child",
  queue: {
    concurrencyLimit: 1,
  },
  run: async ({ order }: { order: number }, { ctx }) => {
    logger.log(`Priority ${ctx.run.priority}`);
  },
});
