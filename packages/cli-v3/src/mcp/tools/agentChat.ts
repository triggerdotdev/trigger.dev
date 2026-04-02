import { z } from "zod";
import { ApiClient, SSEStreamSubscription } from "@trigger.dev/core/v3";
import {
  CHAT_STREAM_KEY,
  CHAT_MESSAGES_STREAM_ID,
  CHAT_STOP_STREAM_ID,
} from "@trigger.dev/core/v3/chat-client";
import { toolsMetadata } from "../config.js";
import { CommonProjectsInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";
import type { McpContext } from "../context.js";

// ─── In-memory chat sessions ──────────────────────────────────────

type ChatSession = {
  runId: string;
  chatId: string;
  agentId: string;
  lastEventId?: string;
  apiClient: ApiClient;
  clientData?: Record<string, unknown>;
};

const activeSessions = new Map<string, ChatSession>();

// ─── Start Agent Chat ─────────────────────────────────────────────

const StartAgentChatInput = CommonProjectsInput.extend({
  agentId: z
    .string()
    .describe(
      "The agent task ID to chat with. Use get_current_worker to see available agents."
    ),
  chatId: z
    .string()
    .describe("A unique conversation ID. Reuse to resume a conversation.")
    .optional(),
  clientData: z
    .record(z.unknown())
    .describe("Client data to include with every message (e.g. userId, model).")
    .optional(),
  preload: z
    .boolean()
    .describe("Whether to preload the agent before the first message.")
    .default(true),
});

export const startAgentChatTool = {
  name: toolsMetadata.start_agent_chat.name,
  title: toolsMetadata.start_agent_chat.title,
  description: toolsMetadata.start_agent_chat.description,
  inputSchema: StartAgentChatInput.shape,
  handler: toolHandler(StartAgentChatInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling start_agent_chat", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["write:tasks", "read:runs", "write:inputStreams"],
      branch: input.branch,
    });

    const chatId = input.chatId ?? crypto.randomUUID();

    // Check if session already exists
    if (activeSessions.has(chatId)) {
      return {
        content: [
          {
            type: "text",
            text: `Chat ${chatId} is already active with agent ${activeSessions.get(chatId)!.agentId}. Use send_agent_message to continue the conversation.`,
          },
        ],
      };
    }

    if (input.preload) {
      // Trigger a preload run
      const payload = {
        messages: [],
        chatId,
        trigger: "preload",
        metadata: input.clientData,
      };

      const result = await apiClient.triggerTask(input.agentId, {
        payload,
        options: {
          payloadType: "application/json",
          tags: [`chat:${chatId}`, "preload:true"],
        },
      });

      activeSessions.set(chatId, {
        runId: result.id,
        chatId,
        agentId: input.agentId,
        apiClient,
        clientData: input.clientData,
      });

      return {
        content: [
          {
            type: "text",
            text: [
              `Agent chat started and preloaded.`,
              `- Chat ID: ${chatId}`,
              `- Agent: ${input.agentId}`,
              `- Run ID: ${result.id}`,
              ``,
              `Use send_agent_message with chatId "${chatId}" to send messages.`,
            ].join("\n"),
          },
        ],
      };
    }

    // No preload — just register the session, first sendMessage will trigger
    activeSessions.set(chatId, {
      runId: "",
      chatId,
      agentId: input.agentId,
      apiClient,
      clientData: input.clientData,
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `Agent chat created (not yet preloaded).`,
            `- Chat ID: ${chatId}`,
            `- Agent: ${input.agentId}`,
            ``,
            `Use send_agent_message with chatId "${chatId}" to send the first message (this will trigger the run).`,
          ].join("\n"),
        },
      ],
    };
  }),
};

// ─── Send Agent Message ───────────────────────────────────────────

const SendAgentMessageInput = z.object({
  chatId: z.string().describe("The chat ID from start_agent_chat."),
  message: z.string().describe("The message to send to the agent."),
});

