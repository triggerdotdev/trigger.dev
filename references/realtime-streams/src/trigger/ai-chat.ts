import { logger, streams, task } from "@trigger.dev/sdk";
import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, UIMessage, UIMessageChunk } from "ai";

export type AI_STREAMS = {
  chat: UIMessageChunk;
};

export type AIChatPayload = {
  messages: UIMessage[];
};

export const aiChatTask = task({
  id: "ai-chat",
  run: async (payload: AIChatPayload) => {
    logger.info("Starting AI chat stream", {
      messageCount: payload.messages.length,
    });

    // Stream text from OpenAI
    const result = streamText({
      model: openai("gpt-4o"),
      system: "You are a helpful assistant.",
      messages: convertToModelMessages(payload.messages),
    });

    // Get the UI message stream
    const uiMessageStream = result.toUIMessageStream();

    // Append the stream to metadata
    const { waitUntilComplete } = streams.pipe(uiMessageStream);

    // Wait for the stream to complete
    await waitUntilComplete();

    logger.info("AI chat stream completed");

    return {
      message: "AI chat stream completed successfully",
      messageCount: payload.messages.length,
    };
  },
});
