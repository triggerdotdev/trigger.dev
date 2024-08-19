import { logger, task } from "@trigger.dev/sdk/v3";

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
  }: {
    depth?: number;
    maxDepth?: number;
    batchSize?: number;
  }) => {
    if (depth >= maxDepth) {
      return;
    }

    logger.log(`${depth}/${maxDepth} depth`);

    const triggerOrBatch = depth % 2 === 0;

    await nestedDependencies.triggerAndWait({ depth: depth + 1, maxDepth });
    logger.log(`Triggered complete`);
    // if (triggerOrBatch) {
    // } else {
    //   await nestedDependencies.batchTriggerAndWait(
    //     Array.from({ length: batchSize }, (_, i) => ({
    //       payload: { depth: depth + 1, maxDepth, batchSize },
    //     }))
    //   );
    //   logger.log(`Batch triggered complete`);
    // }
  },
});

export const noop = task({
  id: "noop",
  run: async () => {},
});
