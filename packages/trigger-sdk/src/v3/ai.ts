import {
  accessoryAttributes,
  AnyTask,
  isSchemaZodEsque,
  SemanticInternalAttributes,
  Task,
  type inferSchemaIn,
  type PipeStreamOptions,
  type TaskIdentifier,
  type TaskOptions,
  type TaskSchema,
  type TaskWithSchema,
} from "@trigger.dev/core/v3";
import type { ModelMessage, UIMessage } from "ai";
import { convertToModelMessages, dynamicTool, jsonSchema, JSONSchema7, Schema, Tool, ToolCallOptions, zodSchema } from "ai";
import { type Attributes, trace } from "@opentelemetry/api";
import { auth } from "./auth.js";
import { metadata } from "./metadata.js";
import { streams } from "./streams.js";
import { createTask } from "./shared.js";
import { tracer } from "./tracer.js";
import {
  CHAT_STREAM_KEY as _CHAT_STREAM_KEY,
  CHAT_MESSAGES_STREAM_ID,
  CHAT_STOP_STREAM_ID,
} from "./chat-constants.js";

const METADATA_KEY = "tool.execute.options";

export type ToolCallExecutionOptions = Omit<ToolCallOptions, "abortSignal">;

type ToolResultContent = Array<
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      data: string;
      mimeType?: string;
    }
>;

export type ToolOptions<TResult> = {
  experimental_toToolResultContent?: (result: TResult) => ToolResultContent;
};

function toolFromTask<TIdentifier extends string, TInput = void, TOutput = unknown>(
  task: Task<TIdentifier, TInput, TOutput>,
  options?: ToolOptions<TOutput>
): Tool<TInput, TOutput>;
function toolFromTask<
  TIdentifier extends string,
  TTaskSchema extends TaskSchema | undefined = undefined,
  TOutput = unknown,
>(
  task: TaskWithSchema<TIdentifier, TTaskSchema, TOutput>,
  options?: ToolOptions<TOutput>
): Tool<inferSchemaIn<TTaskSchema>, TOutput>;
function toolFromTask<
  TIdentifier extends string,
  TTaskSchema extends TaskSchema | undefined = undefined,
  TInput = void,
  TOutput = unknown,
>(
  task: TaskWithSchema<TIdentifier, TTaskSchema, TOutput> | Task<TIdentifier, TInput, TOutput>,
  options?: ToolOptions<TOutput>
): TTaskSchema extends TaskSchema
  ? Tool<inferSchemaIn<TTaskSchema>, TOutput>
  : Tool<TInput, TOutput> {
  if (("schema" in task && !task.schema) || ("jsonSchema" in task && !task.jsonSchema)) {
    throw new Error(
      "Cannot convert this task to to a tool because the task has no schema. Make sure to either use schemaTask or a task with an input jsonSchema."
    );
  }

  const toolDefinition = dynamicTool({
    description: task.description,
    inputSchema: convertTaskSchemaToToolParameters(task),
    execute: async (input, options) => {
      const serializedOptions = options ? JSON.parse(JSON.stringify(options)) : undefined;

      return await task
        .triggerAndWait(input as inferSchemaIn<TTaskSchema>, {
          metadata: {
            [METADATA_KEY]: serializedOptions,
          },
        })
        .unwrap();
    },
    ...options,
  });

  return toolDefinition as TTaskSchema extends TaskSchema
    ? Tool<inferSchemaIn<TTaskSchema>, TOutput>
    : Tool<TInput, TOutput>;
}

function getToolOptionsFromMetadata(): ToolCallExecutionOptions | undefined {
  const tool = metadata.get(METADATA_KEY);
  if (!tool) {
    return undefined;
  }
  return tool as ToolCallExecutionOptions;
}

function convertTaskSchemaToToolParameters(
  task: AnyTask | TaskWithSchema<any, any, any>
): Schema<unknown> {
  if ("schema" in task) {
    // If TaskSchema is ArkTypeEsque, use ai.jsonSchema to convert it to a Schema
    if ("toJsonSchema" in task.schema && typeof task.schema.toJsonSchema === "function") {
      return jsonSchema((task.schema as any).toJsonSchema());
    }

    // If TaskSchema is ZodEsque, use ai.zodSchema to convert it to a Schema
    if (isSchemaZodEsque(task.schema)) {
      return zodSchema(task.schema as any);
    }
  }

  if ("jsonSchema" in task) {
    return jsonSchema(task.jsonSchema as JSONSchema7);
  }

  throw new Error(
    "Cannot convert task to a tool. Make sure to use a task with a schema or jsonSchema."
  );
}

