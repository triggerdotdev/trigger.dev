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

export const batchParentWitFailsTask = task({
  id: "batch-parent-with-fails-task",
  retry: {
    maxAttempts: 1,
  },
  run: async () => {
    const response = await taskThatFails.batchTriggerAndWait([
      { payload: false },
      { payload: true },
      { payload: false },
    ]);

    logger.info("Batch response", { response });

    const respone2 = await taskThatFails.batchTriggerAndWait([
      { payload: true },
      { payload: false },
      { payload: true },
    ]);

    logger.info("Batch response2", { respone2 });
  },
});

export const batchChildTask = task({
  id: "batch-child-task",
  retry: {
    maxAttempts: 2,
  },
  run: async (payload: any, { ctx }) => {
    logger.info("Processing child task", { payload });

    await wait.for({ seconds: 1 });

    return `${payload} - processed`;
  },
});

export const taskThatFails = task({
  id: "task-that-fails",
  retry: {
    maxAttempts: 2,
  },
  run: async (fail: boolean) => {
    logger.info(`Will fail ${fail}`);

    if (fail) {
      throw new Error("Task failed");
    }

    return {
      foo: "bar",
    };
  },
});
