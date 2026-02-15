import { task as createTask } from "@trigger.dev/sdk";
import type { Task } from "@trigger.dev/core/v3";
import type { ChatTaskPayload } from "./types.js";
import { pipeChat } from "./pipeChat.js";

/**
 * Options for defining a chat task.
 *
 * This is a simplified version of the standard task options with the payload
 * pre-typed as `ChatTaskPayload`.
 */
export type ChatTaskOptions<TIdentifier extends string> = {
  /** Unique identifier for the task */
  id: TIdentifier;

  /** Optional description of the task */
  description?: string;

  /** Retry configuration */
  retry?: {
    maxAttempts?: number;
    factor?: number;
    minTimeoutInMs?: number;
    maxTimeoutInMs?: number;
    randomize?: boolean;
  };

  /** Queue configuration */
  queue?: {
    name?: string;
    concurrencyLimit?: number;
  };

  /** Machine preset for the task */
  machine?: {
    preset?: string;
  };

  /** Maximum duration in seconds */
  maxDuration?: number;

  /**
   * The main run function for the chat task.
   *
   * Receives a `ChatTaskPayload` with the conversation messages, chat session ID,
   * and trigger type.
   *
   * **Auto-piping:** If this function returns a value that has a `.toUIMessageStream()` method
   * (like a `StreamTextResult` from `streamText()`), the stream will automatically be piped
   * to the frontend via the chat realtime stream. If you need to pipe from deeper in your
   * code, use `pipeChat()` instead and don't return the result.
   */
  run: (payload: ChatTaskPayload) => Promise<unknown>;
};

/**
 * An object that has a `toUIMessageStream()` method, like the result of `streamText()`.
 */
type UIMessageStreamable = {
  toUIMessageStream: (...args: any[]) => AsyncIterable<unknown> | ReadableStream<unknown>;
};

function isUIMessageStreamable(value: unknown): value is UIMessageStreamable {
  return (
    typeof value === "object" &&
    value !== null &&
    "toUIMessageStream" in value &&
    typeof (value as any).toUIMessageStream === "function"
  );
}

/**
 * Creates a Trigger.dev task pre-configured for AI SDK chat.
 *
 * This is a convenience wrapper around `task()` from `@trigger.dev/sdk` that:
 * - **Pre-types the payload** as `ChatTaskPayload` — no manual typing needed
 * - **Auto-pipes the stream** if the `run` function returns a `StreamTextResult`
 *
 * Requires `@trigger.dev/sdk` to be installed (it's a peer dependency).
 *
 * @example
 * ```ts
 * import { chatTask } from "@trigger.dev/ai";
 * import { streamText, convertToModelMessages } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * // Simple: return streamText result — auto-piped to the frontend
 * export const myChatTask = chatTask({
 *   id: "my-chat-task",
 *   run: async ({ messages }) => {
 *     return streamText({
 *       model: openai("gpt-4o"),
 *       messages: convertToModelMessages(messages),
 *     });
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * import { chatTask, pipeChat } from "@trigger.dev/ai";
 *
 * // Complex: use pipeChat() from deep inside your agent code
 * export const myAgentTask = chatTask({
 *   id: "my-agent-task",
 *   run: async ({ messages }) => {
 *     await runComplexAgentLoop(messages);
 *     // pipeChat() called internally by the agent loop
 *   },
 * });
 * ```
 */
export function chatTask<TIdentifier extends string>(
  options: ChatTaskOptions<TIdentifier>
): Task<TIdentifier, ChatTaskPayload, unknown> {
  const { run: userRun, ...restOptions } = options;

  return createTask<TIdentifier, ChatTaskPayload, unknown>({
    ...restOptions,
    run: async (payload: ChatTaskPayload) => {
      const result = await userRun(payload);

      // If the run function returned a StreamTextResult or similar,
      // automatically pipe it to the chat stream
      if (isUIMessageStreamable(result)) {
        await pipeChat(result);
      }

      return result;
    },
  });
}
