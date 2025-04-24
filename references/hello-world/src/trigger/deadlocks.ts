import { task, queue } from "@trigger.dev/sdk";

const deadlockQueue = queue({
  name: "deadlock-queue",
  concurrencyLimit: 1,
  releaseConcurrencyOnWaitpoint: false,
});

export const deadlockReleasingQueue = queue({
  name: "deadlock-releasing-queue",
  releaseConcurrencyOnWaitpoint: true,
});

export const deadlockTester = task({
  id: "deadlock-tester",
  run: async (payload: any, { ctx }) => {
    // await deadlockNestedTask.triggerAndWait({
    //   message: "Hello, world!",
    // });

    await deadlockNestedTask.batchTriggerAndWait([
      {
        payload: {
          message: "Hello, world!",
        },
      },
      {
        payload: {
          message: "Hello, world!",
        },
      },
    ]);
  },
});

export const deadlockNestedTask = task({
  id: "deadlock-nested-task",
  queue: deadlockQueue,
  run: async (payload: any, { ctx }) => {
    // await deadlockTester.triggerAndWait({
    //   message: "Hello, world!",
    // });

    await deadlockTester.batchTriggerAndWait([
      {
        payload: {
          message: "Hello, world!",
        },
      },
      {
        payload: {
          message: "Hello, world!",
        },
      },
    ]);

    return {
      message: "Hello, world!",
    };
  },
});