export const ai = {
  tool: toolFromTask,
  currentToolOptions: getToolOptionsFromMetadata,
};

/**
 * Creates a public access token for a chat task.
 *
 * This is a convenience helper that creates a multi-use trigger public token
 * scoped to the given task. Use it in a server action to provide the frontend
 * `TriggerChatTransport` with an `accessToken`.
 *
 * @example
 * ```ts
 * // actions.ts
 * "use server";
 * import { chat } from "@trigger.dev/sdk/ai";
 * import type { myChat } from "@/trigger/chat";
 *
 * export const getChatToken = () => chat.createAccessToken<typeof myChat>("my-chat");
 * ```
 */
function createChatAccessToken<TTask extends AnyTask>(
  taskId: TaskIdentifier<TTask>
): Promise<string> {
  return auth.createTriggerPublicToken(taskId as string, { multipleUse: true });
}

// ---------------------------------------------------------------------------
// Chat transport helpers — backend side
// ---------------------------------------------------------------------------

/**
 * The default stream key used for chat transport communication.
 * Both `TriggerChatTransport` (frontend) and `pipeChat`/`chatTask` (backend)
 * use this key by default.
 */
export const CHAT_STREAM_KEY = _CHAT_STREAM_KEY;

// Re-export input stream IDs for advanced usage
export { CHAT_MESSAGES_STREAM_ID, CHAT_STOP_STREAM_ID };

/**
 * The wire payload shape sent by `TriggerChatTransport`.
 * Uses `metadata` to match the AI SDK's `ChatRequestOptions` field name.
 * @internal
 */
type ChatTaskWirePayload<TMessage extends UIMessage = UIMessage> = {
  messages: TMessage[];
  chatId: string;
  trigger: "submit-message" | "regenerate-message";
  messageId?: string;
  metadata?: unknown;
};

/**
 * The payload shape passed to the `chatTask` run function.
 *
 * - `messages` contains model-ready messages (converted via `convertToModelMessages`) —
 *   pass these directly to `streamText`.
 * - `uiMessages` contains the raw `UIMessage[]` from the frontend.
 * - `clientData` contains custom data from the frontend (the `metadata` field from `sendMessage()`).
 */
export type ChatTaskPayload = {
  /** Model-ready messages — pass directly to `streamText({ messages })`. */
  messages: ModelMessage[];

  /** Raw UI messages from the frontend. */
  uiMessages: UIMessage[];

  /** The unique identifier for the chat session */
  chatId: string;

  /**
   * The trigger type:
   * - `"submit-message"`: A new user message
   * - `"regenerate-message"`: Regenerate the last assistant response
   */
  trigger: "submit-message" | "regenerate-message";

  /** The ID of the message to regenerate (only for `"regenerate-message"`) */
  messageId?: string;

  /** Custom data from the frontend (passed via `metadata` on `sendMessage()` or the transport). */
  clientData?: unknown;
};

/**
 * Abort signals provided to the `chatTask` run function.
 */
export type ChatTaskSignals = {
  /** Combined signal — fires on run cancel OR stop generation. Pass to `streamText`. */
  signal: AbortSignal;
  /** Fires only when the run is cancelled, expired, or exceeds maxDuration. */
  cancelSignal: AbortSignal;
  /** Fires only when the frontend stops generation for this turn (per-turn, reset each turn). */
  stopSignal: AbortSignal;
};

/**
 * The full payload passed to a `chatTask` run function.
 * Extends `ChatTaskPayload` (the wire payload) with abort signals.
 */
export type ChatTaskRunPayload = ChatTaskPayload & ChatTaskSignals;

// Input streams for bidirectional chat communication
const messagesInput = streams.input<ChatTaskWirePayload>({ id: CHAT_MESSAGES_STREAM_ID });
const stopInput = streams.input<{ stop: true; message?: string }>({ id: CHAT_STOP_STREAM_ID });

/**
 * Strips provider-specific IDs from message parts so that partial/stopped
 * assistant responses don't cause 404s when sent back to the provider
 * (e.g. OpenAI Responses API message IDs).
 * @internal
 */
function sanitizeMessages<TMessage extends UIMessage>(messages: TMessage[]): TMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant" || !msg.parts) return msg;
    return {
      ...msg,
      parts: msg.parts.map((part: any) => {
        // Strip provider-specific metadata (e.g. OpenAI Responses API itemId)
        // and streaming state from assistant message parts. These cause 404s
        // when partial/stopped responses are sent back to the provider.
        const { providerMetadata, state, id, ...rest } = part;
        return rest;
      }),
    };
  });
}

