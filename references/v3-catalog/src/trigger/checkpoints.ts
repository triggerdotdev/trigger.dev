import { logger, task, wait } from "@trigger.dev/sdk/v3";

type Payload = {
  count?: number;
};

/** Test that checkpoints and resuming works if the checkpoint isn't created before the resume */
export const checkpointBatchResumer = task({
  id: "checkpoint-batch-resume",
  run: async ({ count = 1 }: Payload) => {
    await noop.batchTriggerAndWait(Array.from({ length: count }, (_, i) => ({})));
    logger.info(`Successfully 1/1 resumed after ${count} runs`);
    await noop.batchTriggerAndWait(Array.from({ length: count }, (_, i) => ({})));
    logger.info(`Successfully 2/2 resumed after ${count} runs`);
  },
});

/** Test that checkpoints and resuming works if the checkpoint isn't created before the resume */
export const checkpointResumer = task({
  id: "checkpoint-resume",
  run: async ({ count = 1 }: Payload) => {
    await noop.triggerAndWait();
    logger.info(`Successfully 1/3 resumed`);
    await noop.triggerAndWait();
    logger.info(`Successfully 2/3 resumed`);
    await noop.triggerAndWait();
    logger.info(`Successfully 3/3 resumed`);
  },
});

export const nestedDependencies = task({
  id: "nested-dependencies",
  run: async ({
    depth = 0,
    maxDepth = 6,
    batchSize = 4,
    waitSeconds = 1,
    failAttemptChance = 0,
  }: {
    depth?: number;
    maxDepth?: number;
    batchSize?: number;
    waitSeconds?: number;
    failAttemptChance?: number;
  }) => {
    if (depth >= maxDepth) {
      return;
    }

    logger.log(`Started ${depth}/${maxDepth} depth`);

    const shouldFail = Math.random() < failAttemptChance;
    if (shouldFail) {
      throw new Error(`Failed at ${depth}/${maxDepth} depth`);
    }

    await wait.for({ seconds: waitSeconds });

    const triggerOrBatch = depth % 2 === 0;

    if (triggerOrBatch) {
      await nestedDependencies.triggerAndWait({
        depth: depth + 1,
        maxDepth,
        waitSeconds,
        failAttemptChance,
      });
      logger.log(`Triggered complete`);
    } else {
      await nestedDependencies.batchTriggerAndWait(
        Array.from({ length: batchSize }, (_, i) => ({
          payload: { depth: depth + 1, maxDepth, batchSize, waitSeconds, failAttemptChance },
        }))
      );
      logger.log(`Batch triggered complete`);
    }

    logger.log(`Sleep for ${waitSeconds} seconds`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

    logger.log(`Finished ${depth}/${maxDepth} depth`);
  },
});

export const fastWait = task({
  id: "fast-wait",
  run: async ({ seconds = 1 }: { seconds?: number }) => {
    logger.log(`Going to wait for ${seconds} seconds`);
    await wait.for({ seconds });
    logger.log(`Waited for ${seconds} seconds`);
  },
});

export const noop = task({
  id: "noop",
  run: async () => {},
});
