import { logger, task } from "@trigger.dev/sdk";

type RetryPayload = {
  failCount: number;
};

export const retryTask = task({
  id: "retry-task",
  // Configure 5 retries with exponential backoff
  retry: {
    maxAttempts: 5,
    factor: 1.8,
    minTimeoutInMs: 20,
    maxTimeoutInMs: 100,
    randomize: false,
  },
  run: async (payload: RetryPayload, { ctx }) => {
    const currentAttempt = ctx.attempt.number;
    logger.info("Running retry task", {
      currentAttempt,
      desiredFailCount: payload.failCount,
    });

    // If we haven't reached the desired number of failures yet, throw an error
    if (currentAttempt <= payload.failCount) {
      const error = new Error(`Intentionally failing attempt ${currentAttempt}`);
      logger.warn("Task failing", { error, currentAttempt });
      throw error;
    }

    // If we've made it past the desired fail count, return success
    logger.info("Task succeeded", { currentAttempt });
    return {
      attemptsTaken: currentAttempt,
    };
  },
});
