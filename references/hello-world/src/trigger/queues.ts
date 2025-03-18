import { logger, queues, task } from "@trigger.dev/sdk/v3";

export const queuesTester = task({
  id: "queues-tester",
  run: async (payload: any, { ctx }) => {
    const q = await queues.list();

    for await (const queue of q) {
      logger.log("Queue", { queue });
    }
  },
});
