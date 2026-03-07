/**
 * @module @trigger.dev/sdk/chat
 *
 * Browser-safe module for AI SDK chat transport integration.
 * Use this on the frontend with the AI SDK's `useChat` hook.
 *
 * For backend helpers (`chatTask`, `pipeChat`), use `@trigger.dev/sdk/ai` instead.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { TriggerChatTransport } from "@trigger.dev/sdk/chat";
 *
 * function Chat({ accessToken }: { accessToken: string }) {
 *   const { messages, sendMessage, status } = useChat({
 *     transport: new TriggerChatTransport({
 *       task: "my-chat-task",
 *       accessToken,
 *     }),
 *   });
 * }
 * ```
 */

import type { ChatTransport, UIMessage, UIMessageChunk, ChatRequestOptions } from "ai";
import { ApiClient, SSEStreamSubscription } from "@trigger.dev/core/v3";
import { CHAT_MESSAGES_STREAM_ID, CHAT_STOP_STREAM_ID } from "./chat-constants.js";

const DEFAULT_STREAM_KEY = "chat";
const DEFAULT_BASE_URL = "https://api.trigger.dev";
const DEFAULT_STREAM_TIMEOUT_SECONDS = 120;



/**
 * Options for creating a TriggerChatTransport.
 */
export type TriggerChatTransportOptions<TClientData = unknown> = {
  /**
   * The Trigger.dev task ID to trigger for chat completions.
   * This task should be defined using `chatTask()` from `@trigger.dev/sdk/ai`,
   * or a regular `task()` that uses `pipeChat()`.
   */
  task: string;

  /**
   * An access token for authenticating with the Trigger.dev API.
   *
   * This must be a token with permission to trigger the task. You can use:
   * - A **trigger public token** created via `auth.createTriggerPublicToken(taskId)` (recommended for frontend use)
   * - A **secret API key** (for server-side use only — never expose in the browser)
   *
   * Can also be a function that returns a token string (sync or async),
   * useful for dynamic token refresh or passing a Next.js server action directly.
   */
  accessToken: string | (() => string | Promise<string>);

  /**
   * Base URL for the Trigger.dev API.
   * @default "https://api.trigger.dev"
   */
  baseURL?: string;

  /**
   * The stream key where the task pipes UIMessageChunk data.
   * When using `chatTask()` or `pipeChat()`, this is handled automatically.
   * Only set this if you're using a custom stream key.
   *
   * @default "chat"
   */
  streamKey?: string;

  /**
   * Additional headers to include in API requests to Trigger.dev.
   */
  headers?: Record<string, string>;

  /**
   * The number of seconds to wait for the realtime stream to produce data
   * before timing out.
   *
   * @default 120
   */
  streamTimeoutSeconds?: number;

  /**
   * Default client data included in every request payload.
   * Merged with per-call `metadata` from `sendMessage()` — per-call values
   * take precedence over transport-level defaults.
   *
   * When the task uses `clientDataSchema`, this is typed to match the schema.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   clientData: { userId: currentUser.id },
   * });
   * ```
   */
  clientData?: TClientData extends Record<string, unknown> ? TClientData : Record<string, unknown>;


  /**
   * Restore active chat sessions from external storage (e.g. localStorage).
   *
   * After a page refresh, pass previously persisted sessions here so the
   * transport can reconnect to existing runs instead of starting new ones.
   * Use `getSession()` to retrieve session state for persistence.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   sessions: {
   *     "chat-abc": { runId: "run_123", publicAccessToken: "...", lastEventId: "42" },
   *   },
   * });
   * ```
   */
  sessions?: Record<string, { runId: string; publicAccessToken: string; lastEventId?: string }>;

  /**
   * Called whenever a chat session's state changes.
   *
   * Fires when:
   * - A new session is created (after triggering a task)
   * - A turn completes (lastEventId updated)
   * - A session is removed (run ended or input stream send failed) — `session` will be `null`
   *
   * Use this to persist session state for reconnection after page refreshes,
   * without needing to call `getSession()` manually.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   onSessionChange: (chatId, session) => {
   *     if (session) {
   *       localStorage.setItem(`session:${chatId}`, JSON.stringify(session));
   *     } else {
   *       localStorage.removeItem(`session:${chatId}`);
   *     }
   *   },
   * });
   * ```
   */
  onSessionChange?: (
    chatId: string,
    session: { runId: string; publicAccessToken: string; lastEventId?: string } | null
  ) => void;

  /**
   * Options forwarded to the Trigger.dev API when starting a new run.
   * Only applies to the first message — subsequent messages reuse the same run.
   *
   * A `chat:{chatId}` tag is automatically added to every run.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   triggerOptions: {
   *     tags: ["user:123"],
   *     queue: "chat-queue",
   *   },
   * });
   * ```
   */
  triggerOptions?: {
    /** Additional tags for the run. A `chat:{chatId}` tag is always added automatically. */
    tags?: string[];
    /** Queue name for the run. */
    queue?: string;
    /** Maximum retry attempts. */
    maxAttempts?: number;
    /** Machine preset for the run. */
    machine?: "micro" | "small-1x" | "small-2x" | "medium-1x" | "medium-2x" | "large-1x" | "large-2x";
    /** Priority (lower = higher priority). */
    priority?: number;
  };
};

