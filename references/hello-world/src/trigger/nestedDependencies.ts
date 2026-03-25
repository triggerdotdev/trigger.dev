import { logger, task, wait } from "@trigger.dev/sdk";

export const nestedDependencies = task({
  id: "nested-dependencies",
  run: async ({
    depth = 0,
    maxDepth = 6,
    batchSize = 4,
    waitSeconds = 1,
    failAttemptChance = 0,
    failParents = false,
  }: {
    depth?: number;
    maxDepth?: number;
    batchSize?: number;
    waitSeconds?: number;
    failAttemptChance?: number;
    failParents?: boolean;
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
      for (let i = 0; i < batchSize; i++) {
        const result = await nestedDependencies.triggerAndWait({
          depth: depth + 1,
          maxDepth,
          waitSeconds,
          failAttemptChance,
          batchSize,
        });
        logger.log(`Triggered complete ${i + 1}/${batchSize}`);

        if (!result.ok && failParents) {
          throw new Error(`Failed at ${depth}/${maxDepth} depth`);
        }
      }
    } else {
      const results = await nestedDependencies.batchTriggerAndWait(
        Array.from({ length: batchSize }, (_, i) => ({
          payload: {
            depth: depth + 1,
            maxDepth,
            batchSize,
            waitSeconds,
            failAttemptChance,
          },
        }))
      );
      logger.log(`Batch triggered complete`);

      if (results.runs.some((r) => !r.ok) && failParents) {
        throw new Error(`Failed at ${depth}/${maxDepth} depth`);
      }
    }

    logger.log(`Sleep for ${waitSeconds} seconds`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

    logger.log(`Finished ${depth}/${maxDepth} depth`);
  },
});
