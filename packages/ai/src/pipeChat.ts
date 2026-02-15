import { realtimeStreams } from "@trigger.dev/core/v3";

/**
 * The default stream key used for chat transport communication.
 *
 * Both `TriggerChatTransport` (frontend) and `pipeChat` (backend) use this key
 * by default to ensure they communicate over the same stream.
 */
export const CHAT_STREAM_KEY = "chat";

/**
 * Options for `pipeChat`.
 */
export type PipeChatOptions = {
  /**
   * Override the stream key to pipe to.
   * Must match the `streamKey` option on `TriggerChatTransport`.
   *
   * @default "chat"
   */
  streamKey?: string;

  /**
   * An AbortSignal to cancel the stream.
   */
  signal?: AbortSignal;

  /**
   * The target run ID to pipe the stream to.
   * @default "self" (current run)
   */
  target?: string;
};

/**
 * An object that has a `toUIMessageStream()` method, like the result of `streamText()` from the AI SDK.
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as any).getReader === "function"
  );
}

/**
 * Pipes a chat stream to the realtime stream, making it available to the
 * `TriggerChatTransport` on the frontend.
 *
 * Accepts any of:
 * - A `StreamTextResult` from the AI SDK (has `.toUIMessageStream()`)
 * - An `AsyncIterable` of `UIMessageChunk`s
 * - A `ReadableStream` of `UIMessageChunk`s
 *
 * This must be called from inside a Trigger.dev task's `run` function.
 *
 * @example
 * ```ts
 * import { task } from "@trigger.dev/sdk";
 * import { pipeChat, type ChatTaskPayload } from "@trigger.dev/ai";
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
 *     await pipeChat(result);
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Deep inside your agent library — pipeChat works from anywhere inside a task
 * async function runAgentLoop(messages: CoreMessage[]) {
 *   const result = streamText({ model, messages });
 *   await pipeChat(result);
 * }
 * ```
 *
 * @param source - A StreamTextResult, AsyncIterable, or ReadableStream of UIMessageChunks
 * @param options - Optional configuration
 * @returns A promise that resolves when the stream has been fully piped
 */
export async function pipeChat(
  source: UIMessageStreamable | AsyncIterable<unknown> | ReadableStream<unknown>,
  options?: PipeChatOptions
): Promise<void> {
  const streamKey = options?.streamKey ?? CHAT_STREAM_KEY;

  // Resolve the source to an AsyncIterable or ReadableStream
  let stream: AsyncIterable<unknown> | ReadableStream<unknown>;

  if (isUIMessageStreamable(source)) {
    stream = source.toUIMessageStream();
  } else if (isAsyncIterable(source) || isReadableStream(source)) {
    stream = source;
  } else {
    throw new Error(
      "pipeChat: source must be a StreamTextResult (with .toUIMessageStream()), " +
        "an AsyncIterable, or a ReadableStream"
    );
  }

  // Pipe to the realtime stream
  const instance = realtimeStreams.pipe(streamKey, stream, {
    signal: options?.signal,
    target: options?.target,
  });

  await instance.wait();
}
