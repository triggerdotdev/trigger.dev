import { z } from "zod";
import {
  ApiClient,
  controlSubtype,
  SSEStreamSubscription,
  TRIGGER_CONTROL_SUBTYPE,
} from "@trigger.dev/core/v3";
import { toolsMetadata } from "../config.js";
import { CommonProjectsInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

// ─── In-memory chat sessions ──────────────────────────────────────

type ChatMessage = {
  id: string;
  role: string;
  parts: Array<{ type: string; [key: string]: unknown }>;
};

type ChatSession = {
  /** `session_*` friendlyId — durable identity for the conversation. */
  sessionId: string;
  /** Last-known live run id. Cleared when a run ends. */
  runId: string;
  chatId: string;
  agentId: string;
  lastEventId?: string;
  apiClient: ApiClient;
  clientData?: Record<string, unknown>;
  /** Accumulated conversation messages for continuation payloads. */
  messages: ChatMessage[];
};

const activeSessions = new Map<string, ChatSession>();

// ─── ChatInputChunk serialization (mirrors TriggerChatTransport) ──
//
// Slim-wire: one delta `message` per chunk, not a full `messages[]` array.
// The agent's run loop destructures `payload.message` (singular). Sending
// a `messages: [...]` array makes `message` undefined and turn 1 calls
// `streamText({ messages: [] })`, which throws
// `AI_InvalidPromptError: messages must not be empty`.
type ChatInputChunk =
  | {
      kind: "message";
      payload: {
        message?: ChatMessage;
        chatId: string;
        trigger: "submit-message" | "close" | "preload" | "regenerate-message" | "action";
        metadata?: unknown;
        sessionId?: string;
        continuation?: boolean;
        previousRunId?: string;
      };
    }
  | { kind: "stop"; message?: string };

function serializeInputChunk(chunk: ChatInputChunk): string {
  return JSON.stringify(chunk);
}

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
      scopes: [
        "write:tasks",
        "read:runs",
        "read:sessions",
        "write:sessions",
      ],
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

    // Create (or upsert) the backing Session. Idempotent via externalId —
    // two MCP clients targeting the same chatId converge to the same row.
    // Sessions are now task-bound: taskIdentifier + triggerConfig are
    // required, and the server reuses them for every run scheduled by
    // this session (initial + continuations after run termination).
    //
    // basePayload mirrors the browser-mediated `chat.createStartSessionAction`
    // shape so the auto-triggered first run hits `onPreload` (not
    // `onChatStart` with `preloaded: true`). Without `trigger: "preload"`
    // + `messages: []`, the agent runtime bypasses both lifecycle hooks
    // and `onTurnStart`'s DB write fails with "No record found".
    //
    // POST /api/v1/sessions auto-triggers the first run and returns its
    // runId, so we don't need a separate triggerTask call. The `preload`
    // flag on this MCP tool is kept as a no-op signal (true=default) for
    // backwards compat — a Session is always created with a live run now.
    const session = await apiClient.createSession({
      type: "chat.agent",
      externalId: chatId,
      taskIdentifier: input.agentId,
      triggerConfig: {
        basePayload: {
          messages: [],
          trigger: "preload",
          chatId,
          ...(input.clientData ? { metadata: input.clientData } : {}),
        },
        tags: [`chat:${chatId}`],
      },
    });

    activeSessions.set(chatId, {
      sessionId: session.id,
      runId: session.runId,
      chatId,
      agentId: input.agentId,
      apiClient,
      clientData: input.clientData,
      messages: [],
    });

    return {
      content: [
        {
          type: "text",
          text: [
            `Agent chat started${input.preload ? " and preloaded" : ""}.`,
            `- Chat ID: ${chatId}`,
            `- Session ID: ${session.id}`,
            `- Agent: ${input.agentId}`,
            `- Run ID: ${session.runId}`,
            ``,
            `Use send_agent_message with chatId "${chatId}" to send messages.`,
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
    const userMessage: ChatMessage = {
      id: msgId, role: "user", parts: [{ type: "text", text: input.message }],
    };

    // Track the outgoing user message
    session.messages.push(userMessage);

    // Slim-wire: one delta `message` per trigger. Prior turns live in the
    // session.out snapshot+replay; we only ship the new user message.
    const wirePayload = {
      message: userMessage,
      chatId: session.chatId,
      trigger: "submit-message" as const,
      metadata: session.clientData,
    };

    // If we have an active run, send via session.in. If that fails
    // (run ended, token expired, etc.) fall back to triggering a new
    // run on the same session — the new run replays prior turns from the
    // snapshot and picks up `message` as turn N's user delta.
    if (session.runId) {
      try {
        await session.apiClient.appendToSessionStream(
          session.sessionId,
          "in",
          serializeInputChunk({ kind: "message", payload: wirePayload })
        );
      } catch (sendErr: any) {
        ctx.logger?.log("appendToSessionStream failed, falling back to triggerTask", {
          chatId: session.chatId,
          sessionId: session.sessionId,
          error: sendErr?.message ?? String(sendErr),
        });
        const result = await session.apiClient.triggerTask(session.agentId, {
          payload: {
            message: userMessage,
            chatId: session.chatId,
            sessionId: session.sessionId,
            trigger: "submit-message",
            metadata: session.clientData,
            continuation: true,
            previousRunId: session.runId,
          },
          options: {
            payloadType: "application/json",
            tags: [`chat:${session.chatId}`],
          },
        });
        session.runId = result.id;
        // Keep session.lastEventId as-is. The .out stream is per-session, so
        // resuming from the last-seen chunk's id skips historical chunks —
        // including stale `trigger:turn-complete` markers from prior turns
        // that would otherwise break collectAgentResponse's read loop with
        // empty/old text. Same reasoning as the trigger:upgrade-required
        // path below.
      }
    } else {
      // No run yet — trigger one (agent opens the session on startup).
      const result = await session.apiClient.triggerTask(session.agentId, {
        payload: {
          ...wirePayload,
          sessionId: session.sessionId,
        },
        options: {
          payloadType: "application/json",
          tags: [`chat:${session.chatId}`],
        },
      });
      session.runId = result.id;
    }

    // Subscribe to the response stream and collect the full text
    const { text, toolCalls, assistantMessage } = await collectAgentResponse(session);

    // Track the assistant response for continuation payloads
    session.messages.push(assistantMessage);

    const formatted = formatAssistantParts(assistantMessage.parts);
    const footer = `\n\n---\nRun: ${session.runId}`;

    return {
      content: [{ type: "text", text: formatted + footer }],
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
        await session.apiClient.appendToSessionStream(
          session.sessionId,
          "in",
          serializeInputChunk({
            kind: "message",
            payload: {
              // `trigger: "close"` carries no message delta — the agent
              // looks at `trigger` and exits without touching `message`.
              chatId: session.chatId,
              trigger: "close",
            },
          })
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

// Safety bound on chained upgrades during a single send. A misconfigured
// agent or upgrade-loop bug would otherwise grow the call stack without limit.
const MAX_UPGRADE_RECURSION_DEPTH = 10;

async function collectAgentResponse(
  session: ChatSession,
  depth = 0
): Promise<{ text: string; toolCalls: string[]; assistantMessage: ChatMessage }> {
  if (depth > MAX_UPGRADE_RECURSION_DEPTH) {
    throw new Error(
      `Agent upgrade recursion depth exceeded (${depth} chained trigger:upgrade-required signals)`
    );
  }
  const baseURL = session.apiClient.baseUrl;
  const streamUrl = `${baseURL}/realtime/v1/sessions/${encodeURIComponent(session.sessionId)}/out`;

  const subscription = new SSEStreamSubscription(streamUrl, {
    headers: {
      Authorization: `Bearer ${session.apiClient.accessToken}`,
    },
    timeoutInSeconds: 120,
    lastEventId: session.lastEventId,
  });

  const sseStream = await subscription.subscribe();
  const reader = sseStream.getReader();

  let text = "";
  const toolCalls: string[] = [];
  const parts: Array<{ type: string; [key: string]: unknown }> = [];
  // Track current text part to accumulate deltas
  let currentTextId: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value.id) {
        session.lastEventId = value.id;
      }

      // Trigger control records (turn-complete, upgrade-required) ride
      // on headers — see `client-protocol.mdx#records-on-session-out`.
      // Data records carry UIMessageChunks on `value.chunk`.
      const controlValue = controlSubtype(value.headers);

      if (controlValue === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
        break;
      }

      if (controlValue === TRIGGER_CONTROL_SUBTYPE.UPGRADE_REQUIRED) {
        // Agent requested upgrade — trigger continuation. Same session,
        // new run — reuse sessionId, swap runId. Slim-wire: ship only
        // the latest user message as the turn-N delta; prior turns
        // come back via snapshot+replay on the new run's boot.
        const lastUserMessage = [...session.messages]
          .reverse()
          .find((m) => m.role === "user");
        const previousRunId = session.runId;
        const result = await session.apiClient.triggerTask(session.agentId, {
          payload: {
            message: lastUserMessage,
            chatId: session.chatId,
            sessionId: session.sessionId,
            trigger: "submit-message",
            metadata: session.clientData,
            continuation: true,
            previousRunId,
          },
          options: {
            payloadType: "application/json",
            tags: [`chat:${session.chatId}`],
          },
        });
        session.runId = result.id;
        // Keep session.lastEventId pointing at the upgrade-required
        // record's seq (set above when the part arrived). The recursive
        // subscribe resumes right after that marker, so we don't replay
        // the entire session.out stream — which would hit a historical
        // turn-complete and break the loop with empty/old text.
        reader.releaseLock();
        // Recurse — subscribe to the new run's stream (same session.out URL)
        return collectAgentResponse(session, depth + 1);
      }

      // v2 (session) SSE already parses record.body.data, so `chunk` is
      // the UIMessageChunk object written by the agent.
      if (value.chunk != null && typeof value.chunk === "object") {
        const chunk = value.chunk as Record<string, unknown>;

        if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
          text += chunk.delta;
          // Accumulate into a text part
          const textId = (chunk.id as string) ?? "text";
          if (currentTextId !== textId) {
            currentTextId = textId;
            parts.push({ type: "text", text: chunk.delta });
          } else {
            const last = parts[parts.length - 1];
            if (last && last.type === "text") {
              last.text = (last.text as string) + chunk.delta;
            }
          }
        }

        if (chunk.type === "tool-input-available" && typeof chunk.toolName === "string") {
          toolCalls.push(chunk.toolName);
          parts.push({
            type: `tool-${chunk.toolName}`,
            toolCallId: chunk.toolCallId as string,
            toolName: chunk.toolName,
            state: "input-available",
            input: chunk.input,
          });
        }

        if (chunk.type === "tool-output-available" && typeof chunk.toolCallId === "string") {
          // Update existing tool part with output
          const toolPart = parts.find(
            (p) => p.toolCallId === chunk.toolCallId
          );
          if (toolPart) {
            toolPart.state = "output-available";
            toolPart.output = chunk.output;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const assistantMessage: ChatMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    parts: parts.length > 0 ? parts : [{ type: "text", text }],
  };

  return { text, toolCalls, assistantMessage };
}

// ─── Response formatter ──────────────────────────────────────────

function formatAssistantParts(
  parts: Array<{ type: string; [key: string]: unknown }>
): string {
  const sections: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      sections.push(part.text);
    } else if (part.type.startsWith("tool-") && part.toolName) {
      const name = part.toolName as string;
      const input = part.input;
      const output = part.output;

      let toolSection = `[Tool: ${name}]`;
      if (input != null) {
        toolSection += `\nInput: ${compactJson(input)}`;
      }
      if (output != null) {
        toolSection += `\nOutput: ${compactJson(output)}`;
      }
      sections.push(toolSection);
    }
  }

  return sections.join("\n\n");
}

function compactJson(value: unknown): string {
  const str = JSON.stringify(value);
  // Keep short values inline, truncate long ones
  if (str.length <= 200) return str;
  return str.slice(0, 200) + "…";
}
