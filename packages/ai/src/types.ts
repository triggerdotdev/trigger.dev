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
   * A public access token or trigger token for authenticating with the Trigger.dev API.
   * This is used both to trigger the task and to subscribe to the realtime stream.
   *
   * You can generate one using `auth.createTriggerPublicToken()` or
   * `auth.createPublicToken()` from the `@trigger.dev/sdk`.
   */
  accessToken: string;

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
