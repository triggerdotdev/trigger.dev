import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { createSearchDocsTool } from "./ai-assistant-tools/docs/search-docs";

const REASONING_SYSTEM_PROMPT = `You are an expert Trigger.dev assistant using a powerful model for complex reasoning. You can search documentation when needed but your main value is analysis, explanation, and problem-solving. Give clear, thorough answers.`;

export const reasoningAgent = chat.agent({
  id: "reasoning-agent",
  idleTimeoutInSeconds: 60,
  chatAccessTokenTTL: "1h",

  tools: () => ({ searchDocs: createSearchDocsTool() }),

  onBoot: async () => {
    chat.prompt.set(REASONING_SYSTEM_PROMPT);
  },

  run: async ({ messages, tools, stopSignal }) => {
    return streamText({
      ...chat.toStreamTextOptions({ tools }),
      model: openai("gpt-4.1"),
      messages,
      abortSignal: stopSignal,
      stopWhen: stepCountIs(8),
    });
  },
});