/**
 * Tracks how many times `pipeChat` has been called in the current `chatTask` run.
 * Used to prevent double-piping when a user both calls `pipeChat()` manually
 * and returns a streamable from their `run` function.
 * @internal
 */
let _chatPipeCount = 0;

/**
 * Options for `pipeChat`.
 */
export type PipeChatOptions = {
  /**
   * Override the stream key. Must match the `streamKey` on `TriggerChatTransport`.
   * @default "chat"
   */
  streamKey?: string;

  /** An AbortSignal to cancel the stream. */
  signal?: AbortSignal;

  /**
   * The target run ID to pipe to.
   * @default "self" (current run)
   */
  target?: string;

  /** Override the default span name for this operation. */
  spanName?: string;
};

/**
 * An object with a `toUIMessageStream()` method (e.g. `StreamTextResult` from `streamText()`).
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
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return typeof value === "object" && value !== null && typeof (value as any).getReader === "function";
}

/**
 * Pipes a chat stream to the realtime stream, making it available to the
 * `TriggerChatTransport` on the frontend.
 *
 * Accepts:
 * - A `StreamTextResult` from `streamText()` (has `.toUIMessageStream()`)
 * - An `AsyncIterable` of `UIMessageChunk`s
 * - A `ReadableStream` of `UIMessageChunk`s
 *
 * Must be called from inside a Trigger.dev task's `run` function.
 *
 * @example
 * ```ts
 * import { task } from "@trigger.dev/sdk";
 * import { chat, type ChatTaskPayload } from "@trigger.dev/sdk/ai";
 * import { streamText, convertToModelMessages } from "ai";
 *
 * export const myChatTask = task({
 *   id: "my-chat-task",
 *   run: async (payload: ChatTaskPayload) => {
 *     const result = streamText({
 *       model: openai("gpt-4o"),
 *       messages: payload.messages,
 *     });
 *
 *     await chat.pipe(result);
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Works from anywhere inside a task — even deep in your agent code
 * async function runAgentLoop(messages: CoreMessage[]) {
 *   const result = streamText({ model, messages });
 *   await chat.pipe(result);
 * }
 * ```
 */
async function pipeChat(
  source: UIMessageStreamable | AsyncIterable<unknown> | ReadableStream<unknown>,
  options?: PipeChatOptions
): Promise<void> {
  _chatPipeCount++;
  const streamKey = options?.streamKey ?? CHAT_STREAM_KEY;

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

  const pipeOptions: PipeStreamOptions = {};
  if (options?.signal) {
    pipeOptions.signal = options.signal;
  }
  if (options?.target) {
    pipeOptions.target = options.target;
  }
  if (options?.spanName) {
    pipeOptions.spanName = options.spanName;
  }

  const { waitUntilComplete } = streams.pipe(streamKey, stream, pipeOptions);
  await waitUntilComplete();
}

/**
 * Options for defining a chat task.
 *
 * Extends the standard `TaskOptions` but pre-types the payload as `ChatTaskPayload`
 * and overrides `run` to accept `ChatTaskRunPayload` (with abort signals).
 *
 * **Auto-piping:** If the `run` function returns a value with `.toUIMessageStream()`
 * (like a `StreamTextResult`), the stream is automatically piped to the frontend.
 *
 * **Single-run mode:** By default, the task uses input streams so that the
 * entire conversation lives inside one run. After each AI response, the task
 * emits a control chunk and suspends via `messagesInput.wait()`. The frontend
 * transport resumes the same run by sending the next message via input streams.
 */
export type ChatTaskOptions<TIdentifier extends string> = Omit<
  TaskOptions<TIdentifier, ChatTaskWirePayload, unknown>,
  "run"
