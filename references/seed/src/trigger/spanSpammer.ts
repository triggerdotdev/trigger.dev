import { logger, task, wait, metadata } from "@trigger.dev/sdk/v3";

const CONFIG = {
  delayBetweenBatchesSeconds: 0.2,
  logsPerBatch: 30,
  totalBatches: 100,
  initialDelaySeconds: 5,
} as const;

export const SpanSpammerTask = task({
  id: "span-spammer",
  maxDuration: 300,
  run: async (payload: any, { ctx }) => {
    const context = { payload, ctx };
    let logCount = 0;

    // 30s trace with events every 5s
    await logger.trace("10s-span", async () => {
      const totalSeconds = 10;
      const intervalSeconds = 2;
      const totalEvents = totalSeconds / intervalSeconds;

      logger.info("Starting 30s span", context);

      for (let i = 1; i <= totalEvents; i++) {
        await wait.for({ seconds: intervalSeconds });
        logger.info(`Inner event ${i}/${totalEvents} at ${i * intervalSeconds}s`, context);
      }

      logger.info("Completed 30s span", context);
    });

    logger.info("Starting span spammer task", context);
    logger.warn("This will generate a lot of logs", context);


    const emitBatch = (prefix: string) => {
      logger.debug("Started spam batch emit!", context);

      for (let i = 0; i < CONFIG.logsPerBatch; i++) {
        logger.log(`${prefix} ${++logCount}`, context);
      }

      logger.debug('Completed spam batch emit!', context);
    };

    emitBatch("Log number");
    await wait.for({ seconds: CONFIG.initialDelaySeconds });

    for (let batch = 0; batch < CONFIG.totalBatches; batch++) {
      await wait.for({ seconds: CONFIG.delayBetweenBatchesSeconds });
      emitBatch("This is a test log!!! Log number: ");
    }

    metadata.parent.set("childStatus", "running");
    metadata.parent.increment("completedChildren", 1);

    // Update the root run's metadata (top-level run in the chain)
    metadata.root.set("deepChildStatus", "done");
    metadata.root.append("completedTasks", "child-task");


    logger.info("Completed span spammer task", context);
    return { message: `Created ${logCount} logs` };
  },
});
