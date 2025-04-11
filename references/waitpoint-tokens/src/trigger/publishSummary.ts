import { logger, task, wait, Context } from "@trigger.dev/sdk/v3";

export const publishSummary = task({
  id: "publish-summary",
  retry: {
    maxAttempts: 4,
  },
  run: async (payload: { audioSummaryUrl: string; articleUrl: string }, { ctx }) => {
    // This task does not actually do anything, it's just a placeholder step in the workflow.
    // The actual logic would depend on your use case.

    if (ctx.attempt.number <= 2) {
      // just a dummy error to test the retry
      throw new Error("Unlucky attempt!");
    }

    const { audioSummaryUrl, articleUrl } = payload;
    logger.info("Summary published", { audioSummaryUrl, articleUrl });
  },
});