/**
 * Internal state for tracking active chat sessions.
 * @internal
 */
type ChatSessionState = {
  runId: string;
  publicAccessToken: string;
  /** Last SSE event ID — used to resume the stream without replaying old events. */
  lastEventId?: string;
  /** Set when the stream was aborted mid-turn (stop). On reconnect, skip chunks until __trigger_turn_complete. */
  skipToTurnComplete?: boolean;
};

/**
 * A custom AI SDK `ChatTransport` that runs chat completions as durable Trigger.dev tasks.
 *
 * When `sendMessages` is called, the transport:
 * 1. Triggers a Trigger.dev task (or sends to an existing run via input streams)
 * 2. Subscribes to the task's realtime stream to receive `UIMessageChunk` data
 * 3. Returns a `ReadableStream<UIMessageChunk>` that the AI SDK processes natively
 *
 * Calling `stop()` from `useChat` sends a stop signal via input streams, which
 * aborts the current `streamText` call in the task without ending the run.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { TriggerChatTransport } from "@trigger.dev/sdk/chat";
 *
 * function Chat({ accessToken }: { accessToken: string }) {
 *   const { messages, sendMessage, stop, status } = useChat({
 *     transport: new TriggerChatTransport({
 *       task: "my-chat-task",
 *       accessToken,
 *     }),
 *   });
 *
 *   // stop() sends a stop signal — the task aborts streamText but keeps the run alive
 * }
 * ```
 */
export class TriggerChatTransport implements ChatTransport<UIMessage> {
  private readonly taskId: string;
  private readonly resolveAccessToken: () => string | Promise<string>;
  private readonly baseURL: string;
  private readonly streamKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly streamTimeoutSeconds: number;
  private readonly defaultMetadata: Record<string, unknown> | undefined;
  private readonly triggerOptions: TriggerChatTransportOptions["triggerOptions"];
  private _onSessionChange:
    | ((
        chatId: string,
        session: { runId: string; publicAccessToken: string; lastEventId?: string } | null
      ) => void)
    | undefined;

  private sessions: Map<string, ChatSessionState> = new Map();
  private activeStreams: Map<string, AbortController> = new Map();

  constructor(options: TriggerChatTransportOptions) {
    this.taskId = options.task;
    this.resolveAccessToken =
      typeof options.accessToken === "function"
        ? options.accessToken
        : () => options.accessToken as string;
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    this.streamKey = options.streamKey ?? DEFAULT_STREAM_KEY;
    this.extraHeaders = options.headers ?? {};
    this.streamTimeoutSeconds = options.streamTimeoutSeconds ?? DEFAULT_STREAM_TIMEOUT_SECONDS;
    this.defaultMetadata = options.clientData;
    this.triggerOptions = options.triggerOptions;
    this._onSessionChange = options.onSessionChange;

    // Restore sessions from external storage
    if (options.sessions) {
      for (const [chatId, session] of Object.entries(options.sessions)) {
        this.sessions.set(chatId, {
          runId: session.runId,
          publicAccessToken: session.publicAccessToken,
          lastEventId: session.lastEventId,
        });
      }
    }
  }

