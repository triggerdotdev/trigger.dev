import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const batchParentTask = task({
  id: "batch-parent-task",
  run: async () => {
    const response = await batchChildTask.batchTrigger([
      { payload: "item1" },
      { payload: "item2" },
      { payload: "item3" },
    ]);

    logger.info("Batch task response", { response });

    await wait.for({ seconds: 5 });
    await wait.until({ date: new Date(Date.now() + 1000 * 5) }); // 5 seconds

    const waitResponse = await batchChildTask.batchTriggerAndWait([
      { payload: "item4" },
      { payload: "item5" },
      { payload: "item6" },
    ]);

    logger.info("Batch task wait response", { waitResponse });

    return response.batchId;
  },
});

export const batchChildTask = task({
  id: "batch-child-task",
  run: async (payload: string, { ctx }) => {
    logger.info("Processing child task", { payload });

    await wait.for({ seconds: 1 });

    return `${payload} - processed`;
  },
});
