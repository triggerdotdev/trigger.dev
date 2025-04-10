import { logger, metadata, task, wait, WaitpointTimeoutError } from "@trigger.dev/sdk/v3";

export type ReviewPayload =
  | {
      approved: true;
      approvedAt: Date;
      approvedBy: string;
    }
  | {
      approved: false;
      rejectedAt: Date;
      rejectedBy: string;
      reason: string;
    };
export type ReviewStatus = "pending" | "approved" | "rejected" | "timeout";

export const reviewSummary = task({
  id: "review-summary",
  run: async (payload: { audioSummaryUrl: string; waitpointTokenId: string }) => {
    metadata.set("waitpointTokenId", payload.waitpointTokenId);
    metadata.set("audioSummaryUrl", payload.audioSummaryUrl);
    metadata.set("reviewStatus", "pending" satisfies ReviewStatus);

    const result = await wait.forToken<ReviewPayload>({ id: payload.waitpointTokenId });

    if (!result.ok) {
      if (result.error instanceof WaitpointTimeoutError) {
        metadata.set("reviewStatus", "timeout" satisfies ReviewStatus);
        logger.warn("Review summary waitpoint timed out");
      }

      throw result.error;
    }

    metadata.set(
      "reviewStatus",
      (result.output.approved ? "approved" : "rejected") satisfies ReviewStatus
    );

    return { ...result.output, audioSummaryUrl: payload.audioSummaryUrl };
  },
});
