import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const StartAgentChatInput = CommonProjectsInput.extend({
  agentId: z
    .string()
    .describe("The agent task ID to chat with. Use get_current_worker to see available agents."),
  chatId: z
    .string()
    .describe("A unique conversation ID. Reuse to resume a conversation.")
    .optional(),
  clientData: z
    .record(z.string(), z.unknown())
    .describe("Client data to include with every message (e.g. userId, model).")
    .optional(),
  preload: z
    .boolean()
    .describe("Whether to preload the agent before the first message.")
    .default(true),
});

export const SendAgentMessageInput = z.object({
  chatId: z.string().describe("The chat ID from start_agent_chat."),
  message: z.string().describe("The message to send to the agent."),
});

export const CloseAgentChatInput = z.object({
  chatId: z.string().describe("The chat ID to close."),
});
