/**
 * Server-side API for chatting with Trigger.dev agents.
 *
 * @example
 * ```ts
 * import { AgentChat } from "@trigger.dev/sdk/chat";
 *
 * const chat = new AgentChat<typeof myAgent>({
 *   agent: "my-agent",
 *   clientData: { userId: "user_123" },
 * });
 *
 * const stream = await chat.sendMessage("Review PR #1");
 * const text = await stream.text();
 * await chat.close();
 * ```
 */

import type { Task } from "@trigger.dev/core/v3";
import type { UIMessage, UIMessageChunk } from "ai";
import { readUIMessageStream } from "ai";
import { ApiClient, SSEStreamSubscription, apiClientManager } from "@trigger.dev/core/v3";
import {
  CHAT_STREAM_KEY,
  CHAT_MESSAGES_STREAM_ID,
  CHAT_STOP_STREAM_ID,
} from "./chat-constants.js";
import type { ChatTaskWirePayload } from "./ai.js";
import { trigger } from "./shared.js";

// ─── Type inference ────────────────────────────────────────────────

/** Extract the client data (metadata) type from a chat agent task. */
export type InferChatClientData<T> =
  T extends Task<any, ChatTaskWirePayload<any, infer TMetadata>, any>
    ? unknown extends TMetadata
      ? Record<string, unknown>
      : TMetadata
    : Record<string, unknown>;

/** Extract the UIMessage type from a chat agent task. */
export type InferChatUIMessage<T> =
  T extends Task<any, ChatTaskWirePayload<infer TUIMessage, any>, any>
    ? TUIMessage
    : UIMessage;

// ─── Types ─────────────────────────────────────────────────────────

/** Persistable session state — store this to resume across requests. */
export type ChatSession = {
  runId: string;
  lastEventId?: string;
};

export type AgentChatOptions<TAgent = unknown> = {
  /** The agent task ID to trigger. */
  agent: string;
  /**
   * Conversation ID. Used for tagging runs and correlating messages.
   * @default crypto.randomUUID()
   */
  id?: string;
  /** Client data included in every request. Typed from the agent's clientDataSchema. */
  clientData?: InferChatClientData<TAgent>;
  /**
   * Restore a previous session. Pass the runId (and optionally lastEventId)
   * from a previous request to resume the same agent run.
   */
  session?: ChatSession;
  /**
   * Called when a new run is triggered (first message or preload).
   * Use this to persist the session for later resumption.
   */
  onTriggered?: (event: { runId: string; chatId: string }) => void | Promise<void>;
  /**
   * Called when a turn completes (the agent's response stream ends).
   * Use this to persist the lastEventId for stream resumption.
   */
  onTurnComplete?: (event: {
    runId: string;
    chatId: string;
    lastEventId?: string;
  }) => void | Promise<void>;
  /** Stream key for output stream. @default "chat" */
  streamKey?: string;
  /** SSE timeout in seconds. @default 120 */
  streamTimeoutSeconds?: number;
  /** Trigger options (tags, queue, machine, etc.). */
  triggerOptions?: {
    tags?: string[];
    queue?: string;
    maxAttempts?: number;
    machine?: string;
    priority?: number;
  };
};

// ─── ChatStream ────────────────────────────────────────────────────

