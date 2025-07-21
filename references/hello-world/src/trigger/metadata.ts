import { logger, metadata, task } from "@trigger.dev/sdk";
import { setTimeout } from "node:timers/promises";

export const metadataTestTask = task({
  id: "metadata-tester",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 1000,
    factor: 1.5,
  },
  run: async (payload: any, { ctx, signal }) => {
    let iteration = 0;

    while (!signal.aborted) {
      await setTimeout(1000);

      iteration++;

      metadata.set(`test-key-${iteration}`, `test-value-${iteration}`);
      metadata.append(`test-keys-${iteration}`, `test-value-${iteration}`);
      metadata.increment(`test-counter-${iteration}`, 1);

      await setTimeout(1000);
    }

    logger.info("Run completed", { iteration });

    return {
      success: true,
    };
  },
  onCancel: async ({ runPromise }) => {
    await metadata.flush();
    await runPromise;
  },
});
