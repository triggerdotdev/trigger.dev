import type { UIMessage } from "ai";

/**
 * Options for creating a TriggerChatTransport.
 */
export type TriggerChatTransportOptions = {
  /**
   * The Trigger.dev task ID to trigger for chat completions.
   * This task will receive the chat messages as its payload.
   */
  taskId: string;

  /**
   * An access token for authenticating with the Trigger.dev API.
   *
   * This must be a token with permission to trigger the task. You can use:
   * - A **trigger public token** created via `auth.createTriggerPublicToken(taskId)` (recommended for frontend use)
   * - A **secret API key** (for server-side use only — never expose in the browser)
   *
   * The token returned from triggering the task (`publicAccessToken`) is automatically
   * used for subscribing to the realtime stream.
   *
   * Can also be a function that returns a token string, useful for dynamic token refresh:
   * ```ts
   * accessToken: () => getLatestToken()
   * ```
   */
  accessToken: string | (() => string);

  /**
   * Base URL for the Trigger.dev API.
   *
   * @default "https://api.trigger.dev"
   */
  baseURL?: string;

  /**
   * The stream key where the task pipes UIMessageChunk data.
   * Your task must pipe the AI SDK stream to this same key using
   * `streams.pipe(streamKey, result.toUIMessageStream())`.
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
   * before timing out. If no data arrives within this period, the stream
   * will be closed.
   *
   * @default 120
   */
  streamTimeoutSeconds?: number;
};

/**
 * The payload shape that TriggerChatTransport sends to the triggered task.
 *
 * Use this type to type your task's `run` function payload:
 *
 * @example
 * ```ts
 * import { task, streams } from "@trigger.dev/sdk";
 * import { streamText, convertToModelMessages } from "ai";
 * import type { ChatTaskPayload } from "@trigger.dev/ai";
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
export type ChatTaskPayload<TMessage extends UIMessage = UIMessage> = {
  /** The array of UI messages representing the conversation history */
  messages: TMessage[];

  /** The unique identifier for the chat session */
  chatId: string;

  /**
   * The type of message submission:
   * - `"submit-message"`: A new user message was submitted
   * - `"regenerate-message"`: The user wants to regenerate the last assistant response
   */
  trigger: "submit-message" | "regenerate-message";

  /**
   * The ID of the message to regenerate (only present for `"regenerate-message"` trigger).
   */
  messageId?: string;

  /**
   * Custom metadata attached to the chat request by the frontend.
   */
  metadata?: unknown;
};

/**
 * Internal state for tracking active chat sessions, used for stream reconnection.
 */
export type ChatSessionState = {
  runId: string;
  publicAccessToken: string;
};
