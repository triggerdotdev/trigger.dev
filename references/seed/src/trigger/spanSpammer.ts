import { logger, task, wait } from "@trigger.dev/sdk/v3";

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

    logger.info("Completed span spammer task", context);
    return { message: `Created ${logCount} logs` };
  },
});
