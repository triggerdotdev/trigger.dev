import { logger, task } from "@trigger.dev/sdk/v3";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export const summarizeArticle = task({
  id: "summarize-article",
  maxDuration: 300,
  run: async (payload: { content: string }) => {
    const { text } = await generateText({
      model: openai("gpt-4o-mini"),
      prompt: `
      Summarize the following article in a concise manner, focus on the main body of the article and generate a summary that sounds good in speech too.
      The result will be converted to speech for a news report. Make it no longer than 500 words.
      Content: ${payload.content}`,
    });

    logger.info("Article summary generated successfully");

    return {
      summary: text,
    };
  },
});