> & {
  /**
   * The run function for the chat task.
   *
   * Receives a `ChatTaskRunPayload` with the conversation messages, chat session ID,
   * trigger type, and abort signals (`signal`, `cancelSignal`, `stopSignal`).
   *
   * **Auto-piping:** If this function returns a value with `.toUIMessageStream()`,
   * the stream is automatically piped to the frontend.
   */
  run: (payload: ChatTaskRunPayload) => Promise<unknown>;

  /**
   * Maximum number of conversational turns (message round-trips) a single run
   * will handle before ending. After this many turns the run completes
   * normally and the next message will start a fresh run.
   *
   * @default 100
   */
  maxTurns?: number;

  /**
   * How long to wait for the next message before timing out and ending the run.
   * Accepts any duration string (e.g. `"1h"`, `"30m"`).
   *
   * @default "1h"
   */
  turnTimeout?: string;

  /**
   * How long (in seconds) to keep the run warm after each turn before suspending.
   * During this window the run stays active and can respond instantly to the
   * next message. After this timeout, the run suspends (frees compute) and waits
   * via `inputStream.wait()`.
   *
   * Set to `0` to suspend immediately after each turn.
   *
   * @default 30
   */
  warmTimeoutInSeconds?: number;
};

/**
 * Creates a Trigger.dev task pre-configured for AI SDK chat.
 *
 * - **Pre-types the payload** as `ChatTaskRunPayload` — includes abort signals
 * - **Auto-pipes the stream** if `run` returns a `StreamTextResult`
 * - **Multi-turn**: keeps the conversation in a single run using input streams
 * - **Stop support**: frontend can stop generation mid-stream via the stop input stream
 * - For complex flows, use `pipeChat()` from anywhere inside your task code
 *
 * @example
 * ```ts
 * import { chat } from "@trigger.dev/sdk/ai";
 * import { streamText, convertToModelMessages } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * export const myChat = chat.task({
 *   id: "my-chat",
 *   run: async ({ messages, signal }) => {
 *     return streamText({
 *       model: openai("gpt-4o"),
 *       messages, // already converted via convertToModelMessages
 *       abortSignal: signal,
 *     });
 *   },
 * });
 * ```
 */
function chatTask<TIdentifier extends string>(
  options: ChatTaskOptions<TIdentifier>
): Task<TIdentifier, ChatTaskWirePayload, unknown> {
  const {
    run: userRun,
    maxTurns = 100,
    turnTimeout = "1h",
    warmTimeoutInSeconds = 30,
    ...restOptions
  } = options;

  return createTask<TIdentifier, ChatTaskWirePayload, unknown>({
    ...restOptions,
    run: async (payload: ChatTaskWirePayload, { signal: runSignal }) => {
      // Set gen_ai.conversation.id on the run-level span for dashboard context
      const activeSpan = trace.getActiveSpan();
      if (activeSpan) {
        activeSpan.setAttribute("gen_ai.conversation.id", payload.chatId);
      }

      let currentWirePayload = payload;

      // Mutable reference to the current turn's stop controller so the
      // stop input stream listener (registered once) can abort the right turn.
      let currentStopController: AbortController | undefined;

      // Listen for stop signals for the lifetime of the run
      const stopSub = stopInput.on((data) => {
        currentStopController?.abort(data?.message || "stopped");
      });

      try {
        for (let turn = 0; turn < maxTurns; turn++) {
          // Extract turn-level context before entering the span
          const { metadata: wireMetadata, messages: uiMessages, ...restWire } = currentWirePayload;
          const lastUserMessage = extractLastUserMessageText(uiMessages);

          const turnAttributes: Attributes = {
            "turn.number": turn + 1,
            "gen_ai.conversation.id": currentWirePayload.chatId,
            "gen_ai.operation.name": "chat",
            "chat.trigger": currentWirePayload.trigger,
            [SemanticInternalAttributes.STYLE_ICON]: "tabler-message-chatbot",
            [SemanticInternalAttributes.ENTITY_TYPE]: "chat-turn",
          };

          if (lastUserMessage) {
            turnAttributes["chat.user_message"] = lastUserMessage;

            // Show a truncated preview of the user message as an accessory
            const preview =
              lastUserMessage.length > 80
                ? lastUserMessage.slice(0, 80) + "..."
                : lastUserMessage;
            Object.assign(
              turnAttributes,
              accessoryAttributes({
                items: [{ text: preview, variant: "normal" }],
                style: "codepath",
              })
            );
          }

          if (wireMetadata !== undefined) {
            turnAttributes["chat.client_data"] =
              typeof wireMetadata === "string" ? wireMetadata : JSON.stringify(wireMetadata);
          }

          const turnResult = await tracer.startActiveSpan(
            `chat turn ${turn + 1}`,
            async () => {
              _chatPipeCount = 0;

              // Per-turn stop controller (reset each turn)
              const stopController = new AbortController();
              currentStopController = stopController;

              // Three signals for the user's run function
              const stopSignal = stopController.signal;
              const cancelSignal = runSignal;
              const combinedSignal = AbortSignal.any([runSignal, stopController.signal]);

              // Buffer messages that arrive during streaming
              const pendingMessages: ChatTaskWirePayload[] = [];
              const msgSub = messagesInput.on((msg) => {
                pendingMessages.push(msg);
              });

              // Convert wire payload to user-facing payload
              const sanitized = sanitizeMessages(uiMessages);
              const modelMessages = await convertToModelMessages(sanitized);

              try {
                const result = await userRun({
                  ...restWire,
                  messages: modelMessages,
                  uiMessages: sanitized,
                  clientData: wireMetadata,
                  signal: combinedSignal,
                  cancelSignal,
                  stopSignal,
                });

                // Auto-pipe if the run function returned a StreamTextResult or similar,
                // but only if pipeChat() wasn't already called manually during this turn
                if (_chatPipeCount === 0 && isUIMessageStreamable(result)) {
                  await pipeChat(result, { signal: combinedSignal, spanName: "stream response" });
                }
              } catch (error) {
                // Handle AbortError from streamText gracefully
                if (error instanceof Error && error.name === "AbortError") {
                  if (runSignal.aborted) {
                    return "exit"; // Full run cancellation — exit
                  }
                  // Stop generation — fall through to continue the loop
                } else {
                  throw error;
                }
              } finally {
                msgSub.off();
              }

              if (runSignal.aborted) return "exit";

              // Write turn-complete control chunk so frontend closes its stream
              await writeTurnCompleteChunk(currentWirePayload.chatId);

              // If messages arrived during streaming, use the first one immediately
              if (pendingMessages.length > 0) {
                currentWirePayload = pendingMessages[0]!;
                return "continue";
              }

              // Phase 1: Keep the run warm for quick response to the next message.
              // The run stays active (using compute) during this window.
              if (warmTimeoutInSeconds > 0) {
                const warm = await messagesInput.once({
                  timeoutMs: warmTimeoutInSeconds * 1000,
                  spanName: "waiting (warm)",
                });

                if (warm.ok) {
                  // Message arrived while warm — respond instantly
                  currentWirePayload = warm.output;
                  return "continue";
                }
              }

              // Phase 2: Suspend the task (frees compute) until the next message arrives
              const next = await messagesInput.wait({
                timeout: turnTimeout,
                spanName: "waiting (suspended)",
              });

              if (!next.ok) {
                // Timed out waiting for the next message — end the conversation
                return "exit";
              }

              currentWirePayload = next.output;
              return "continue";
            },
            {
              attributes: turnAttributes,
            }
          );

          if (turnResult === "exit") return;
          // "continue" means proceed to next iteration
        }
      } finally {
        stopSub.off();
      }
    },
  });
}

