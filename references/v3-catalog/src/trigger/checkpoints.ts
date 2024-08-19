import { logger, task } from "@trigger.dev/sdk/v3";

type Payload = {
  count?: number;
};

/** Test that checkpoints and resuming works if the checkpoint isn't created before the resume */
export const checkpointBatchResumer = task({
  id: "checkpoint-batch-resume",
  run: async ({ count = 1 }: Payload) => {
    await noop.batchTriggerAndWait(Array.from({ length: count }, (_, i) => ({})));
    logger.info(`Successfully resumed after ${count} runs`);
  },
});

export const noop = task({
  id: "noop",
  run: async () => {},
});
