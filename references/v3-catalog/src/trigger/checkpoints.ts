import { tasks, task, logger } from "@trigger.dev/sdk/v3";

/** Test that checkpoints and resuming works if the checkpoint isn't created before the resume */
export const checkpointBatchResumer = task({
  id: "checkpoint-batch-resume",
  run: async () => {
    await noop.batchTriggerAndWait([{}]);
    logger.info("Successfully resumed");
  },
});

export const noop = task({
  id: "noop",
  run: async () => {},
});
