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

    const retrievedFromName = await queues.retrieve({
      type: "task",
      name: "queues-tester",
    });
    logger.log("Retrieved from name", { retrievedFromName });
  },
});