/**
 * Namespace for AI SDK chat integration.
 *
 * @example
 * ```ts
 * import { chat } from "@trigger.dev/sdk/ai";
 *
 * // Define a chat task
 * export const myChat = chat.task({
 *   id: "my-chat",
 *   run: async ({ messages, signal }) => {
 *     return streamText({ model, messages, abortSignal: signal });
 *   },
 * });
 *
 * // Pipe a stream manually (from inside a task)
 * await chat.pipe(streamTextResult);
 *
 * // Create an access token (from a server action)
 * const token = await chat.createAccessToken("my-chat");
 * ```
 */
export const chat = {
  /** Create a chat task. See {@link chatTask}. */
  task: chatTask,
  /** Pipe a stream to the chat transport. See {@link pipeChat}. */
  pipe: pipeChat,
  /** Create a public access token for a chat task. See {@link createChatAccessToken}. */
  createAccessToken: createChatAccessToken,
};

/**
 * Writes a turn-complete control chunk to the chat output stream.
 * The frontend transport intercepts this to close the ReadableStream for the current turn.
 * @internal
 */
async function writeTurnCompleteChunk(chatId?: string): Promise<void> {
  const { waitUntilComplete } = streams.writer(CHAT_STREAM_KEY, {
    spanName: "turn complete",
    collapsed: true,
    execute: ({ write }) => {
      write({ type: "__trigger_turn_complete" });
    },
  });
  await waitUntilComplete();
}

/**
 * Extracts the text content of the last user message from a UIMessage array.
 * Returns undefined if no user message is found.
 * @internal
 */
function extractLastUserMessageText(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;

    // UIMessage uses parts array
    if (msg.parts) {
      const textParts = msg.parts
        .filter((p: any) => p.type === "text" && p.text)
        .map((p: any) => p.text as string);
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }

    break;
  }

  return undefined;
}
