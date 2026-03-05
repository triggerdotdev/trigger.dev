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
export type TriggerChatTransportOptions = {
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
   * Default metadata included in every request payload.
   * Merged with per-call `metadata` from `sendMessage()` — per-call values
   * take precedence over transport-level defaults.
   *
   * Useful for data that should accompany every message, like a user ID.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   metadata: { userId: currentUser.id },
   * });
   * ```
   */
  metadata?: Record<string, unknown>;
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

  private sessions: Map<string, ChatSessionState> = new Map();

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
    this.defaultMetadata = options.metadata;
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
        return this.subscribeToStream(
          session.runId,
          session.publicAccessToken,
          abortSignal,
          chatId
        );
      } catch {
        // If sending fails (run died, etc.), fall through to trigger a new run.
        this.sessions.delete(chatId);
      }
    }

    // First message or run has ended — trigger a new run
    const currentToken = await this.resolveAccessToken();
    const apiClient = new ApiClient(this.baseURL, currentToken);

    const triggerResponse = await apiClient.triggerTask(this.taskId, {
      payload,
      options: {
        payloadType: "application/json",
      },
    });

    const runId = triggerResponse.id;
    const publicAccessToken =
      "publicAccessToken" in triggerResponse
        ? (triggerResponse as { publicAccessToken?: string }).publicAccessToken
        : undefined;

    this.sessions.set(chatId, {
      runId,
      publicAccessToken: publicAccessToken ?? currentToken,
    });
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

    return this.subscribeToStream(session.runId, session.publicAccessToken, undefined, options.chatId);
  };

  private subscribeToStream(
    runId: string,
    accessToken: string,
    abortSignal: AbortSignal | undefined,
    chatId?: string
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

    // When the caller aborts (user calls stop()), send a stop signal to the
    // running task via input streams, then close the SSE connection.
    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          if (session) {
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
                // Only delete session if the stream ended naturally (not aborted by stop).
                // When the user clicks stop, the abort closes the SSE reader which
                // returns done=true, but the run is still alive and waiting for
                // the next message via input streams.
                if (chatId && !combinedSignal.aborted) {
                  this.sessions.delete(chatId);
                }
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
