import { aiStream } from "@/app/streams";
import { openai } from "@ai-sdk/openai";
import type { TriggerChatTransportPayload } from "@trigger.dev/ai";
import { logger, task } from "@trigger.dev/sdk";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  UIMessage,
} from "ai";
import { z } from "zod/v4";

export type AIChatPayload = TriggerChatTransportPayload<UIMessage>;

export const aiChatTask = task({
  id: "ai-chat",
  run: async (payload: AIChatPayload) => {
    logger.info("Starting AI chat stream", {
      messageCount: payload.messages.length,
      chatId: payload.chatId,
      trigger: payload.trigger,
      messageId: payload.messageId,
    });

    const modelMessages = await convertToModelMessages(payload.messages);

    // Stream text from OpenAI
    const result = streamText({
      model: openai("gpt-4o"),
      system: "You are a helpful assistant.",
      messages: modelMessages,
      stopWhen: stepCountIs(20),
      tools: {
        getCommonUseCases: tool({
          description: "Get common use cases",
          inputSchema: z.object({
            useCase: z.string().describe("The use case to get common use cases for"),
          }),
          execute: async ({ useCase }) => {
            return {
              useCase,
              commonUseCases: [
                "Streaming data to a client",
                "Streaming data to a server",
                "Streaming data to a database",
                "Streaming data to a file",
                "Streaming data to a socket",
                "Streaming data to a queue",
                "Streaming data to a message broker",
                "Streaming data to a message queue",
                "Streaming data to a message broker",
              ],
            };
          },
        }),
      },
    });

    // Get the UI message stream
    const uiMessageStream = result.toUIMessageStream();

    // Append the stream to metadata
    const { waitUntilComplete } = aiStream.pipe(uiMessageStream);

    // Wait for the stream to complete
    await waitUntilComplete();

    logger.info("AI chat stream completed");

    return {
      message: "AI chat stream completed successfully",
      messageCount: payload.messages.length,
      chatId: payload.chatId,
    };
  },
});
