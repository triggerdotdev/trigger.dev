import { logger, task, wait, tasks, tags } from "@trigger.dev/sdk/v3";
import { taskWithRetries } from "./retries.js";

export const simpleParentTask = task({
  id: "simple-parent-task",
  run: async (payload: { message: string }) => {
    await simpleChildTask.trigger({
      message: `${payload.message} - 2.b`,
    });

    await tasks.trigger<typeof simpleChildTask>("simple-child-task", {
      message: `${payload.message} - 2.c`,
    });

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

    logger.log("Context tags", { tags: ctx.run.tags });
    await tags.add("product:1");

    await wait.for({ seconds: 10 });

    return {
      foo: "bar",
    };
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

export const simpleTaskParentWithSubtasks = task({
  id: "simple-task-parent-with-subtask",
  run: async ({ message = "test" }: { message?: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await simpleChildTask.triggerAndWait({ message: `${message} - 1` });

    return {
      hello: "world",
    };
  },
});

export const deeplyNestedTaskParent = task({
  id: "deeply-nested-task-parent",
  run: async ({ message = "test" }: { message?: string }) => {
    await deeplyNestedTaskChild.triggerAndWait({ message: `${message} - 1` });

    return {
      hello: "world",
    };
  },
});

export const deeplyNestedTaskChild = task({
  id: "deeply-nested-task-child",
  run: async ({ message = "test" }: { message?: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await deeplyNestedTaskGrandchild.triggerAndWait({ message: `${message} - 2` });

    return {
      hello: "world",
    };
  },
});

export const deeplyNestedTaskGrandchild = task({
  id: "deeply-nested-task-grandchild",
  run: async ({ message = "test" }: { message?: string }) => {
    await deeplyNestedTaskGreatGrandchild.batchTriggerAndWait(
      Array.from({ length: 100 }, (_, i) => ({ payload: { message: `${message} - ${i}` } }))
    );

    return {
      hello: "world",
    };
  },
});

export const deeplyNestedTaskGreatGrandchild = task({
  id: "deeply-nested-task-great-grandchild",
  run: async ({ message = "test" }: { message?: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 10000));

    return {
      hello: "world",
    };
  },
});

export const dependencyCancellationParent = task({
  id: "dependency-cancellation-parent",
  run: async ({ message = "test" }: { message?: string }) => {
    const handle = await dependencyCancellationChild.triggerAndWait({ message: `${message} - 1` });

    return {
      hello: "world",
    };
  },
});

export const dependencyCancellationChild = task({
  id: "dependency-cancellation-child",
  run: async ({ message = "test" }: { message?: string }) => {
    await dependencyCancellationGrandchild.triggerAndWait({ message: `${message} - 2` });

    return {
      hello: "world",
    };
  },
});

export const dependencyCancellationGrandchild = task({
  id: "dependency-cancellation-grandchild",
  run: async ({ message = "test" }: { message?: string }) => {
    await wait.for({ seconds: 30 });

    return {
      hello: "world",
    };
  },
});

export const batchDependencyCancellationParent = task({
  id: "batch-dependency-cancellation-parent",
  run: async ({ message = "test" }: { message?: string }) => {
    const handle = await batchDependencyCancellationChild.batchTriggerAndWait(
      Array.from({ length: 10 }, (_, i) => ({ payload: { message: `${message} - ${i}` } }))
    );

    return {
      hello: "world",
    };
  },
});

export const batchDependencyCancellationChild = task({
  id: "batch-dependency-cancellation-child",
  run: async ({ message = "test" }: { message?: string }) => {
    const handle = await batchDependencyCancellationGrandChild.batchTriggerAndWait(
      Array.from({ length: 10 }, (_, i) => ({ payload: { message: `${message} - ${i}` } }))
    );

    return {
      hello: "world",
    };
  },
});

export const batchDependencyCancellationGrandChild = task({
  id: "batch-dependency-cancellation-grandchild",
  run: async ({ message = "test" }: { message?: string }) => {
    await wait.for({ seconds: 30 });

    return {
      hello: "world",
    };
  },
});
