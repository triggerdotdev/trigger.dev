import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const batchParentTask = task({
  id: "batch-parent-task",
  run: async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      payload: {
        id: `item${i}`,
        name: `Item Name ${i}`,
        description: `This is a description for item ${i}`,
        value: i,
        timestamp: new Date().toISOString(),
        foo: {
          id: `item${i}`,
          name: `Item Name ${i}`,
          description: `This is a description for item ${i}`,
          value: i,
          timestamp: new Date().toISOString(),
        },
        bar: {
          id: `item${i}`,
          name: `Item Name ${i}`,
          description: `This is a description for item ${i}`,
          value: i,
          timestamp: new Date().toISOString(),
        },
      },
      options: {
        idempotencyKey: `item${i}`,
      },
    }));

    return await batchChildTask.batchTrigger(items);
  },
});

export const triggerWithQueue = task({
  id: "trigger-with-queue",
  run: async () => {
    await batchChildTask.trigger(
      {},
      {
        queue: {
          name: "batch-queue-foo",
          concurrencyLimit: 10,
        },
      }
    );
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