  sendMessages = async (
    options: {
      trigger: "submit-message" | "regenerate-message";
      chatId: string;
      messageId: string | undefined;
      messages: UIMessage[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk>> => {
    const { trigger, chatId, messageId, messages, abortSignal, body, metadata } = options;

    const mergedMetadata =
      this.defaultMetadata || metadata
        ? { ...(this.defaultMetadata ?? {}), ...((metadata as Record<string, unknown>) ?? {}) }
        : undefined;

    const payload = {
      ...(body ?? {}),
      messages,
      chatId,
      trigger,
      messageId,
      metadata: mergedMetadata,
    };

    const session = this.sessions.get(chatId);
    let isContinuation = false;
    let previousRunId: string | undefined;
    // If we have an existing run, send the message via input stream
    // to resume the conversation in the same run.
    if (session?.runId) {
      try {
        // Keep wire payloads minimal — the backend accumulates the full history.
        // For submit-message: only send the new user message (always the last one).
        // For regenerate-message: send full history so the backend can reset its accumulator.
        const minimalPayload = {
          ...payload,
          messages: trigger === "submit-message" ? messages.slice(-1) : messages,
        };

        const apiClient = new ApiClient(this.baseURL, session.publicAccessToken);
        await apiClient.sendInputStream(session.runId, CHAT_MESSAGES_STREAM_ID, minimalPayload);

        // Cancel any active reconnect stream for this chatId before
        // opening a new subscription for the new turn.
        const activeStream = this.activeStreams.get(chatId);
        if (activeStream) {
          activeStream.abort();
          this.activeStreams.delete(chatId);
        }

        return this.subscribeToStream(
          session.runId,
          session.publicAccessToken,
          abortSignal,
          chatId
        );
      } catch {
        // If sending fails (run died, etc.), fall through to trigger a new run.
        // Mark as continuation so the task knows this chat already existed.
        previousRunId = session.runId;
        this.sessions.delete(chatId);
        this.notifySessionChange(chatId, null);
        isContinuation = true;
      }
    }

    // First message or run has ended — trigger a new run
    const currentToken = await this.resolveAccessToken();
    const apiClient = new ApiClient(this.baseURL, currentToken);

    // Auto-tag with chatId; merge with user-provided tags (API limit: 5 tags)
    const autoTags = [`chat:${chatId}`];
    const userTags = this.triggerOptions?.tags ?? [];
    const tags = [...autoTags, ...userTags].slice(0, 5);

    const triggerResponse = await apiClient.triggerTask(this.taskId, {
      payload: {
        ...payload,
        continuation: isContinuation,
        ...(previousRunId ? { previousRunId } : {}),
      },
      options: {
        payloadType: "application/json",
        tags,
        queue: this.triggerOptions?.queue ? { name: this.triggerOptions.queue } : undefined,
        maxAttempts: this.triggerOptions?.maxAttempts,
        machine: this.triggerOptions?.machine,
        priority: this.triggerOptions?.priority,
      },
    });

    const runId = triggerResponse.id;
    const publicAccessToken =
      "publicAccessToken" in triggerResponse
        ? (triggerResponse as { publicAccessToken?: string }).publicAccessToken
        : undefined;

    const newSession: ChatSessionState = {
      runId,
      publicAccessToken: publicAccessToken ?? currentToken,
    };
    this.sessions.set(chatId, newSession);
    this.notifySessionChange(chatId, newSession);
    return this.subscribeToStream(
      runId,
      publicAccessToken ?? currentToken,
      abortSignal,
      chatId
    );
  };

  reconnectToStream = async (
    options: {
      chatId: string;
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk> | null> => {
    const session = this.sessions.get(options.chatId);
    if (!session) {
      return null;
    }

    // Deduplicate: if there's already an active stream for this chatId,
    // return null so the second caller no-ops.
    if (this.activeStreams.has(options.chatId)) {
      return null;
    }

    const abortController = new AbortController();
    this.activeStreams.set(options.chatId, abortController);

    return this.subscribeToStream(
      session.runId,
      session.publicAccessToken,
      abortController.signal,
      options.chatId,
      { sendStopOnAbort: false }
    );
  };

  /**
   * Get the current session state for a chat, suitable for external persistence.
   *
   * Returns `undefined` if no active session exists for this chatId.
   * Persist the returned value to localStorage so it can be restored
   * after a page refresh via `restoreSession()`.
   *
   * @example
   * ```ts
   * const session = transport.getSession(chatId);
   * if (session) {
   *   localStorage.setItem(`session:${chatId}`, JSON.stringify(session));
   * }
   * ```
   */
  getSession = (chatId: string): { runId: string; publicAccessToken: string; lastEventId?: string } | undefined => {
    const session = this.sessions.get(chatId);
    if (!session) return undefined;
    return {
      runId: session.runId,
      publicAccessToken: session.publicAccessToken,
      lastEventId: session.lastEventId,
    };
  };

  /**
   * Update the `onSessionChange` callback.
   * Useful for React hooks that need to update the callback without recreating the transport.
   */
  setOnSessionChange(
    callback:
      | ((
          chatId: string,
          session: { runId: string; publicAccessToken: string; lastEventId?: string } | null
        ) => void)
      | undefined
  ): void {
    this._onSessionChange = callback;
  }

  private notifySessionChange(
    chatId: string,
    session: ChatSessionState | null
  ): void {
    if (!this._onSessionChange) return;
    if (session) {
      this._onSessionChange(chatId, {
        runId: session.runId,
        publicAccessToken: session.publicAccessToken,
        lastEventId: session.lastEventId,
      });
    } else {
      this._onSessionChange(chatId, null);
    }
  }

  private subscribeToStream(
    runId: string,
    accessToken: string,
    abortSignal: AbortSignal | undefined,
    chatId?: string,
    options?: { sendStopOnAbort?: boolean }
  ): ReadableStream<UIMessageChunk> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      ...this.extraHeaders,
    };

    // When resuming a run, skip past previously-seen events
    // so we only receive the new turn's response.
    const session = chatId ? this.sessions.get(chatId) : undefined;

    // Create an internal AbortController so we can terminate the underlying
    // fetch connection when we're done reading (e.g. after intercepting the
    // control chunk). Without this, the SSE connection stays open and leaks.
    const internalAbort = new AbortController();
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, internalAbort.signal])
      : internalAbort.signal;

    // When the caller aborts (user calls stop()), close the SSE connection.
    // Only send a stop signal to the task if this is a user-initiated stop
    // (sendStopOnAbort), not an internal stream management abort.
    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          if (options?.sendStopOnAbort !== false && session) {
            session.skipToTurnComplete = true;
            const api = new ApiClient(this.baseURL, session.publicAccessToken);
            api
              .sendInputStream(session.runId, CHAT_STOP_STREAM_ID, { stop: true })
              .catch(() => {}); // Best-effort
          }
          internalAbort.abort();
        },
        { once: true }
      );
    }

    const subscription = new SSEStreamSubscription(
      `${this.baseURL}/realtime/v1/streams/${runId}/${this.streamKey}`,
      {
        headers,
        signal: combinedSignal,
        timeoutInSeconds: this.streamTimeoutSeconds,
        lastEventId: session?.lastEventId,
      }
    );

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        try {
          const sseStream = await subscription.subscribe();
          const reader = sseStream.getReader();
          let chunkCount = 0;

          try {
            while (true) {
              const { done, value } = await reader.read();

              if (done) {
                controller.close();
                return;
              }

              if (combinedSignal.aborted) {
                internalAbort.abort();
                await reader.cancel();
                controller.close();
                return;
              }

              // Track the last event ID so we can resume from here
              if (value.id && session) {
                session.lastEventId = value.id;
              }


              // Guard against heartbeat or malformed SSE events
              if (value.chunk != null && typeof value.chunk === "object") {
                const chunk = value.chunk as Record<string, unknown>;

                // After a stop, skip leftover chunks from the stopped turn
                // until we see the __trigger_turn_complete marker.
                if (session?.skipToTurnComplete) {
                  if (chunk.type === "__trigger_turn_complete") {
                    session.skipToTurnComplete = false;
                    chunkCount = 0;
                  }
                  continue;
                }

                if (chunk.type === "__trigger_turn_complete" && chatId) {
                  // Update token if a refreshed one was provided in the chunk
                  if (session && typeof chunk.publicAccessToken === "string") {
                    session.publicAccessToken = chunk.publicAccessToken;
                  }
                  // Notify with updated session (including refreshed token)
                  if (session) {
                    this.notifySessionChange(chatId, session);
                  }
                  internalAbort.abort();
                  try {
                    controller.close();
                  } catch {
                    // Controller may already be closed
                  }
                  return;
                }

                chunkCount++;
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

/**
 * Creates a new `TriggerChatTransport` instance.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { createChatTransport } from "@trigger.dev/sdk/chat";
 *
 * const transport = createChatTransport({
 *   task: "my-chat-task",
 *   accessToken: publicAccessToken,
 * });
 *
 * function Chat() {
 *   const { messages, sendMessage } = useChat({ transport });
 * }
 * ```
 */
export function createChatTransport(options: TriggerChatTransportOptions): TriggerChatTransport {
  return new TriggerChatTransport(options);
}
