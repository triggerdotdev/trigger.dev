import { chatTask } from "@trigger.dev/sdk/ai";
import { streamText, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";

export const chat = chatTask({
  id: "ai-chat",
  run: async ({ messages }) => {
    return streamText({
      model: openai("gpt-4o-mini"),
      system: "You are a helpful assistant. Be concise and friendly.",
      messages: convertToModelMessages(messages),
    });
  },
});
