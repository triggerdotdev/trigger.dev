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
  }: {
    depth?: number;
    maxDepth?: number;
    batchSize?: number;
    waitSeconds?: number;
  }) => {
    if (depth >= maxDepth) {
      return;
    }

    logger.log(`Started ${depth}/${maxDepth} depth`);

    await wait.for({ seconds: waitSeconds });

    const triggerOrBatch = depth % 2 === 0;

    if (triggerOrBatch) {
      await nestedDependencies.triggerAndWait({ depth: depth + 1, maxDepth, waitSeconds });
      logger.log(`Triggered complete`);
    } else {
      await nestedDependencies.batchTriggerAndWait(
        Array.from({ length: batchSize }, (_, i) => ({
          payload: { depth: depth + 1, maxDepth, batchSize, waitSeconds },
        }))
      );
      logger.log(`Batch triggered complete`);
    }

    await wait.for({ seconds: waitSeconds });

    logger.log(`Finished ${depth}/${maxDepth} depth`);
  },
});

export const noop = task({
  id: "noop",
  run: async () => {},
});
