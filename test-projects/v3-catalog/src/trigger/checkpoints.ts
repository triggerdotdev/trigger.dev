import { logger, queue, schedules, task, wait } from "@trigger.dev/sdk/v3";

type Payload = {
  count?: number;
};

export const checkpointBatchResumerTester = schedules.task({
  id: "checkpoint-batch-resume-tester",
  run: async () => {
    await checkpointBatchResumer.triggerAndWait({ count: 1 });
  },
});

/** Test that checkpoints and resuming works if the checkpoint isn't created before the resume */
export const checkpointBatchResumer = task({
  id: "checkpoint-batch-resume",
  run: async ({ count = 1 }: Payload) => {
    await noop.batchTriggerAndWait(Array.from({ length: count }, (_, i) => ({})));
    logger.info(`Successfully 1/1 resumed after ${count} runs`);
    // await noop.batchTriggerAndWait(Array.from({ length: count }, (_, i) => ({})));
    // logger.info(`Successfully 2/2 resumed after ${count} runs`);
  },
});

/** Test that checkpoints and resuming works if the checkpoint isn't created before the resume */
export const checkpointResumer = task({
  id: "checkpoint-resume",
  queue: {
    concurrencyLimit: 1,
  },
  run: async ({ count = 1 }: Payload) => {
    logger.info(`Starting ${count} runs`);

    for (let i = 0; i < count; i++) {
      await noop.triggerAndWait();
      logger.info(`Successfully ${i + 1}/${count} resumed`);
    }
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

export const fixedLengthTask = task({
  id: "fixedLengthTask",
  run: async ({ waitSeconds }: { waitSeconds: number }) => {
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  },
});

export const permanentlyFrozen = task({
  id: "permanently-frozen",
  run: async ({ waitSeconds = 160, count = 1 }: { waitSeconds?: number; count?: number }) => {
    for (let i = 0; i < count; i++) {
      await fixedLengthTask.triggerAndWait({ waitSeconds });
      logger.log(`Successfully complted task ${i}`);
    }
  },
});

//sending max concurrency of these at once will test the freeze + max concurrency logic
export const bulkPermanentlyFrozen = task({
  id: "bulk-permanently-frozen",
  run: async ({
    count = 1,
    waitSeconds = 160,
    grandChildCount = 1,
  }: {
    count?: number;
    waitSeconds?: number;
    grandChildCount?: number;
  }) => {
    await permanentlyFrozen.batchTrigger(
      Array.from({ length: count }, (_, i) => ({
        payload: { waitSeconds, count: grandChildCount },
      }))
    );
  },
});

const oneAtATime = queue({
  name: "race-condition",
  concurrencyLimit: 1,
});

export const raceConditionCheckpointDequeue = task({
  id: "race-condition-checkpoint-dequeue",
  queue: oneAtATime,
  run: async ({ isBatch = true }: { isBatch?: boolean }) => {
    await holdConcurrency.trigger({ waitSeconds: 45 });

    if (isBatch) {
      await fixedLengthTask.batchTriggerAndWait(
        Array.from({ length: 1 }, (_, i) => ({
          payload: { waitSeconds: 5 },
        }))
      );
    } else {
      await fixedLengthTask.triggerAndWait({ waitSeconds: 5 });
    }

    logger.log(`Successfully completed task`);
  },
});

export const holdConcurrency = task({
  id: "hold-concurrency",
  queue: oneAtATime,
  run: async ({ waitSeconds = 60 }: { waitSeconds?: number }) => {
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  },
});
