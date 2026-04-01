/**
 * Test task that uses the ChatClient to interact with the ai-chat agent
 * from a server-side context (task-to-agent communication).
 *
 * Tests: typed client, conversation API, ChatStream, preload, follow-up, close.
 */
import { task, logger } from "@trigger.dev/sdk";
import { ChatClient } from "@trigger.dev/sdk/chat";
import type { aiChat } from "./chat";

export const chatClientTest = task({
  id: "chat-client-test",
  run: async (payload: { message: string; followUp?: string }) => {
    // Type-safe client — clientData is typed from the agent definition
    const client = new ChatClient<typeof aiChat>({
      task: "ai-chat",
      clientData: { userId: "chat-client-test", model: "gpt-4o-mini" },
    });

    const chatId = `test-${Date.now()}`;

    // Use the conversation API for multi-turn interaction
    const conversation = client.conversation(chatId);

    // 1. Preload — agent initializes before we send the first message
    logger.info("Preloading agent", { chatId });
    const session = await conversation.preload();
    logger.info("Preload complete", { runId: session.runId });

    // 2. Send first message — get a typed ChatStream back
    logger.info("Sending message", { message: payload.message });
    const turn1 = await conversation.send(payload.message);

    // Stream the response, logging tool calls as they happen
    const result1 = await turn1.result();
    logger.info("Turn 1 complete", {
      textLength: result1.text.length,
      toolCalls: result1.toolCalls.map((tc) => tc.toolName),
      toolResults: result1.toolResults.length,
      preview: result1.text.slice(0, 200),
    });

    // 3. Follow-up — reuses same run via input stream
    if (payload.followUp) {
      logger.info("Sending follow-up", { message: payload.followUp });

      // Use textResponse() for a simpler one-shot API
      const followUpText = await conversation.textResponse(payload.followUp);
      logger.info("Turn 2 complete", {
        textLength: followUpText.length,
        preview: followUpText.slice(0, 200),
      });

      // 4. Close the agent gracefully
      await conversation.close();
      logger.info("Agent closed");

      return {
        chatId,
        runId: session.runId,
        turn1: { text: result1.text.slice(0, 500), toolCalls: result1.toolCalls.map((tc) => tc.toolName) },
        turn2: { text: followUpText.slice(0, 500) },
      };
    }

    // 4. Close the agent gracefully
    await conversation.close();
    logger.info("Agent closed");

    return {
      chatId,
      runId: session.runId,
      text: result1.text.slice(0, 500),
      toolCalls: result1.toolCalls.map((tc) => tc.toolName),
    };
  },
});
