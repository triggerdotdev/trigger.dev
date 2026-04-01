/**
 * Server-side chat client for interacting with Trigger.dev chat agents.
 * Works inside tasks (agent-to-agent), server handlers, and standalone scripts.
 *
 * @example
 * ```ts
 * import { ChatClient } from "@trigger.dev/sdk/chat";
 * import type { prReviewChat } from "./trigger/pr-review";
 *
 * const client = new ChatClient<typeof prReviewChat>({
 *   task: "pr-review",
 *   clientData: { userId: "user_123", githubUrl: "https://..." }, // ← typed!
 * });
 *
 * const conv = client.conversation("conv-1");
 * await conv.preload();
 *
 * // Stream with typed chunks
 * const turn = await conv.send("Review PR #1");
 * for await (const chunk of turn) {
 *   if (chunk.type === "text-delta") process.stdout.write(chunk.textDelta);
 * }
 *
 * // Or just get the text
 * const fix = await conv.textResponse("Fix the bug");
 * console.log(conv.messages); // ← typed UIMessage[]
 *
 * await conv.close();
 * ```
 */

import type { Task } from "@trigger.dev/core/v3";
import type { UIMessage, UIMessageChunk } from "ai";
import { ApiClient, SSEStreamSubscription, apiClientManager } from "@trigger.dev/core/v3";
import {
  CHAT_STREAM_KEY,
  CHAT_MESSAGES_STREAM_ID,
  CHAT_STOP_STREAM_ID,
} from "./chat-constants.js";
import type { ChatTaskWirePayload } from "./ai.js";
import { trigger } from "./shared.js";

// ─── Type inference utilities ──────────────────────────────────────

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

// ─── Public types ──────────────────────────────────────────────────

export type ChatSession = {
  runId: string;
  publicAccessToken: string;
  lastEventId?: string;
};

