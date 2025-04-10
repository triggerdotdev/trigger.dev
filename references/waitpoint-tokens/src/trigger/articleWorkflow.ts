import { batch, Context, task } from "@trigger.dev/sdk/v3";
import { scrape } from "./scrapeSite";
import { summarizeArticle } from "./summarizeArticle";
import { convertTextToSpeech } from "./convertTextToSpeech";
import { reviewSummary } from "./reviewSummary";
import { publishSummary } from "./publishSummary";
import { sendSlackNotification } from "./sendSlackNotification";

export const articleWorkflow = task({
  id: "article-workflow",
  run: async (
    payload: { articleUrl: string; approvalWaitpointTokenId: string },
    { ctx }: { ctx: Context }
  ) => {
    const scrapeResult = await scrape.triggerAndWait(
      {
        url: payload.articleUrl,
      },
      { tags: ctx.run.tags }
    );

    if (!scrapeResult.ok) {
      throw new Error("Failed to scrape site");
    }

    const summarizeResult = await summarizeArticle.triggerAndWait(
      {
        content: scrapeResult.output.content,
      },
      { tags: ctx.run.tags }
    );

    if (!summarizeResult.ok) {
      throw new Error("Failed to summarize article");
    }

    const convertTextToSpeechResult = await convertTextToSpeech.triggerAndWait(
      {
        text: summarizeResult.output.summary,
      },
      { tags: ctx.run.tags }
    );

    if (!convertTextToSpeechResult.ok) {
      throw new Error("Failed to convert text to speech");
    }

    const reviewSummaryResult = await reviewSummary.triggerAndWait(
      {
        audioSummaryUrl: convertTextToSpeechResult.output.audioUrl,
        waitpointTokenId: payload.approvalWaitpointTokenId,
      },
      { tags: ctx.run.tags }
    );

    if (!reviewSummaryResult.ok) {
      throw new Error("Failed to review summary");
    }

    if (reviewSummaryResult.output.approved) {
      const {
        runs: [sendSlackNotificationRun, publishSummaryRun],
      } = await batch.triggerByTaskAndWait([
        {
          task: sendSlackNotification,
          payload: {
            message: `Article summary was approved by ${reviewSummaryResult.output.approvedBy} at ${reviewSummaryResult.output.approvedAt}`,
          },
          options: { tags: ctx.run.tags },
        },
        {
          task: publishSummary,
          payload: {
            audioSummaryUrl: convertTextToSpeechResult.output.audioUrl,
            articleUrl: payload.articleUrl,
          },
          options: { tags: ctx.run.tags },
        },
      ]);

      if (!sendSlackNotificationRun.ok) {
        throw new Error("Failed to send Slack notification");
      }

      if (!publishSummaryRun.ok) {
        throw new Error("Failed to publish summary");
      }
    }
  },
});
