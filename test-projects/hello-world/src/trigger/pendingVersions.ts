import { logger, queue, queues, task, tasks } from "@trigger.dev/sdk/v3";

export const pendingVersionsQueue = queue({
  name: "pending-version-queue",
  concurrencyLimit: 1,
});

export const pendingVersionsTester = task({
  id: "pending-versions-tester",
  run: async (payload: any, { ctx }) => {
    logger.log("Pending versions tester", { payload });

    await tasks.trigger("pending-versions-tester-2", {
      payload: {
        message: "Hello, world!",
      },
    });

    await tasks.trigger(
      "pending-versions-tester-3",
      {
        message: "Hello, world!",
      },
      {
        queue: "pending-version-queue-2",
      }
    );
  },
});

export const pendingVersionsTester3 = task({
  id: "pending-versions-tester-3",
  queue: pendingVersionsQueue,
  run: async (payload: any, { ctx }) => {
    logger.log("Pending versions tester 3", { payload });
  },
});