export const sendAgentMessageTool = {
  name: toolsMetadata.send_agent_message.name,
  title: toolsMetadata.send_agent_message.title,
  description: toolsMetadata.send_agent_message.description,
  inputSchema: SendAgentMessageInput.shape,
  handler: toolHandler(SendAgentMessageInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling send_agent_message", { input });

    const session = activeSessions.get(input.chatId);
    if (!session) {
      return respondWithError(
        `No active chat with ID "${input.chatId}". Use start_agent_chat first.`
      );
    }

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messagePayload = {
      messages: [
        { id: msgId, role: "user", parts: [{ type: "text", text: input.message }] },
      ],
      chatId: session.chatId,
      trigger: "submit-message",
      metadata: session.clientData,
    };

    // If we have an active run, send via input stream
    if (session.runId) {
      try {
        await session.apiClient.sendInputStream(
          session.runId,
          CHAT_MESSAGES_STREAM_ID,
          messagePayload
        );
      } catch (sendErr: any) {
        // Run may have ended — trigger a new one
        const result = await session.apiClient.triggerTask(session.agentId, {
          payload: { ...messagePayload, continuation: true, previousRunId: session.runId },
          options: {
            payloadType: "application/json",
            tags: [`chat:${session.chatId}`],
          },
        });
        session.runId = result.id;
        session.lastEventId = undefined;
      }
    } else {
      // No run yet — trigger one
      const result = await session.apiClient.triggerTask(session.agentId, {
        payload: messagePayload,
        options: {
          payloadType: "application/json",
          tags: [`chat:${session.chatId}`],
        },
      });
      session.runId = result.id;
    }

    // Subscribe to the response stream and collect the full text
    const { text, toolCalls } = await collectAgentResponse(session);

    const contents = [text];

    if (toolCalls.length > 0) {
      contents.push("");
      contents.push(`Tools used: ${toolCalls.join(", ")}`);
    }

    return {
      content: [{ type: "text", text: contents.join("\n") }],
    };
  }),
};

// ─── Close Agent Chat ─────────────────────────────────────────────

const CloseAgentChatInput = z.object({
  chatId: z.string().describe("The chat ID to close."),
});

export const closeAgentChatTool = {
  name: toolsMetadata.close_agent_chat.name,
  title: toolsMetadata.close_agent_chat.title,
  description: toolsMetadata.close_agent_chat.description,
  inputSchema: CloseAgentChatInput.shape,
  handler: toolHandler(CloseAgentChatInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling close_agent_chat", { input });

    const session = activeSessions.get(input.chatId);
    if (!session) {
      return respondWithError(
        `No active chat with ID "${input.chatId}".`
      );
    }

    if (session.runId) {
      try {
        await session.apiClient.sendInputStream(
          session.runId,
          CHAT_MESSAGES_STREAM_ID,
          {
            messages: [],
            chatId: session.chatId,
            trigger: "close",
          }
        );
      } catch {
        // Best effort — run may already be done
      }
    }

    activeSessions.delete(input.chatId);

    return {
      content: [
        {
          type: "text",
          text: `Chat ${input.chatId} closed.`,
        },
      ],
    };
  }),
};

// ─── Stream collector ─────────────────────────────────────────────

async function collectAgentResponse(
  session: ChatSession
): Promise<{ text: string; toolCalls: string[] }> {
  const baseURL = session.apiClient.baseUrl;
  const streamUrl = `${baseURL}/realtime/v1/streams/${session.runId}/${CHAT_STREAM_KEY}`;

  const subscription = new SSEStreamSubscription(streamUrl, {
    headers: {
      Authorization: `Bearer ${session.apiClient.accessToken}`,
    },
    timeoutInSeconds: 120,
    lastEventId: session.lastEventId,
  });

  try {
    sseStream = await subscription.subscribe();
  } catch (err: any) {
    throw err;
  }
  const reader = sseStream.getReader();

  let text = "";
  const toolCalls: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value.id) {
        session.lastEventId = value.id;
      }

      if (value.chunk != null && typeof value.chunk === "object") {
        const chunk = value.chunk as Record<string, unknown>;

        if (chunk.type === "__trigger_turn_complete") {
          break;
        }

        if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
          text += chunk.delta;
        }

        if (
          chunk.type === "tool-input-available" &&
          typeof chunk.toolName === "string"
        ) {
          toolCalls.push(chunk.toolName);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, toolCalls };
}
