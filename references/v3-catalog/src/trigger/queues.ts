import { logger, task, wait } from "@trigger.dev/sdk/v3";

export const queuesController = task({
  id: "queues/controller",
  run: async ({
    numberOfQueues = 20,
    length = 20,
    waitSeconds = 3,
  }: {
    numberOfQueues?: number;
    length?: number;
    waitSeconds?: number;
  }) => {
    await queuesTest.batchTriggerAndWait(
      Array.from({ length }, (_, i) => ({
        payload: { waitSeconds },
        options: {
          queue: {
            name: `queue-${i % numberOfQueues}`,
          },
        },
      }))
    );
  },
});

export const queuesTest = task({
  id: "queues/test",
  run: async (payload: { waitSeconds?: number }, { ctx }) => {
    await wait.for({ seconds: payload.waitSeconds ?? 1 });
  },
});
