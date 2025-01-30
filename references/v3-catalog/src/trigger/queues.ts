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
    await Promise.all([
      queuesTest.trigger(
        { waitSeconds },
        {
          queue: {
            name: "controller-3",
            concurrencyLimit: 9,
          },
        }
      ),
      queuesTest.trigger(
        { waitSeconds },
        {
          queue: {
            name: "controller-3",
            concurrencyLimit: 9,
          },
        }
      ),
      queuesTest.trigger(
        { waitSeconds },
        {
          queue: {
            name: "controller-3",
            concurrencyLimit: 9,
          },
        }
      ),
      queuesTest.trigger(
        { waitSeconds },
        {
          queue: {
            name: "controller-3",
            concurrencyLimit: 9,
          },
        }
      ),
      queuesTest.trigger(
        { waitSeconds },
        {
          queue: {
            name: "controller-3",
            concurrencyLimit: 9,
          },
        }
      ),
    ]);
  },
});

export const queuesTest = task({
  id: "queues/test",
  run: async (payload: { waitSeconds?: number }, { ctx }) => {
    await wait.for({ seconds: payload.waitSeconds ?? 1 });
  },
});

export const namedQueueTask = task({
  id: "queues/named-queue",
  queue: {
    name: "controller",
    concurrencyLimit: 9,
  },
  run: async () => {
    logger.info("named-queue 2");
  },
});
