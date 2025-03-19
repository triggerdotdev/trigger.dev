import { logger, queues, task } from "@trigger.dev/sdk/v3";

export const queuesTester = task({
  id: "queues-tester",
  run: async (payload: any, { ctx }) => {
    const q = await queues.list();

    for await (const queue of q) {
      logger.log("Queue", { queue });
    }

    const retrievedFromId = await queues.retrieve(ctx.queue.id);
    logger.log("Retrieved from ID", { retrievedFromId });

    const retrievedFromCtxName = await queues.retrieve({
      type: "task",
      name: ctx.queue.name,
    });
    logger.log("Retrieved from name", { retrievedFromCtxName });

    //pause the queue
    const pausedQueue = await queues.pause({
      type: "task",
      name: "queues-tester",
    });
    logger.log("Paused queue", { pausedQueue });

    const retrievedFromName = await queues.retrieve({
      type: "task",
      name: "queues-tester",
    });
    logger.log("Retrieved from name", { retrievedFromName });

    //resume the queue
    const resumedQueue = await queues.resume({
      type: "task",
      name: "queues-tester",
    });
    logger.log("Resumed queue", { resumedQueue });
  },
});

export const otherQueueTask = task({
  id: "other-queue-task",
  queue: {
    name: "my-custom-queue",
    concurrencyLimit: 1,
  },
  run: async (payload: any, { ctx }) => {
    logger.log("Other queue task", { payload });
  },
});
