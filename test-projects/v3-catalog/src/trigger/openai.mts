import { env } from "@/env.js";
import { logger, task } from "@trigger.dev/sdk/v3";
import { createStreamableValue } from "ai/rsc";

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

export const openaiTask = task({
  id: "openai-task",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: { prompt: string }) => {
    const streamableStatus = createStreamableValue("thread.init");

    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: "user", content: payload.prompt }],
      model: "gpt-3.5-turbo",
    });

    return chatCompletion.choices[0].message.content;
  },
  handleError: async (payload, err, { ctx, retryAt }) => {
    if (err instanceof OpenAI.APIError) {
      logger.log("OpenAI API error", { err });

      return {
        error: new Error("Custom OpenAI API error"),
        retryDelayInMs: 10000,
      };
    }
  },
});
