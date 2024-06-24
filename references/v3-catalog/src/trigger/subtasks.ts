import { logger, task, wait, tasks } from "@trigger.dev/sdk/v3";
import { taskWithRetries } from "./retries";

export const simpleParentTask = task({
  id: "simple-parent-task",
  run: async (payload: { message: string }) => {
    await simpleChildTask.triggerAndWait({
      message: `${payload.message} - 2.b`,
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

    await wait.for({ seconds: 6 });
  },
});

export const subtasksWithRetries = task({
  id: "subtasks-with-retries",
  run: async (payload: { message: string }) => {
    await taskWithRetries.triggerAndWait({
      message: `${payload.message} - 2.b`,
    });

    await taskWithRetries.batchTrigger([
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

    await taskWithRetries.batchTriggerAndWait([
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

    await taskWithRetries.triggerAndWait({
      message: `${payload.message} - 2.e`,
    });

    await taskWithRetries.batchTriggerAndWait([
      {
        payload: {
          message: `${payload.message} - 2.f`,
        },
      },
      {
        payload: {
          message: `${payload.message} - 2.ff`,
        },
      },
    ]);

    return {
      hello: "world",
    };
  },
});

export const multipleTriggerWaits = task({
  id: "multiple-trigger-waits",
  run: async ({ message = "test" }: { message?: string }) => {
    await simpleChildTask.triggerAndWait({ message: `${message} - 1.a` });
    await simpleChildTask.triggerAndWait({ message: `${message} - 2.a` });

    await simpleChildTask.batchTriggerAndWait([
      { payload: { message: `${message} - 3.a` } },
      { payload: { message: `${message} - 3.b` } },
    ]);
    await simpleChildTask.batchTriggerAndWait([
      { payload: { message: `${message} - 4.a` } },
      { payload: { message: `${message} - 4.b` } },
    ]);

    return {
      hello: "world",
    };
  },
});

export const triggerAndWaitLoops = task({
  id: "trigger-wait-loops",
  run: async ({ message = "test" }: { message?: string }) => {
    for (let i = 0; i < 2; i++) {
      await simpleChildTask.triggerAndWait({ message: `${message} - ${i}` });
    }

    for (let i = 0; i < 2; i++) {
      await simpleChildTask.batchTriggerAndWait([
        { payload: { message: `${message} - ${i}.a` } },
        { payload: { message: `${message} - ${i}.b` } },
      ]);
    }

    const handle = await taskWithNoPayload.trigger();
    await taskWithNoPayload.triggerAndWait();
    await taskWithNoPayload.batchTrigger([{}]);
    await taskWithNoPayload.batchTriggerAndWait([{}]);

    // Don't do this!
    // await Promise.all(
    //   [{ message: `${message} - 1` }, { message: `${message} - 2` }].map((payload) =>
    //     simpleChildTask.triggerAndWait({ payload })
    //   )
    // );
  },
});

export const taskWithNoPayload = task({
  id: "task-with-no-payload",
  run: async () => {
    logger.log("Task with no payload");

    return { hello: "world" };
  },
});