/** Parsed tool call from the stream. */
export type ChatToolCall = {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

/** Parsed tool result from the stream. */
export type ChatToolResult = {
  toolCallId: string;
  output: unknown;
};

/** Accumulated result after a stream completes. */
export type ChatStreamResult = {
  text: string;
  toolCalls: ChatToolCall[];
  toolResults: ChatToolResult[];
};

/**
 * A single turn's response stream from an agent.
 *
 * Pick one consumption mode:
 * - `for await (const chunk of stream)` — typed UIMessageChunk iteration
 * - `await stream.result()` — accumulated `{ text, toolCalls, toolResults }`
 * - `await stream.text()` — just the text
 * - `yield* stream.messages()` — sub-agent pattern (yields UIMessage snapshots)
 */
export class ChatStream {
  private readonly _consumerStream: ReadableStream<UIMessageChunk>;
  private readonly _messageCollector?: Promise<void>;
  private resultPromise: Promise<ChatStreamResult> | undefined;
  /** @internal Last UIMessage snapshot from the assistant's response. */
  private lastAssistantMessage: UIMessage | undefined;
  /** @internal Callback to capture the assistant's response message for accumulation. */
  private readonly onAssistantMessage?: (message: UIMessage) => void;

  constructor(
    stream: ReadableStream<UIMessageChunk>,
    onAssistantMessage?: (message: UIMessage) => void
  ) {
    this.onAssistantMessage = onAssistantMessage;

    if (onAssistantMessage) {
      // Tee the stream: one branch for the consumer, one for message collection
      const [consumer, collector] = stream.tee();
      this._consumerStream = consumer;
      this._messageCollector = (async () => {
        for await (const msg of readUIMessageStream({ stream: collector })) {
          this.lastAssistantMessage = msg;
        }
        if (this.lastAssistantMessage) {
          onAssistantMessage(this.lastAssistantMessage);
        }
      })();
    } else {
      this._consumerStream = stream;
    }
  }

  /** The raw ReadableStream for direct use with AI SDK utilities. */
  get stream(): ReadableStream<UIMessageChunk> {
    return this._consumerStream;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<UIMessageChunk> {
    const reader = this._consumerStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Yields accumulated UIMessage snapshots for the sub-agent tool pattern.
   *
   * @example
   * ```ts
   * const stream = await chat.sendMessage("Research this topic");
   * yield* stream.messages();
   * ```
   */
  async *messages(): AsyncGenerator<UIMessage, void, unknown> {
    for await (const message of readUIMessageStream({ stream: this._consumerStream })) {
      this.lastAssistantMessage = message;
      yield message;
    }
    if (this.lastAssistantMessage && this.onAssistantMessage) {
      this.onAssistantMessage(this.lastAssistantMessage);
    }
  }

  /** Consume the stream and return the accumulated result. */
  result(): Promise<ChatStreamResult> {
    if (!this.resultPromise) {
      this.resultPromise = this.consumeStream();
    }
    return this.resultPromise;
  }

  /** Consume the stream and return just the text. */
  async text(): Promise<string> {
    return (await this.result()).text;
  }

  private async consumeStream(): Promise<ChatStreamResult> {
    let text = "";
    const toolCalls: ChatToolCall[] = [];
    const toolResults: ChatToolResult[] = [];

    for await (const chunk of this) {
      if (chunk.type === "text-delta") {
        text += chunk.delta;
      } else if (chunk.type === "tool-input-available") {
        toolCalls.push({
          toolName: chunk.toolName,
          toolCallId: chunk.toolCallId,
          input: chunk.input,
        });
      } else if (chunk.type === "tool-output-available") {
        toolResults.push({
          toolCallId: chunk.toolCallId,
          output: chunk.output,
        });
      }
    }

    return { text, toolCalls, toolResults };
  }
}

// ─── Internal ──────────────────────────────────────────────────────

type SessionState = {
  runId: string;
  lastEventId?: string;
  skipToTurnComplete?: boolean;
};

// ─── AgentChat ─────────────────────────────────────────────────────

/**
 * A chat conversation with a Trigger.dev agent.
 *
 * @example
 * ```ts
 * // Simple usage
 * const chat = new AgentChat<typeof myAgent>({ agent: "my-agent" });
 * const text = await (await chat.sendMessage("Hello")).text();
 * await chat.close();
 *
 * // Stateless request handler — persist and restore session
 * const chat = new AgentChat<typeof myAgent>({
 *   agent: "my-agent",
 *   id: chatId,
 *   session: { runId: savedRunId, lastEventId: savedLastEventId },
 *   onTriggered: ({ runId }) => db.save(chatId, { runId }),
 *   onTurnComplete: ({ lastEventId }) => db.update(chatId, { lastEventId }),
 * });
 * ```
 */
export class AgentChat<TAgent = unknown> {
  private readonly taskId: string;
  private readonly chatId: string;
  private readonly streamKey: string;
  private readonly streamTimeoutSeconds: number;
  private readonly clientData: Record<string, unknown> | undefined;
  private readonly triggerOptions: AgentChatOptions["triggerOptions"];
  private readonly onTriggered: AgentChatOptions["onTriggered"];
  private readonly onTurnComplete: AgentChatOptions["onTurnComplete"];

  private session: SessionState | undefined;
  /** Accumulated UIMessages across all turns — used for continuation payloads. */
  private accumulatedMessages: UIMessage[] = [];

  constructor(options: AgentChatOptions<TAgent>) {
    this.taskId = options.agent;
    this.chatId = options.id ?? crypto.randomUUID();
    this.streamKey = options.streamKey ?? CHAT_STREAM_KEY;
    this.streamTimeoutSeconds = options.streamTimeoutSeconds ?? 120;
    this.clientData = options.clientData as Record<string, unknown> | undefined;
    this.triggerOptions = options.triggerOptions;
    this.onTriggered = options.onTriggered;
    this.onTurnComplete = options.onTurnComplete;

    // Restore session if provided
    if (options.session) {
      this.session = {
        runId: options.session.runId,
        lastEventId: options.session.lastEventId,
      };
    }
  }

  /** The conversation ID. */
  get id(): string {
    return this.chatId;
  }

  /** The current run session, if active. */
  get run(): ChatSession | undefined {
    if (!this.session) return undefined;
    return {
      runId: this.session.runId,
      lastEventId: this.session.lastEventId,
    };
  }

  /**
   * Preload the agent — start the run before the first message.
   * The agent's `onPreload` hook fires immediately.
   * No-op if already has a session.
   */
  async preload(options?: { idleTimeoutInSeconds?: number }): Promise<ChatSession> {
    if (this.session) {
      return { runId: this.session.runId, lastEventId: this.session.lastEventId };
    }

    const payload = {
      messages: [] as never[],
      chatId: this.chatId,
      trigger: "preload" as const,
      metadata: this.clientData,
      ...(options?.idleTimeoutInSeconds !== undefined
        ? { idleTimeoutInSeconds: options.idleTimeoutInSeconds }
        : {}),
    };

    this.session = await this.triggerNewRun(payload, "preload");
    await this.onTriggered?.({ runId: this.session.runId, chatId: this.chatId });

    return { runId: this.session.runId };
  }

  /**
   * Send a text message and get the response stream.
   *
   * @example
   * ```ts
   * const stream = await chat.sendMessage("Review PR #1");
   * const text = await stream.text();
   * ```
   */
  async sendMessage(
    text: string,
    options?: { abortSignal?: AbortSignal }
  ): Promise<ChatStream> {
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message: UIMessage = {
      id: msgId,
      role: "user",
      parts: [{ type: "text", text }],
    };

    // Track the outgoing user message
    this.accumulatedMessages.push(message);

    const rawStream = await this.sendRaw([message], {
      abortSignal: options?.abortSignal,
    });

    return new ChatStream(rawStream, (assistantMessage) => {
      this.accumulatedMessages.push(assistantMessage);
    });
  }

  /** Send raw UIMessage-like objects. Use `sendMessage()` for simple text. */
  async sendRaw(
    messages: UIMessage[] | Array<{
      id: string;
      role: string;
      parts?: unknown[];
      [key: string]: unknown;
    }>,
    options?: {
      trigger?: "submit-message" | "regenerate-message";
      abortSignal?: AbortSignal;
    }
  ): Promise<ReadableStream<UIMessageChunk>> {
    const triggerType = options?.trigger ?? "submit-message";

    const payload: Record<string, unknown> = {
      messages,
      chatId: this.chatId,
      trigger: triggerType,
      metadata: this.clientData,
    };

    let isContinuation = false;
    let previousRunId: string | undefined;

    // Try input stream if session exists
    if (this.session?.runId) {
      const minimalPayload = {
        ...payload,
        messages: triggerType === "submit-message" ? messages.slice(-1) : messages,
      };

      try {
        const api = this.createApiClient();
        await api.sendInputStream(
          this.session.runId,
          CHAT_MESSAGES_STREAM_ID,
          minimalPayload
        );

        return this.subscribeToStream(this.session.runId, options?.abortSignal);
      } catch {
        previousRunId = this.session.runId;
        this.session = undefined;
        isContinuation = true;
      }
    }

    // First message or run ended — trigger new run with full history
    const triggerPayload = {
      ...payload,
      ...(isContinuation ? { messages: this.accumulatedMessages } : {}),
      continuation: isContinuation,
      ...(previousRunId ? { previousRunId } : {}),
    };

    this.session = await this.triggerNewRun(triggerPayload, "trigger");
    await this.onTriggered?.({ runId: this.session.runId, chatId: this.chatId });

    return this.subscribeToStream(this.session.runId, options?.abortSignal);
  }

  /** Send a steering message during an active stream. */
  async steer(text: string): Promise<boolean> {
    if (!this.session?.runId) return false;

    const payload = {
      messages: [
        { id: `steer-${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
      ],
      chatId: this.chatId,
      trigger: "submit-message" as const,
      metadata: this.clientData,
    };

    try {
      const api = this.createApiClient();
      await api.sendInputStream(this.session.runId, CHAT_MESSAGES_STREAM_ID, payload);
      return true;
    } catch {
      return false;
    }
  }

  /** Stop the current generation (agent stays alive for next turn). */
  async stop(): Promise<void> {
    if (!this.session?.runId) return;

    this.session.skipToTurnComplete = true;
    const api = this.createApiClient();
    await api
      .sendInputStream(this.session.runId, CHAT_STOP_STREAM_ID, { stop: true })
      .catch(() => {});
  }

  /**
   * Send a custom action to the agent.
   *
   * Actions wake the agent, fire the `onAction` hook (which can modify
   * conversation history via `chat.history.*`), then trigger a normal
   * `run()` turn so the LLM responds to the updated state.
   *
   * The action payload is validated against the agent's `actionSchema`
   * on the backend.
   *
   * @returns A `ChatStream` for the agent's response.
   *
   * @example
   * ```ts
   * const stream = await agentChat.sendAction({ type: "undo" });
   * for await (const chunk of stream) {
   *   if (chunk.type === "text-delta") process.stdout.write(chunk.delta);
   * }
   * ```
   */
  async sendAction(
    action: unknown,
    options?: { abortSignal?: AbortSignal }
  ): Promise<ChatStream> {
    if (!this.session?.runId) {
      throw new Error("No active session. Send a message first or call preload().");
    }

    const payload = {
      messages: [] as never[],
      chatId: this.chatId,
      trigger: "action" as const,
      action,
      metadata: this.clientData,
    };

    try {
      const api = this.createApiClient();
      await api.sendInputStream(this.session.runId, CHAT_MESSAGES_STREAM_ID, payload);
    } catch {
      throw new Error("Failed to send action. The session may have ended.");
    }

    const rawStream = this.subscribeToStream(this.session.runId, options?.abortSignal);
    return new ChatStream(rawStream, (assistantMessage) => {
      this.accumulatedMessages.push(assistantMessage);
    });
  }

  /** Close the conversation — agent exits its loop gracefully. */
  async close(): Promise<boolean> {
    if (!this.session?.runId) return false;

    try {
      const api = this.createApiClient();
      await api.sendInputStream(this.session.runId, CHAT_MESSAGES_STREAM_ID, {
        messages: [],
        chatId: this.chatId,
        trigger: "close" as const,
      });
      this.session = undefined;
      return true;
    } catch {
      return false;
    }
  }

  /** Reconnect to the response stream (e.g. after a disconnect). */
  async reconnect(
    abortSignal?: AbortSignal
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    if (!this.session) return null;

    return this.subscribeToStream(this.session.runId, abortSignal, {
      sendStopOnAbort: false,
    });
  }

  // ─── Private ───────────────────────────────────────────────────

  private createApiClient(): ApiClient {
    const baseURL = apiClientManager.baseURL ?? "https://api.trigger.dev";
    const accessToken = apiClientManager.accessToken ?? "";
    return new ApiClient(baseURL, accessToken);
  }

  private async triggerNewRun(
    payload: Record<string, unknown>,
    purpose: "trigger" | "preload"
  ): Promise<SessionState> {
    const autoTags =
      purpose === "preload"
        ? [`chat:${this.chatId}`, "preload:true"]
        : [`chat:${this.chatId}`];
    const userTags = this.triggerOptions?.tags ?? [];
    const tags = [...autoTags, ...userTags].slice(0, 5);

    const handle = await trigger(this.taskId, payload, {
      tags,
      queue: this.triggerOptions?.queue,
      maxAttempts: this.triggerOptions?.maxAttempts,
      machine: this.triggerOptions?.machine as any,
      priority: this.triggerOptions?.priority,
    });

    return { runId: handle.id };
  }

  private subscribeToStream(
    runId: string,
    abortSignal: AbortSignal | undefined,
    options?: { sendStopOnAbort?: boolean }
  ): ReadableStream<UIMessageChunk> {
    const self = this;
    const session = this.session;
    const baseURL = apiClientManager.baseURL ?? "https://api.trigger.dev";
    const accessToken = apiClientManager.accessToken ?? "";
    const onTurnComplete = this.onTurnComplete;
    const chatId = this.chatId;

    const internalAbort = new AbortController();
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, internalAbort.signal])
      : internalAbort.signal;

    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          if (options?.sendStopOnAbort !== false && session) {
            session.skipToTurnComplete = true;
            const api = new ApiClient(baseURL, accessToken);
            api
              .sendInputStream(session.runId, CHAT_STOP_STREAM_ID, { stop: true })
              .catch(() => {});
          }
          internalAbort.abort();
        },
        { once: true }
      );
    }

    const streamUrl = `${baseURL}/realtime/v1/streams/${runId}/${this.streamKey}`;

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        try {
          const subscription = new SSEStreamSubscription(streamUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            signal: combinedSignal,
            timeoutInSeconds: this.streamTimeoutSeconds,
            lastEventId: session?.lastEventId,
          });
          const sseStream = await subscription.subscribe();
          const reader = sseStream.getReader();

          try {
            while (true) {
              const next = await reader.read();
              if (next.done) {
                controller.close();
                return;
              }

              if (combinedSignal.aborted) {
                internalAbort.abort();
                await reader.cancel();
                controller.close();
                return;
              }

              const value = next.value;

              // Track last event ID for resume
              if (value.id && session) {
                session.lastEventId = value.id;
              }

              if (value.chunk != null && typeof value.chunk === "object") {
                const chunk = value.chunk as Record<string, unknown>;

                if (session?.skipToTurnComplete) {
                  if (chunk.type === "trigger:turn-complete") {
                    session.skipToTurnComplete = false;
                  }
                  continue;
                }

                if (chunk.type === "trigger:upgrade-required") {
                  // Agent requested a version upgrade — re-trigger with full
                  // history and pipe the new stream through transparently.
                  internalAbort.abort();
                  const previousRunId = self.session?.runId;
                  self.session = undefined;

                  try {
                    const triggerPayload: Record<string, unknown> = {
                      messages: self.accumulatedMessages,
                      chatId: self.chatId,
                      trigger: "submit-message",
                      metadata: self.clientData,
                      continuation: true,
                      ...(previousRunId ? { previousRunId } : {}),
                    };

                    self.session = await self.triggerNewRun(triggerPayload, "trigger");
                    await self.onTriggered?.({ runId: self.session.runId, chatId: self.chatId });

                    const newStream = self.subscribeToStream(
                      self.session.runId,
                      abortSignal
                    );
                    const newReader = newStream.getReader();
                    try {
                      while (true) {
                        const nr = await newReader.read();
                        if (nr.done) break;
                        controller.enqueue(nr.value);
                      }
                    } finally {
                      newReader.releaseLock();
                    }
                  } catch (retryError) {
                    controller.error(retryError);
                    return;
                  }
                  try {
                    controller.close();
                  } catch {
                    // Controller may already be closed
                  }
                  return;
                }

                if (chunk.type === "trigger:turn-complete") {
                  // Notify callback
                  onTurnComplete?.({
                    runId,
                    chatId,
                    lastEventId: session?.lastEventId,
                  });
                  internalAbort.abort();
                  try {
                    controller.close();
                  } catch {
                    // Controller may already be closed
                  }
                  return;
                }

                controller.enqueue(chunk as unknown as UIMessageChunk);
              }
            }
          } catch (readError) {
            reader.releaseLock();
            throw readError;
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            try {
              controller.close();
            } catch {
              // Controller may already be closed
            }
            return;
          }
          controller.error(error);
        }
      },
    });
  }
}