export type ChatClientOptions<TAgent = unknown> = {
  /** The task ID to trigger. */
  task: string;
  /** Default client data included in every request. Typed from the agent's clientDataSchema. */
  clientData?: InferChatClientData<TAgent>;
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

type UIMessageLike = {
  id: string;
  role: string;
  parts?: unknown[];
  [key: string]: unknown;
};

// ─── ChatStream ────────────────────────────────────────────────────

/** Parsed tool call from the stream. */
export type ChatToolCall = {
  toolName: string;
  toolCallId: string;
  args: unknown;
};

/** Parsed tool result from the stream. */
export type ChatToolResult = {
  toolName: string;
  toolCallId: string;
  result: unknown;
};

/** The accumulated result after a stream completes. */
export type ChatStreamResult = {
  text: string;
  toolCalls: ChatToolCall[];
  toolResults: ChatToolResult[];
};

/**
 * Typed wrapper around a single turn's response stream.
 * Yields `UIMessageChunk` from the AI SDK.
 *
 * @example
 * ```ts
 * const stream = new ChatStream(rawStream);
 *
 * // Iterate with typed UIMessageChunk
 * for await (const chunk of stream) {
 *   if (chunk.type === "text-delta") process.stdout.write(chunk.textDelta);
 *   if (chunk.type === "tool-call") console.log(chunk.toolName, chunk.args);
 * }
 *
 * // Or consume and get the structured result
 * const { text, toolCalls, toolResults } = await stream.result();
 * ```
 */
export class ChatStream {
  private readonly stream: ReadableStream<UIMessageChunk>;
  private teed = false;
  private resultPromise: Promise<ChatStreamResult> | undefined;

  constructor(stream: ReadableStream<UIMessageChunk>) {
    this.stream = stream;
  }

  /** Async iterate over typed UIMessageChunk values. */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<UIMessageChunk> {
    const reader = this.stream.getReader();
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
   * Consume the entire stream and return the accumulated result.
   * Can only be called once (consumes the stream).
   */
  result(): Promise<ChatStreamResult> {
    if (!this.resultPromise) {
      this.resultPromise = this.consumeStream();
    }
    return this.resultPromise;
  }

  /** Shorthand: consume the stream and return just the text. */
  async text(): Promise<string> {
    return (await this.result()).text;
  }

  private async consumeStream(): Promise<ChatStreamResult> {
    let text = "";
    const toolCalls: ChatToolCall[] = [];
    const toolResults: ChatToolResult[] = [];

    for await (const chunk of this) {
      const c = chunk as Record<string, unknown>;
      if (c.type === "text-delta" && typeof c.textDelta === "string") {
        text += c.textDelta;
      } else if (c.type === "tool-call" && typeof c.toolName === "string") {
        toolCalls.push({
          toolName: c.toolName,
          toolCallId: c.toolCallId as string,
          args: c.args,
        });
      } else if (c.type === "tool-result" && typeof c.toolName === "string") {
        toolResults.push({
          toolName: c.toolName,
          toolCallId: c.toolCallId as string,
          result: c.result,
        });
      }
    }

    return { text, toolCalls, toolResults };
  }
}

// ─── ChatConversation ──────────────────────────────────────────────

/**
 * High-level multi-turn conversation interface.
 * Manages the turn lifecycle, accumulates messages, and returns typed streams.
 *
 * @example
 * ```ts
 * const conv = client.conversation("chat-1", { clientData: { userId: "u1" } });
 * await conv.preload();
 *
 * const turn = await conv.send("Review PR #1");
 * const { text, toolCalls } = await turn.result();
 *
 * const followUp = await conv.textResponse("Fix the bug");
 *
 * console.log(conv.messages); // Full conversation as typed UIMessage[]
 * await conv.close();
 * ```
 */
export class ChatConversation<TAgent = unknown> {
  private _messages: InferChatUIMessage<TAgent>[] = [];

  constructor(
    private readonly client: ChatClient<TAgent>,
    private readonly chatId: string,
    private readonly clientData?: InferChatClientData<TAgent>
  ) {}

  /** The accumulated conversation messages (user + assistant). */
  get messages(): readonly InferChatUIMessage<TAgent>[] {
    return this._messages;
  }

  /** Preload the agent — initialize before the first message. */
  async preload(options?: { idleTimeoutInSeconds?: number }): Promise<ChatSession> {
    return this.client.preload(this.chatId, {
      clientData: this.clientData,
      ...options,
    });
  }

  /**
   * Send a text message and return a typed ChatStream for the response.
   * The user message and assistant response are accumulated in `messages`.
   */
  async send(text: string, options?: { abortSignal?: AbortSignal }): Promise<ChatStream> {
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userMessage = {
      id: msgId,
      role: "user" as const,
      parts: [{ type: "text" as const, text }],
      createdAt: new Date(),
    } as unknown as InferChatUIMessage<TAgent>;

    this._messages.push(userMessage);

    const rawStream = await this.client.sendMessages(
      this.chatId,
      [{ id: msgId, role: "user", parts: [{ type: "text", text }] }],
      { clientData: this.clientData, abortSignal: options?.abortSignal }
    );

    // Tee the stream: one side for the ChatStream consumer, one for accumulation
    const [consumerStream, accumulatorStream] = rawStream.tee() as [
      ReadableStream<UIMessageChunk>,
      ReadableStream<UIMessageChunk>,
    ];

    // Accumulate the assistant response in the background
    this.accumulateResponse(accumulatorStream);

    return new ChatStream(consumerStream);
  }

  /** Send a text message and return the full text response. */
  async textResponse(text: string): Promise<string> {
    const stream = await this.send(text);
    return stream.text();
  }

  /** Send a text message and return the full structured result. */
  async fullResponse(text: string): Promise<ChatStreamResult> {
    const stream = await this.send(text);
    return stream.result();
  }

  /** Send a steering/pending message during an active stream. */
  async steer(text: string): Promise<boolean> {
    return this.client.sendPendingMessage(
      this.chatId,
      { id: `steer-${Date.now()}`, role: "user", parts: [{ type: "text", text }] },
      this.clientData as Record<string, unknown> | undefined
    );
  }

  /** Stop the current generation. */
  async stop(): Promise<void> {
    return this.client.stop(this.chatId);
  }

  /** Close the conversation — agent exits gracefully. */
  async close(): Promise<boolean> {
    return this.client.close(this.chatId);
  }

  /** Get the current session. */
  get session(): ChatSession | undefined {
    return this.client.getSession(this.chatId);
  }

  private async accumulateResponse(stream: ReadableStream<UIMessageChunk>): Promise<void> {
    const parts: unknown[] = [];
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const c = value as Record<string, unknown>;
        if (c.type === "text-delta" && typeof c.textDelta === "string") {
          // Accumulate text parts
          const last = parts[parts.length - 1] as { type?: string; text?: string } | undefined;
          if (last?.type === "text") {
            last.text = (last.text ?? "") + c.textDelta;
          } else {
            parts.push({ type: "text", text: c.textDelta });
          }
        } else if (c.type === "tool-call") {
          parts.push({
            type: "tool-invocation",
            toolInvocation: {
              toolName: c.toolName,
              toolCallId: c.toolCallId,
              args: c.args,
              state: "call",
            },
          });
        } else if (c.type === "tool-result") {
          // Find the matching tool-call part and update it
          const existing = parts.find(
            (p: any) =>
              p.type === "tool-invocation" &&
              p.toolInvocation?.toolCallId === c.toolCallId
          ) as any;
          if (existing) {
            existing.toolInvocation.result = c.result;
            existing.toolInvocation.state = "result";
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (parts.length > 0) {
      this._messages.push({
        id: `asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "assistant",
        parts,
        createdAt: new Date(),
      } as unknown as InferChatUIMessage<TAgent>);
    }
  }
}

// ─── Internal session state ────────────────────────────────────────

type ChatSessionState = {
  runId: string;
  publicAccessToken: string;
  lastEventId?: string;
  skipToTurnComplete?: boolean;
};

// ─── ChatClient ────────────────────────────────────────────────────

/**
 * Server-side chat client for interacting with Trigger.dev chat agents.
 *
 * Pass the agent type for full type inference:
 * ```ts
 * const client = new ChatClient<typeof myAgent>({ task: "my-agent" });
 * ```
 */
export class ChatClient<TAgent = unknown> {
  private readonly taskId: string;
  private readonly streamKey: string;
  private readonly streamTimeoutSeconds: number;
  private readonly defaultClientData: InferChatClientData<TAgent> | undefined;
  private readonly triggerOptions: ChatClientOptions["triggerOptions"];

  private sessions = new Map<string, ChatSessionState>();

  constructor(options: ChatClientOptions<TAgent>) {
    this.taskId = options.task;
    this.streamKey = options.streamKey ?? CHAT_STREAM_KEY;
    this.streamTimeoutSeconds = options.streamTimeoutSeconds ?? 120;
    this.defaultClientData = options.clientData;
    this.triggerOptions = options.triggerOptions;
  }

  /**
   * Create a conversation handle for multi-turn interaction.
   * Accumulates messages and provides typed stream access.
   */
  conversation(
    chatId: string,
    options?: { clientData?: InferChatClientData<TAgent> }
  ): ChatConversation<TAgent> {
    const merged = this.mergeClientData(options?.clientData as Record<string, unknown> | undefined);
    return new ChatConversation<TAgent>(this, chatId, merged as InferChatClientData<TAgent>);
  }

  /**
   * Eagerly trigger a run before the first message is sent.
   * No-op if a session already exists for this chatId.
   */
  async preload(
    chatId: string,
    options?: {
      clientData?: InferChatClientData<TAgent>;
      idleTimeoutInSeconds?: number;
    }
  ): Promise<ChatSession> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      return {
        runId: existing.runId,
        publicAccessToken: existing.publicAccessToken,
        lastEventId: existing.lastEventId,
      };
    }

    const metadata = this.mergeClientData(options?.clientData as Record<string, unknown> | undefined);

    const payload = {
      messages: [] as never[],
      chatId,
      trigger: "preload" as const,
      metadata,
      ...(options?.idleTimeoutInSeconds !== undefined
        ? { idleTimeoutInSeconds: options.idleTimeoutInSeconds }
        : {}),
    };

    const session = await this.triggerNewRun(chatId, payload, "preload");
    this.sessions.set(chatId, session);

    return {
      runId: session.runId,
      publicAccessToken: session.publicAccessToken,
    };
  }

  /**
   * Send messages and subscribe to the response stream.
   * Returns a raw `ReadableStream<UIMessageChunk>`.
   * For higher-level access, use `conversation()`.
   */
  async sendMessages(
    chatId: string,
    messages: UIMessageLike[],
    options?: {
      trigger?: "submit-message" | "regenerate-message";
      clientData?: InferChatClientData<TAgent>;
      abortSignal?: AbortSignal;
    }
  ): Promise<ReadableStream<UIMessageChunk>> {
    const triggerType = options?.trigger ?? "submit-message";
    const metadata = this.mergeClientData(options?.clientData as Record<string, unknown> | undefined);

    const payload: Record<string, unknown> = {
      messages,
      chatId,
      trigger: triggerType,
      metadata,
    };

    const session = this.sessions.get(chatId);
    let isContinuation = false;
    let previousRunId: string | undefined;

    if (session?.runId) {
      const minimalPayload = {
        ...payload,
        messages: triggerType === "submit-message" ? messages.slice(-1) : messages,
      };

      try {
        const api = this.createStreamApiClient(session.publicAccessToken);
        await api.sendInputStream(session.runId, CHAT_MESSAGES_STREAM_ID, minimalPayload);

        return this.subscribeToStream(
          session.runId,
          session.publicAccessToken,
          options?.abortSignal,
          chatId
        );
      } catch {
        previousRunId = session.runId;
        this.sessions.delete(chatId);
        isContinuation = true;
      }
    }

    const triggerPayload = {
      ...payload,
      continuation: isContinuation,
      ...(previousRunId ? { previousRunId } : {}),
    };

    const newSession = await this.triggerNewRun(chatId, triggerPayload, "trigger");
    this.sessions.set(chatId, newSession);

    return this.subscribeToStream(
      newSession.runId,
      newSession.publicAccessToken,
      options?.abortSignal,
      chatId
    );
  }

  /**
   * Send a steering/pending message without starting a new response stream.
   * @returns `true` if sent, `false` if no active session.
   */
  async sendPendingMessage(
    chatId: string,
    message: UIMessageLike,
    clientData?: Record<string, unknown>
  ): Promise<boolean> {
    const session = this.sessions.get(chatId);
    if (!session?.runId) return false;

    const metadata = this.mergeClientData(clientData);
    const payload = {
      messages: [message],
      chatId,
      trigger: "submit-message" as const,
      metadata,
    };

    try {
      const api = this.createStreamApiClient(session.publicAccessToken);
      await api.sendInputStream(session.runId, CHAT_MESSAGES_STREAM_ID, payload);
      return true;
    } catch {
      return false;
    }
  }

  /** Send a stop signal to the running agent. */
  async stop(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session?.runId) return;

    session.skipToTurnComplete = true;
    const api = this.createStreamApiClient(session.publicAccessToken);
    await api
      .sendInputStream(session.runId, CHAT_STOP_STREAM_ID, { stop: true })
      .catch(() => {});
  }

  /** Signal the agent to stop waiting and exit gracefully. */
  async close(chatId: string): Promise<boolean> {
    const session = this.sessions.get(chatId);
    if (!session?.runId) return false;

    try {
      const api = this.createStreamApiClient(session.publicAccessToken);
      await api.sendInputStream(session.runId, CHAT_MESSAGES_STREAM_ID, {
        messages: [],
        chatId,
        trigger: "close" as const,
      });
      this.sessions.delete(chatId);
      return true;
    } catch {
      return false;
    }
  }

  /** Reconnect to an existing session's response stream. */
  async reconnect(
    chatId: string,
    abortSignal?: AbortSignal
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const session = this.sessions.get(chatId);
    if (!session) return null;

    return this.subscribeToStream(
      session.runId,
      session.publicAccessToken,
      abortSignal,
      chatId,
      { sendStopOnAbort: false }
    );
  }

  getSession(chatId: string): ChatSession | undefined {
    const session = this.sessions.get(chatId);
    if (!session) return undefined;
    return {
      runId: session.runId,
      publicAccessToken: session.publicAccessToken,
      lastEventId: session.lastEventId,
    };
  }

  setSession(chatId: string, session: ChatSession): void {
    this.sessions.set(chatId, {
      runId: session.runId,
      publicAccessToken: session.publicAccessToken,
      lastEventId: session.lastEventId,
    });
  }

  deleteSession(chatId: string): void {
    this.sessions.delete(chatId);
  }

  // ─── Private helpers ───────────────────────────────────────────

  private mergeClientData(
    perCall?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const defaults = this.defaultClientData as Record<string, unknown> | undefined;
    if (!defaults && !perCall) return undefined;
    return { ...(defaults ?? {}), ...(perCall ?? {}) };
  }

  private createStreamApiClient(accessToken: string): ApiClient {
    const baseURL = apiClientManager.baseURL ?? "https://api.trigger.dev";
    return new ApiClient(baseURL, accessToken);
  }

  private async triggerNewRun(
    chatId: string,
    payload: Record<string, unknown>,
    purpose: "trigger" | "preload"
  ): Promise<ChatSessionState> {
    const autoTags =
      purpose === "preload" ? [`chat:${chatId}`, "preload:true"] : [`chat:${chatId}`];
    const userTags = this.triggerOptions?.tags ?? [];
    const tags = [...autoTags, ...userTags].slice(0, 5);

    const handle = await trigger(this.taskId, payload, {
      tags,
      queue: this.triggerOptions?.queue,
      maxAttempts: this.triggerOptions?.maxAttempts,
      machine: this.triggerOptions?.machine as any,
      priority: this.triggerOptions?.priority,
    });

    const runId = handle.id;
    const publicAccessToken =
      "publicAccessToken" in handle
        ? (handle as { publicAccessToken?: string }).publicAccessToken
        : undefined;

    const fallbackToken = apiClientManager.accessToken ?? "";

    return {
      runId,
      publicAccessToken: publicAccessToken ?? fallbackToken,
    };
  }

  private subscribeToStream(
    runId: string,
    accessToken: string,
    abortSignal: AbortSignal | undefined,
    chatId?: string,
    options?: { sendStopOnAbort?: boolean }
  ): ReadableStream<UIMessageChunk> {
    const session = chatId ? this.sessions.get(chatId) : undefined;
    const baseURL = apiClientManager.baseURL ?? "https://api.trigger.dev";

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
            const api = new ApiClient(baseURL, session.publicAccessToken);
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

              if (value.id && session) {
                session.lastEventId = value.id;
              }

              if (value.chunk != null && typeof value.chunk === "object") {
                const chunk = value.chunk as Record<string, unknown>;

                if (session?.skipToTurnComplete) {
                  if (chunk.type === "__trigger_turn_complete") {
                    session.skipToTurnComplete = false;
                  }
                  continue;
                }

                if (chunk.type === "__trigger_turn_complete") {
                  if (session && typeof chunk.publicAccessToken === "string") {
                    session.publicAccessToken = chunk.publicAccessToken;
                  }
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
