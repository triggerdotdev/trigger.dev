import type { ChatTransport, UIMessage, UIMessageChunk, ChatRequestOptions } from "ai";
import {
  ApiClient,
  SSEStreamSubscription,
  type SSEStreamPart,
} from "@trigger.dev/core/v3";
import type { TriggerChatTransportOptions, ChatSessionState } from "./types.js";

const DEFAULT_STREAM_KEY = "chat";
const DEFAULT_BASE_URL = "https://api.trigger.dev";
const DEFAULT_STREAM_TIMEOUT_SECONDS = 120;

/**
 * A custom AI SDK `ChatTransport` implementation that bridges the Vercel AI SDK's
 * `useChat` hook with Trigger.dev's durable task execution and realtime streams.
 *
 * When `sendMessages` is called, the transport:
 * 1. Triggers a Trigger.dev task with the chat messages as payload
 * 2. Subscribes to the task's realtime stream to receive `UIMessageChunk` data
 * 3. Returns a `ReadableStream<UIMessageChunk>` that the AI SDK processes natively
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { TriggerChatTransport } from "@trigger.dev/ai";
 *
 * function Chat({ accessToken }: { accessToken: string }) {
 *   const { messages, sendMessage, status } = useChat({
 *     transport: new TriggerChatTransport({
 *       accessToken,
 *       taskId: "my-chat-task",
 *     }),
 *   });
 *
 *   // ... render messages
 * }
 * ```
 *
 * On the backend, the task should pipe UIMessageChunks to the `"chat"` stream:
 *
 * @example
 * ```ts
 * import { task, streams } from "@trigger.dev/sdk";
 * import { streamText, convertToModelMessages } from "ai";
 *
 * export const myChatTask = task({
 *   id: "my-chat-task",
 *   run: async (payload: ChatTaskPayload) => {
 *     const result = streamText({
 *       model: openai("gpt-4o"),
 *       messages: convertToModelMessages(payload.messages),
 *     });
 *
 *     const { waitUntilComplete } = streams.pipe("chat", result.toUIMessageStream());
 *     await waitUntilComplete();
 *   },
 * });
 * ```
 */
export class TriggerChatTransport implements ChatTransport<UIMessage> {
  private readonly taskId: string;
  private readonly accessToken: string;
  private readonly baseURL: string;
  private readonly streamKey: string;
  private readonly extraHeaders: Record<string, string>;

  /**
   * Tracks active chat sessions for reconnection support.
   * Maps chatId → session state (runId, publicAccessToken).
   */
  private sessions: Map<string, ChatSessionState> = new Map();

  constructor(options: TriggerChatTransportOptions) {
    this.taskId = options.taskId;
    this.accessToken = options.accessToken;
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    this.streamKey = options.streamKey ?? DEFAULT_STREAM_KEY;
    this.extraHeaders = options.headers ?? {};
  }

  /**
   * Sends messages to a Trigger.dev task and returns a streaming response.
   *
   * This method:
   * 1. Triggers the configured task with the chat messages as payload
   * 2. Subscribes to the task's realtime stream for UIMessageChunk events
   * 3. Returns a ReadableStream that the AI SDK's useChat hook processes
   */
  sendMessages = async (
    options: {
      trigger: "submit-message" | "regenerate-message";
      chatId: string;
      messageId: string | undefined;
      messages: UIMessage[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk>> => {
    const { trigger, chatId, messageId, messages, abortSignal, headers, body, metadata } = options;

    // Build the payload for the task
    const payload = {
      messages,
      chatId,
      trigger,
      messageId,
      metadata,
      ...(body ?? {}),
    };

    // Create API client for triggering
    const apiClient = new ApiClient(this.baseURL, this.accessToken);

    // Trigger the task
    const triggerResponse = await apiClient.triggerTask(this.taskId, {
      payload: JSON.stringify(payload),
      options: {
        payloadType: "application/json",
      },
    });

    const runId = triggerResponse.id;
    const publicAccessToken = "publicAccessToken" in triggerResponse
      ? (triggerResponse as { publicAccessToken?: string }).publicAccessToken
      : undefined;

    // Store session state for reconnection
    this.sessions.set(chatId, {
      runId,
      publicAccessToken: publicAccessToken ?? this.accessToken,
    });

    // Subscribe to the realtime stream for this run
    return this.subscribeToStream(runId, publicAccessToken ?? this.accessToken, abortSignal);
  };

  /**
   * Reconnects to an existing streaming response for the specified chat session.
   *
   * Returns a ReadableStream if an active session exists, or null if no session is found.
   */
  reconnectToStream = async (
    options: {
      chatId: string;
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk> | null> => {
    const { chatId } = options;

    const session = this.sessions.get(chatId);
    if (!session) {
      return null;
    }

    return this.subscribeToStream(session.runId, session.publicAccessToken, undefined);
  };

  /**
   * Creates a ReadableStream<UIMessageChunk> by subscribing to the realtime SSE stream
   * for a given run.
   */
  private subscribeToStream(
    runId: string,
    accessToken: string,
    abortSignal: AbortSignal | undefined
  ): ReadableStream<UIMessageChunk> {
    const streamKey = this.streamKey;
    const baseURL = this.baseURL;
    const extraHeaders = this.extraHeaders;

    // Build the authorization header
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      ...extraHeaders,
    };

    const subscription = new SSEStreamSubscription(
      `${baseURL}/realtime/v1/streams/${runId}/${streamKey}`,
      {
        headers,
        signal: abortSignal,
        timeoutInSeconds: DEFAULT_STREAM_TIMEOUT_SECONDS,
      }
    );

    // We need to convert the SSEStreamPart stream to a UIMessageChunk stream
    // SSEStreamPart has { id, chunk, timestamp } where chunk is the deserialized UIMessageChunk
    let sseStreamPromise: Promise<ReadableStream<SSEStreamPart>> | null = null;

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        try {
          sseStreamPromise = subscription.subscribe();
          const sseStream = await sseStreamPromise;
          const reader = sseStream.getReader();

          try {
            while (true) {
              const { done, value } = await reader.read();

              if (done) {
                controller.close();
                return;
              }

              if (abortSignal?.aborted) {
                reader.cancel();
                reader.releaseLock();
                controller.close();
                return;
              }

              // Each SSE part's chunk is a UIMessageChunk
              controller.enqueue(value.chunk as UIMessageChunk);
            }
          } catch (readError) {
            reader.releaseLock();
            throw readError;
          }
        } catch (error) {
          // Don't error the stream for abort errors
          if (error instanceof Error && error.name === "AbortError") {
            controller.close();
            return;
          }

          controller.error(error);
        }
      },
      cancel: () => {
        // Cancellation is handled by the abort signal
      },
    });
  }
}

/**
 * Creates a new `TriggerChatTransport` instance.
 *
 * This is a convenience factory function equivalent to `new TriggerChatTransport(options)`.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { createChatTransport } from "@trigger.dev/ai";
 *
 * const transport = createChatTransport({
 *   taskId: "my-chat-task",
 *   accessToken: publicAccessToken,
 * });
 *
 * function Chat() {
 *   const { messages, sendMessage } = useChat({ transport });
 *   // ...
 * }
 * ```
 */
export function createChatTransport(options: TriggerChatTransportOptions): TriggerChatTransport {
  return new TriggerChatTransport(options);
}
