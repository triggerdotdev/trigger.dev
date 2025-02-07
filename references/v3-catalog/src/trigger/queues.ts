import { logger, runs, task, wait, auth } from "@trigger.dev/sdk/v3";

export const queuesController = task({
  id: "queues/controller",
  run: async (
    {
      numberOfQueues = 20,
      length = 20,
      waitSeconds = 3,
    }: {
      numberOfQueues?: number;
      length?: number;
      waitSeconds?: number;
    },
    { ctx }
  ) => {
    const publicToken = await auth.createPublicToken({
      scopes: {
        read: {
          runs: true,
        },
      },
    });

    logger.debug("Public token", { publicToken });

    await Promise.all([
      queuesTest.trigger(
        { waitSeconds },
        {
          idempotencyKey: ctx.run.id,
        }
      ),
      queuesTest.trigger(
        { waitSeconds },
        {
          idempotencyKey: ctx.run.id,
        }
      ),
      queuesTest.trigger(
        { waitSeconds },
        {
          idempotencyKey: ctx.run.id,
        }
      ),
      queuesTest.trigger(
        { waitSeconds },
        {
          idempotencyKey: ctx.run.id,
        }
      ),
      queuesTest.trigger(
        { waitSeconds },
        {
          idempotencyKey: ctx.run.id,
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

export const inspectApiTraffic = task({
  id: "queues/inspect-api-traffic",
  run: async (payload: unknown, { ctx }) => {
    // Retrieve the run 100 times
    for (let i = 0; i < 100; i++) {
      await runs.retrieve(ctx.run.id);
    }

    const response = await runs.retrieve(ctx.run.id).asResponse();

    // Log out the headers
    const headers = Object.fromEntries(response.headers.entries());

    logger.info("Headers", { headers });
  },
});
