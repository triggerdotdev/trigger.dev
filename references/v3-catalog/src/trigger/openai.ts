import { task } from "@trigger.dev/sdk/v3";

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const openaiTask = task({
  id: "openai-task",
  run: async (payload: { prompt: string }) => {
    const chatCompletion = await openai.chat.completions.create({
      messages: [{ role: "user", content: payload.prompt }],
      model: "gpt-3.5-turbo",
    });

    return chatCompletion.choices[0].message.content;
  },
});
