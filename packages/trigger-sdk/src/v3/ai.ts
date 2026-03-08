import {
  accessoryAttributes,
  AnyTask,
  getSchemaParseFn,
  isSchemaZodEsque,
  SemanticInternalAttributes,
  Task,
  taskContext,
  type inferSchemaIn,
  type inferSchemaOut,
  type PipeStreamOptions,
  type TaskIdentifier,
  type TaskOptions,
  type TaskSchema,
  type TaskWithSchema,
} from "@trigger.dev/core/v3";
import type { ModelMessage, UIMessage, UIMessageChunk } from "ai";
import type { StreamWriteResult } from "@trigger.dev/core/v3";
import { convertToModelMessages, dynamicTool, generateId as generateMessageId, jsonSchema, JSONSchema7, Schema, Tool, ToolCallOptions, zodSchema } from "ai";
import { type Attributes, trace } from "@opentelemetry/api";
import { auth } from "./auth.js";
import { locals } from "./locals.js";
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
  return auth.createTriggerPublicToken(taskId as string, { expirationTime: "24h" });
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
 * Typed chat output stream. Provides `.writer()`, `.pipe()`, `.append()`,
 * and `.read()` methods pre-bound to the chat stream key and typed to `UIMessageChunk`.
 *
 * Use from within a `chat.task` run to write custom chunks:
 * ```ts
 * const { waitUntilComplete } = chat.stream.writer({
 *   execute: ({ write }) => {
 *     write({ type: "text-start", id: "status-1" });
 *     write({ type: "text-delta", id: "status-1", delta: "Processing..." });
 *     write({ type: "text-end", id: "status-1" });
 *   },
 * });
 * await waitUntilComplete();
 * ```
 *
 * Use from a subtask to stream back to the parent chat:
 * ```ts
 * chat.stream.pipe(myStream, { target: "root" });
 * ```
 */
const chatStream = streams.define<UIMessageChunk>({ id: _CHAT_STREAM_KEY });

/**
 * The wire payload shape sent by `TriggerChatTransport`.
 * Uses `metadata` to match the AI SDK's `ChatRequestOptions` field name.
 * @internal
 */
type ChatTaskWirePayload<TMessage extends UIMessage = UIMessage, TMetadata = unknown> = {
  messages: TMessage[];
  chatId: string;
  trigger: "submit-message" | "regenerate-message";
  messageId?: string;
  metadata?: TMetadata;
  /** Whether this run is continuing an existing chat whose previous run ended. */
  continuation?: boolean;
  /** The run ID of the previous run (only set when `continuation` is true). */
  previousRunId?: string;
};

/**
 * The payload shape passed to the `chatTask` run function.
 *
 * - `messages` contains model-ready messages (converted via `convertToModelMessages`) —
 *   pass these directly to `streamText`.
 * - `clientData` contains custom data from the frontend (the `metadata` field from `sendMessage()`).
 *
 * The backend accumulates the full conversation history across turns, so the frontend
 * only needs to send new messages after the first turn.
 */
export type ChatTaskPayload<TClientData = unknown> = {
  /** Model-ready messages — pass directly to `streamText({ messages })`. */
  messages: ModelMessage[];

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
  clientData?: TClientData;

  /** Whether this run is continuing an existing chat (previous run timed out or was cancelled). False for brand new chats. */
  continuation: boolean;
  /** The run ID of the previous run (only set when `continuation` is true). */
  previousRunId?: string;
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
export type ChatTaskRunPayload<TClientData = unknown> = ChatTaskPayload<TClientData> & ChatTaskSignals;

// Input streams for bidirectional chat communication
const messagesInput = streams.input<ChatTaskWirePayload>({ id: CHAT_MESSAGES_STREAM_ID });
const stopInput = streams.input<{ stop: true; message?: string }>({ id: CHAT_STOP_STREAM_ID });

/**
 * Run-scoped pipe counter. Stored in locals so concurrent runs in the
 * same worker don't share state.
 * @internal
 */
const chatPipeCountKey = locals.create<number>("chat.pipeCount");
const chatStopControllerKey = locals.create<AbortController>("chat.stopController");

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
  locals.set(chatPipeCountKey, (locals.get(chatPipeCountKey) ?? 0) + 1);
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
/**
 * Event passed to the `onChatStart` callback.
 */
export type ChatStartEvent<TClientData = unknown> = {
  /** The unique identifier for the chat session. */
  chatId: string;
  /** The initial model-ready messages for this conversation. */
  messages: ModelMessage[];
  /** Custom data from the frontend (passed via `metadata` on `sendMessage()` or the transport). */
  clientData: TClientData;
  /** The Trigger.dev run ID for this conversation. */
  runId: string;
  /** A scoped access token for this chat run. Persist this for frontend reconnection. */
  chatAccessToken: string;
  /** Whether this run is continuing an existing chat (previous run timed out or was cancelled). False for brand new chats. */
  continuation: boolean;
  /** The run ID of the previous run (only set when `continuation` is true). */
  previousRunId?: string;
};

/**
 * Event passed to the `onTurnStart` callback.
 */
export type TurnStartEvent<TClientData = unknown> = {
  /** The unique identifier for the chat session. */
  chatId: string;
  /** The accumulated model-ready messages (all turns so far, including new user message). */
  messages: ModelMessage[];
  /** The accumulated UI messages (all turns so far, including new user message). */
  uiMessages: UIMessage[];
  /** The turn number (0-indexed). */
  turn: number;
  /** The Trigger.dev run ID for this conversation. */
  runId: string;
  /** A scoped access token for this chat run. */
  chatAccessToken: string;
  /** Custom data from the frontend. */
  clientData?: TClientData;
  /** Whether this run is continuing an existing chat (previous run timed out or was cancelled). False for brand new chats. */
  continuation: boolean;
  /** The run ID of the previous run (only set when `continuation` is true). */
  previousRunId?: string;
};

/**
 * Event passed to the `onTurnComplete` callback.
 */
export type TurnCompleteEvent<TClientData = unknown> = {
  /** The unique identifier for the chat session. */
  chatId: string;
  /** The full accumulated conversation in model format (all turns so far). */
  messages: ModelMessage[];
  /**
   * The full accumulated conversation in UI format (all turns so far).
   * This is the format expected by `useChat` — store this for persistence.
   */
  uiMessages: UIMessage[];
  /**
   * Only the new model messages from this turn (user message(s) + assistant response).
   * Useful for appending to an existing conversation record.
   */
  newMessages: ModelMessage[];
  /**
   * Only the new UI messages from this turn (user message(s) + assistant response).
   * Useful for inserting individual message records instead of overwriting the full history.
   */
  newUIMessages: UIMessage[];
  /** The assistant's response for this turn, with aborted parts cleaned up when `stopped` is true. Undefined if `pipeChat` was used manually. */
  responseMessage: UIMessage | undefined;
  /**
   * The raw assistant response before abort cleanup. Includes incomplete tool parts
   * (`input-available`, `partial-call`) and streaming reasoning/text parts.
   * Use this if you need custom cleanup logic. Same as `responseMessage` when not stopped.
   */
  rawResponseMessage: UIMessage | undefined;
  /** The turn number (0-indexed). */
  turn: number;
  /** The Trigger.dev run ID for this conversation. */
  runId: string;
  /** A fresh scoped access token for this chat run (renewed each turn). Persist this for frontend reconnection. */
  chatAccessToken: string;
  /** The last event ID from the stream writer. Use this with `resume: true` to avoid replaying events after refresh. */
  lastEventId?: string;
  /** Custom data from the frontend. */
  clientData?: TClientData;
  /** Whether the user stopped generation during this turn. */
  stopped: boolean;
  /** Whether this run is continuing an existing chat (previous run timed out or was cancelled). False for brand new chats. */
  continuation: boolean;
  /** The run ID of the previous run (only set when `continuation` is true). */
  previousRunId?: string;
};

export type ChatTaskOptions<
  TIdentifier extends string,
  TClientDataSchema extends TaskSchema | undefined = undefined,
> = Omit<TaskOptions<TIdentifier, ChatTaskWirePayload, unknown>, "run"> & {
  /**
   * Schema for validating `clientData` from the frontend.
   * Accepts Zod, ArkType, Valibot, or any supported schema library.
   * When provided, `clientData` is parsed and typed in all hooks and `run`.
   *
   * @example
   * ```ts
   * import { z } from "zod";
   *
   * chat.task({
   *   id: "my-chat",
   *   clientDataSchema: z.object({ model: z.string().optional(), userId: z.string() }),
   *   run: async ({ messages, clientData, signal }) => {
   *     // clientData is typed as { model?: string; userId: string }
   *   },
   * });
   * ```
   */
  clientDataSchema?: TClientDataSchema;

  /**
   * The run function for the chat task.
   *
   * Receives a `ChatTaskRunPayload` with the conversation messages, chat session ID,
   * trigger type, and abort signals (`signal`, `cancelSignal`, `stopSignal`).
   *
   * **Auto-piping:** If this function returns a value with `.toUIMessageStream()`,
   * the stream is automatically piped to the frontend.
   */
  run: (payload: ChatTaskRunPayload<inferSchemaOut<TClientDataSchema>>) => Promise<unknown>;

  /**
   * Called on the first turn (turn 0) of a new run, before the `run` function executes.
   *
   * Use this to create the chat record in your database when a new conversation starts.
   *
   * @example
   * ```ts
   * onChatStart: async ({ chatId, messages, clientData }) => {
   *   await db.chat.create({ data: { id: chatId, userId: clientData.userId } });
   * }
   * ```
   */
  onChatStart?: (event: ChatStartEvent<inferSchemaOut<TClientDataSchema>>) => Promise<void> | void;

  /**
   * Called at the start of every turn, after message accumulation and `onChatStart` (turn 0),
   * but before the `run` function executes.
   *
   * Use this to persist messages before streaming begins, so a mid-stream page refresh
   * still shows the user's message.
   *
   * @example
   * ```ts
   * onTurnStart: async ({ chatId, uiMessages }) => {
   *   await db.chat.update({ where: { id: chatId }, data: { messages: uiMessages } });
   * }
   * ```
   */
  onTurnStart?: (event: TurnStartEvent<inferSchemaOut<TClientDataSchema>>) => Promise<void> | void;

  /**
   * Called after each turn completes (after the response is captured, before waiting
   * for the next message). Also fires on the final turn.
   *
   * Use this to persist the conversation to your database after each assistant response.
   *
   * @example
   * ```ts
   * onTurnComplete: async ({ chatId, messages }) => {
   *   await db.chat.update({ where: { id: chatId }, data: { messages } });
   * }
   * ```
   */
  onTurnComplete?: (event: TurnCompleteEvent<inferSchemaOut<TClientDataSchema>>) => Promise<void> | void;

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

  /**
   * How long the `chatAccessToken` (scoped to this run) remains valid.
   * A fresh token is minted after each turn, so this only needs to cover
   * the gap between turns.
   *
   * Accepts a duration string (e.g. `"1h"`, `"30m"`, `"2h"`).
   *
   * @default "1h"
   */
  chatAccessTokenTTL?: string;
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
function chatTask<
  TIdentifier extends string,
  TClientDataSchema extends TaskSchema | undefined = undefined,
>(
  options: ChatTaskOptions<TIdentifier, TClientDataSchema>
): Task<TIdentifier, ChatTaskWirePayload<UIMessage, inferSchemaIn<TClientDataSchema>>, unknown> {
  const {
    run: userRun,
    clientDataSchema,
    onChatStart,
    onTurnStart,
    onTurnComplete,
    maxTurns = 100,
    turnTimeout = "1h",
    warmTimeoutInSeconds = 30,
    chatAccessTokenTTL = "1h",
    ...restOptions
  } = options;

  const parseClientData = clientDataSchema
    ? getSchemaParseFn(clientDataSchema)
    : undefined;

  return createTask<TIdentifier, ChatTaskWirePayload<UIMessage, inferSchemaIn<TClientDataSchema>>, unknown>({
    ...restOptions,
    run: async (payload: ChatTaskWirePayload, { signal: runSignal }) => {
      // Set gen_ai.conversation.id on the run-level span for dashboard context
      const activeSpan = trace.getActiveSpan();
      if (activeSpan) {
        activeSpan.setAttribute("gen_ai.conversation.id", payload.chatId);
      }

      let currentWirePayload = payload;
      const continuation = payload.continuation ?? false;
      const previousRunId = payload.previousRunId;

      // Accumulated model messages across turns. Turn 1 initialises from the
      // full history the frontend sends; subsequent turns append only the new
      // user message(s) and the captured assistant response.
      let accumulatedMessages: ModelMessage[] = [];

      // Accumulated UI messages for persistence. Mirrors the model accumulator
      // but in frontend-friendly UIMessage format (with parts, id, etc.).
      let accumulatedUIMessages: UIMessage[] = [];

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
          const clientData = (parseClientData
            ? await parseClientData(wireMetadata)
            : wireMetadata) as inferSchemaOut<TClientDataSchema>;
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
              locals.set(chatPipeCountKey, 0);

              // Per-turn stop controller (reset each turn)
              const stopController = new AbortController();
              currentStopController = stopController;
              locals.set(chatStopControllerKey, stopController);

              // Three signals for the user's run function
              const stopSignal = stopController.signal;
              const cancelSignal = runSignal;
              const combinedSignal = AbortSignal.any([runSignal, stopController.signal]);

              // Buffer messages that arrive during streaming
              const pendingMessages: ChatTaskWirePayload[] = [];
              const msgSub = messagesInput.on((msg) => {
                pendingMessages.push(msg);
              });

              // Clean up any incomplete tool parts in the incoming history.
              // When a previous run was stopped mid-tool-call, the frontend's
              // useChat state may still contain assistant messages with tool parts
              // in partial/input-available state. These cause API errors (e.g.
              // Anthropic requires every tool_use to have a matching tool_result).
              const cleanedUIMessages = uiMessages.map((msg) =>
                msg.role === "assistant" ? cleanupAbortedParts(msg) : msg
              );

              // Convert the incoming UIMessages to model messages and update the accumulator.
              // Turn 1: full history from the frontend → replaces the accumulator.
              // Turn 2+: only the new message(s) → appended to the accumulator.
              const incomingModelMessages = await convertToModelMessages(cleanedUIMessages);

              // Track new messages for this turn (user input + assistant response).
              const turnNewModelMessages: ModelMessage[] = [];
              const turnNewUIMessages: UIMessage[] = [];

              if (turn === 0) {
                accumulatedMessages = incomingModelMessages;
                accumulatedUIMessages = [...cleanedUIMessages];
                // On first turn, the "new" messages are just the last user message
                // (the rest is history). We'll add the response after streaming.
                if (cleanedUIMessages.length > 0) {
                  turnNewUIMessages.push(cleanedUIMessages[cleanedUIMessages.length - 1]!);
                  const lastModel = incomingModelMessages[incomingModelMessages.length - 1];
                  if (lastModel) turnNewModelMessages.push(lastModel);
                }
              } else if (currentWirePayload.trigger === "regenerate-message") {
                // Regenerate: frontend sent full history with last assistant message
                // removed. Reset the accumulator to match.
                accumulatedMessages = incomingModelMessages;
                accumulatedUIMessages = [...cleanedUIMessages];
                // No new user messages for regenerate — just the response (added below)
              } else {
                // Submit: frontend sent only the new user message(s). Append to accumulator.
                accumulatedMessages.push(...incomingModelMessages);
                accumulatedUIMessages.push(...cleanedUIMessages);
                turnNewModelMessages.push(...incomingModelMessages);
                turnNewUIMessages.push(...cleanedUIMessages);
              }

              // Mint a scoped public access token once per turn, reused for
              // onChatStart, onTurnStart, onTurnComplete, and the turn-complete chunk.
              const currentRunId = taskContext.ctx?.run.id ?? "";
              let turnAccessToken = "";
              if (currentRunId) {
                try {
                  turnAccessToken = await auth.createPublicToken({
                    scopes: {
                      read: { runs: currentRunId },
                      write: { inputStreams: currentRunId },
                    },
                    expirationTime: chatAccessTokenTTL,
                  });
                } catch {
                  // Token creation failed
                }
              }

              // Fire onChatStart on the first turn
              if (turn === 0 && onChatStart) {
                await tracer.startActiveSpan(
                  "onChatStart()",
                  async () => {
                    await onChatStart({
                      chatId: currentWirePayload.chatId,
                      messages: accumulatedMessages,
                      clientData,
                      runId: currentRunId,
                      chatAccessToken: turnAccessToken,
                      continuation,
                      previousRunId,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "task-hook-onStart",
                      [SemanticInternalAttributes.COLLAPSED]: true,
                      "chat.id": currentWirePayload.chatId,
                      "chat.messages.count": accumulatedMessages.length,
                      "chat.continuation": continuation,
                      ...(previousRunId ? { "chat.previous_run_id": previousRunId } : {}),
                    },
                  }
                );
              }

              // Fire onTurnStart before running user code — persist messages
              // so a mid-stream page refresh still shows the user's message.
              if (onTurnStart) {
                await tracer.startActiveSpan(
                  "onTurnStart()",
                  async () => {
                    await onTurnStart({
                      chatId: currentWirePayload.chatId,
                      messages: accumulatedMessages,
                      uiMessages: accumulatedUIMessages,
                      turn,
                      runId: currentRunId,
                      chatAccessToken: turnAccessToken,
                      clientData,
                      continuation,
                      previousRunId,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "task-hook-onStart",
                      [SemanticInternalAttributes.COLLAPSED]: true,
                      "chat.id": currentWirePayload.chatId,
                      "chat.turn": turn + 1,
                      "chat.messages.count": accumulatedMessages.length,
                      "chat.trigger": currentWirePayload.trigger,
                      "chat.continuation": continuation,
                      ...(previousRunId ? { "chat.previous_run_id": previousRunId } : {}),
                    },
                  }
                );
              }

              // Captured by the onFinish callback below — works even on abort/stop.
              let capturedResponseMessage: UIMessage | undefined;

              // Promise that resolves when the AI SDK's onFinish fires.
              // On abort, the stream's cancel() handler calls onFinish
              // asynchronously AFTER pipeChat resolves, so we must await
              // this to avoid a race where we check capturedResponseMessage
              // before it's been set.
              let resolveOnFinish: () => void;
              const onFinishPromise = new Promise<void>((r) => { resolveOnFinish = r; });
              let onFinishAttached = false;

              try {
                const result = await userRun({
                  ...restWire,
                  messages: accumulatedMessages,
                  clientData,
                  continuation,
                  previousRunId,
                  signal: combinedSignal,
                  cancelSignal,
                  stopSignal,
                } as any);

                // Auto-pipe if the run function returned a StreamTextResult or similar,
                // but only if pipeChat() wasn't already called manually during this turn.
                // We call toUIMessageStream ourselves to attach onFinish for response capture.
                if ((locals.get(chatPipeCountKey) ?? 0) === 0 && isUIMessageStreamable(result)) {
                  onFinishAttached = true;
                  const uiStream = result.toUIMessageStream({
                    onFinish: ({ responseMessage }: { responseMessage: UIMessage }) => {
                      capturedResponseMessage = responseMessage;
                      resolveOnFinish!();
                    },
                  });
                  await pipeChat(uiStream, { signal: combinedSignal, spanName: "stream response" });
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

              // Wait for onFinish to fire — on abort this may resolve slightly
              // after pipeChat, since the stream's cancel() handler is async.
              if (onFinishAttached) {
                await onFinishPromise;
              }

              // Determine if the user stopped generation this turn (not a full run cancel).
              const wasStopped = stopController.signal.aborted && !runSignal.aborted;

              // Append the assistant's response (partial or complete) to the accumulator.
              // The onFinish callback fires even on abort/stop, so partial responses
              // from stopped generation are captured correctly.
              let rawResponseMessage: UIMessage | undefined;
              if (capturedResponseMessage) {
                // Keep the raw message before cleanup for users who want custom handling
                rawResponseMessage = capturedResponseMessage;
                // Clean up aborted parts (streaming tool calls, reasoning) when stopped
                if (wasStopped) {
                  capturedResponseMessage = cleanupAbortedParts(capturedResponseMessage);
                }
                // Ensure the response message has an ID (the stream's onFinish
                // may produce a message with an empty ID since IDs are normally
                // assigned by the frontend's useChat).
                if (!capturedResponseMessage.id) {
                  capturedResponseMessage = { ...capturedResponseMessage, id: generateMessageId() };
                }
                accumulatedUIMessages.push(capturedResponseMessage);
                turnNewUIMessages.push(capturedResponseMessage);
                try {
                  const responseModelMessages = await convertToModelMessages([
                    stripProviderMetadata(capturedResponseMessage),
                  ]);
                  accumulatedMessages.push(...responseModelMessages);
                  turnNewModelMessages.push(...responseModelMessages);
                } catch {
                  // Conversion failed — skip accumulation for this turn
                }
              }
              // TODO: When the user calls `pipeChat` manually instead of returning a
              // StreamTextResult, we don't have access to onFinish. A future iteration
              // should let manual-mode users report back response messages for
              // accumulation (e.g. via a `chat.addMessages()` helper).

              if (runSignal.aborted) return "exit";

              // Write turn-complete control chunk so frontend closes its stream.
              // Capture the lastEventId from the stream writer for resume support.
              const turnCompleteResult = await writeTurnCompleteChunk(
                currentWirePayload.chatId,
                turnAccessToken
              );

              // Fire onTurnComplete after response capture
              if (onTurnComplete) {
                await tracer.startActiveSpan(
                  "onTurnComplete()",
                  async () => {
                    await onTurnComplete({
                      chatId: currentWirePayload.chatId,
                      messages: accumulatedMessages,
                      uiMessages: accumulatedUIMessages,
                      newMessages: turnNewModelMessages,
                      newUIMessages: turnNewUIMessages,
                      responseMessage: capturedResponseMessage,
                      rawResponseMessage,
                      turn,
                      runId: currentRunId,
                      chatAccessToken: turnAccessToken,
                      lastEventId: turnCompleteResult.lastEventId,
                      clientData,
                      stopped: wasStopped,
                      continuation,
                      previousRunId,
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "task-hook-onComplete",
                      [SemanticInternalAttributes.COLLAPSED]: true,
                      "chat.id": currentWirePayload.chatId,
                      "chat.turn": turn + 1,
                      "chat.stopped": wasStopped,
                      "chat.continuation": continuation,
                      ...(previousRunId ? { "chat.previous_run_id": previousRunId } : {}),
                      "chat.messages.count": accumulatedMessages.length,
                      "chat.response.parts.count": capturedResponseMessage?.parts?.length ?? 0,
                      "chat.new_messages.count": turnNewUIMessages.length,
                    },
                  }
                );
              }

              // If messages arrived during streaming, use the first one immediately
              if (pendingMessages.length > 0) {
                currentWirePayload = pendingMessages[0]!;
                return "continue";
              }

              // Phase 1: Keep the run warm for quick response to the next message.
              // The run stays active (using compute) during this window.
              const effectiveWarmTimeout =
                (metadata.get(WARM_TIMEOUT_METADATA_KEY) as number | undefined) ?? warmTimeoutInSeconds;

              if (effectiveWarmTimeout > 0) {
                const warm = await messagesInput.once({
                  timeoutMs: effectiveWarmTimeout * 1000,
                  spanName: "waiting (warm)",
                });

                if (warm.ok) {
                  // Message arrived while warm — respond instantly
                  currentWirePayload = warm.output;
                  return "continue";
                }
              }

              // Phase 2: Suspend the task (frees compute) until the next message arrives
              const effectiveTurnTimeout =
                (metadata.get(TURN_TIMEOUT_METADATA_KEY) as string | undefined) ?? turnTimeout;

              const next = await messagesInput.wait({
                timeout: effectiveTurnTimeout,
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
// ---------------------------------------------------------------------------
// Runtime configuration helpers
// ---------------------------------------------------------------------------

const TURN_TIMEOUT_METADATA_KEY = "chat.turnTimeout";
const WARM_TIMEOUT_METADATA_KEY = "chat.warmTimeout";

/**
 * Override the turn timeout for subsequent turns in the current run.
 *
 * The turn timeout controls how long the run stays suspended (freeing compute)
 * waiting for the next user message. When it expires, the run completes
 * gracefully and the next message starts a fresh run.
 *
 * Call from inside a `chatTask` run function to adjust based on context.
 *
 * @param duration - A duration string (e.g. `"5m"`, `"1h"`, `"30s"`)
 *
 * @example
 * ```ts
 * run: async ({ messages, signal }) => {
 *   chat.setTurnTimeout("2h");
 *   return streamText({ model, messages, abortSignal: signal });
 * }
 * ```
 */
function setTurnTimeout(duration: string): void {
  metadata.set(TURN_TIMEOUT_METADATA_KEY, duration);
}

/**
 * Override the turn timeout in seconds for subsequent turns in the current run.
 *
 * @param seconds - Number of seconds to wait for the next message before ending the run
 *
 * @example
 * ```ts
 * run: async ({ messages, signal }) => {
 *   chat.setTurnTimeoutInSeconds(3600); // 1 hour
 *   return streamText({ model, messages, abortSignal: signal });
 * }
 * ```
 */
function setTurnTimeoutInSeconds(seconds: number): void {
  metadata.set(TURN_TIMEOUT_METADATA_KEY, `${seconds}s`);
}

/**
 * Override the warm timeout for subsequent turns in the current run.
 *
 * The warm timeout controls how long the run stays active (using compute)
 * after each turn, waiting for the next message. During this window,
 * responses are instant. After it expires, the run suspends.
 *
 * @param seconds - Number of seconds to stay warm (0 to suspend immediately)
 *
 * @example
 * ```ts
 * run: async ({ messages, signal }) => {
 *   chat.setWarmTimeoutInSeconds(60);
 *   return streamText({ model, messages, abortSignal: signal });
 * }
 * ```
 */
function setWarmTimeoutInSeconds(seconds: number): void {
  metadata.set(WARM_TIMEOUT_METADATA_KEY, seconds);
}

// ---------------------------------------------------------------------------
// Stop detection
// ---------------------------------------------------------------------------

/**
 * Check whether the user stopped generation during the current turn.
 *
 * Works from **anywhere** inside a `chat.task` run — including inside
 * `streamText`'s `onFinish` callback — without needing to thread the
 * `stopSignal` through closures.
 *
 * This is especially useful when the AI SDK's `isAborted` flag is unreliable
 * (e.g. when using `createUIMessageStream` + `writer.merge()`).
 *
 * @example
 * ```ts
 * onFinish: ({ isAborted }) => {
 *   const wasStopped = isAborted || chat.isStopped();
 *   if (wasStopped) {
 *     // handle stop
 *   }
 * }
 * ```
 */
function isStopped(): boolean {
  const controller = locals.get(chatStopControllerKey);
  return controller?.signal.aborted ?? false;
}

// ---------------------------------------------------------------------------
// Aborted message cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up a UIMessage that was captured during an aborted/stopped turn.
 *
 * When generation is stopped mid-stream, the captured message may contain:
 * - Tool parts stuck in incomplete states (`partial-call`, `input-available`,
 *   `input-streaming`) that cause permanent UI spinners
 * - Reasoning parts with `state: "streaming"` instead of `"done"`
 * - Text parts with `state: "streaming"` instead of `"done"`
 *
 * This function returns a cleaned copy with:
 * - Incomplete tool parts removed entirely
 * - Reasoning and text parts marked as `"done"`
 *
 * `chat.task` calls this automatically when stop is detected before passing
 * the response to `onTurnComplete`. Use this manually when calling `pipeChat`
 * directly and capturing response messages yourself.
 *
 * @example
 * ```ts
 * onTurnComplete: async ({ responseMessage, stopped }) => {
 *   // Already cleaned automatically by chat.task — but if you captured
 *   // your own message via pipeChat, clean it manually:
 *   const cleaned = chat.cleanupAbortedParts(myMessage);
 *   await db.messages.save(cleaned);
 * }
 * ```
 */
function cleanupAbortedParts(message: UIMessage): UIMessage {
  if (!message.parts) return message;

  const isToolPart = (part: any) =>
    part.type === "tool-invocation" ||
    part.type?.startsWith("tool-") ||
    part.type === "dynamic-tool";

  return {
    ...message,
    parts: message.parts
      .filter((part: any) => {
        if (!isToolPart(part)) return true;
        // Remove tool parts that never completed execution.
        // partial-call: input was still streaming when aborted.
        // input-available: input was complete but tool never ran.
        // input-streaming: input was mid-stream.
        const state = part.toolInvocation?.state ?? part.state;
        return state !== "partial-call" && state !== "input-available" && state !== "input-streaming";
      })
      .map((part: any) => {
        // Mark streaming reasoning as done
        if (part.type === "reasoning" && part.state === "streaming") {
          return { ...part, state: "done" };
        }
        // Mark streaming text as done
        if (part.type === "text" && part.state === "streaming") {
          return { ...part, state: "done" };
        }
        return part;
      }),
  };
}

// ---------------------------------------------------------------------------
// chat.local — per-run typed data with Proxy access
// ---------------------------------------------------------------------------

/** @internal Symbol for storing the locals key on the proxy target. */
const CHAT_LOCAL_KEY: unique symbol = Symbol("chatLocalKey");
/** @internal Symbol for storing the dirty-tracking locals key. */
const CHAT_LOCAL_DIRTY_KEY: unique symbol = Symbol("chatLocalDirtyKey");
/** @internal Counter for generating unique locals IDs. */
let chatLocalCounter = 0;

/**
 * A Proxy-backed, run-scoped data object that appears as `T` to users.
 * Includes helper methods for initialization, dirty tracking, and serialization.
 * Internal metadata is stored behind Symbols and invisible to
 * `Object.keys()`, `JSON.stringify()`, and spread.
 */
export type ChatLocal<T extends Record<string, unknown>> = T & {
  /** Initialize the local with a value. Call in `onChatStart` or `run()`. */
  init(value: T): void;
  /** Returns `true` if any property was set since the last check. Resets the dirty flag. */
  hasChanged(): boolean;
  /** Returns a plain object copy of the current value. Useful for persistence. */
  get(): T;
  readonly [CHAT_LOCAL_KEY]: ReturnType<typeof locals.create<T>>;
  readonly [CHAT_LOCAL_DIRTY_KEY]: ReturnType<typeof locals.create<boolean>>;
};

/**
 * Creates a per-run typed data object accessible from anywhere during task execution.
 *
 * Declare at module level, then initialize inside a lifecycle hook (e.g. `onChatStart`)
 * using `chat.initLocal()`. Properties are accessible directly via the Proxy.
 *
 * Multiple locals can coexist — each gets its own isolated run-scoped storage.
 *
 * @example
 * ```ts
 * import { chat } from "@trigger.dev/sdk/ai";
 *
 * const userPrefs = chat.local<{ theme: string; language: string }>();
 * const gameState = chat.local<{ score: number; streak: number }>();
 *
 * export const myChat = chat.task({
 *   id: "my-chat",
 *   onChatStart: async ({ clientData }) => {
 *     const prefs = await db.prefs.findUnique({ where: { userId: clientData.userId } });
 *     userPrefs.init(prefs ?? { theme: "dark", language: "en" });
 *     gameState.init({ score: 0, streak: 0 });
 *   },
 *   onTurnComplete: async ({ chatId }) => {
 *     if (gameState.hasChanged()) {
 *       await db.save({ where: { chatId }, data: gameState.get() });
 *     }
 *   },
 *   run: async ({ messages }) => {
 *     gameState.score++;
 *     return streamText({
 *       system: `User prefers ${userPrefs.theme} theme. Score: ${gameState.score}`,
 *       messages,
 *     });
 *   },
 * });
 * ```
 */
function chatLocal<T extends Record<string, unknown>>(): ChatLocal<T> {
  const localKey = locals.create<T>(`chat.local.${chatLocalCounter++}`);
  const dirtyKey = locals.create<boolean>(`chat.local.${chatLocalCounter++}.dirty`);

  const target = {} as any;
  target[CHAT_LOCAL_KEY] = localKey;
  target[CHAT_LOCAL_DIRTY_KEY] = dirtyKey;

  return new Proxy(target, {
    get(_target, prop, _receiver) {
      // Internal Symbol properties
      if (prop === CHAT_LOCAL_KEY) return _target[CHAT_LOCAL_KEY];
      if (prop === CHAT_LOCAL_DIRTY_KEY) return _target[CHAT_LOCAL_DIRTY_KEY];

      // Instance methods
      if (prop === "init") {
        return (value: T) => {
          locals.set(localKey, value);
          locals.set(dirtyKey, false);
        };
      }
      if (prop === "hasChanged") {
        return () => {
          const dirty = locals.get(dirtyKey) ?? false;
          locals.set(dirtyKey, false);
          return dirty;
        };
      }
      if (prop === "get") {
        return () => {
          const current = locals.get(localKey);
          if (current === undefined) {
            throw new Error(
              "local.get() called before initialization. Call local.init() first."
            );
          }
          return { ...current };
        };
      }
      // toJSON for serialization (JSON.stringify(local))
      if (prop === "toJSON") {
        return () => {
          const current = locals.get(localKey);
          return current ? { ...current } : undefined;
        };
      }

      const current = locals.get(localKey);
      if (current === undefined) return undefined;
      return (current as any)[prop];
    },

    set(_target, prop, value) {
      // Don't allow setting internal Symbols
      if (typeof prop === "symbol") return false;

      const current = locals.get(localKey);
      if (current === undefined) {
        throw new Error(
          "chat.local can only be modified after initialization. " +
            "Call local.init() in onChatStart or run() first."
        );
      }
      locals.set(localKey, { ...current, [prop]: value });
      locals.set(dirtyKey, true);
      return true;
    },

    has(_target, prop) {
      if (typeof prop === "symbol") return prop in _target;
      const current = locals.get(localKey);
      return current !== undefined && prop in current;
    },

    ownKeys() {
      const current = locals.get(localKey);
      return current ? Reflect.ownKeys(current) : [];
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const current = locals.get(localKey);
      if (current === undefined || !(prop in current)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (current as any)[prop],
      };
    },
  }) as ChatLocal<T>;
}


/**
 * Extracts the client data (metadata) type from a chat task.
 * Use this to type the `metadata` option on the transport.
 *
 * @example
 * ```ts
 * import type { InferChatClientData } from "@trigger.dev/sdk/ai";
 * import type { myChat } from "@/trigger/chat";
 *
 * type MyClientData = InferChatClientData<typeof myChat>;
 * // { model?: string; userId: string }
 * ```
 */
export type InferChatClientData<TTask extends AnyTask> = TTask extends Task<
  string,
  ChatTaskWirePayload<any, infer TMetadata>,
  any
>
  ? TMetadata
  : unknown;

export const chat = {
  /** Create a chat task. See {@link chatTask}. */
  task: chatTask,
  /** Pipe a stream to the chat transport. See {@link pipeChat}. */
  pipe: pipeChat,
  /** Create a per-run typed local. See {@link chatLocal}. */
  local: chatLocal,
  /** Create a public access token for a chat task. See {@link createChatAccessToken}. */
  createAccessToken: createChatAccessToken,
  /** Override the turn timeout at runtime (duration string). See {@link setTurnTimeout}. */
  setTurnTimeout,
  /** Override the turn timeout at runtime (seconds). See {@link setTurnTimeoutInSeconds}. */
  setTurnTimeoutInSeconds,
  /** Override the warm timeout at runtime. See {@link setWarmTimeoutInSeconds}. */
  setWarmTimeoutInSeconds,
  /** Check if the current turn was stopped by the user. See {@link isStopped}. */
  isStopped,
  /** Clean up aborted parts from a UIMessage. See {@link cleanupAbortedParts}. */
  cleanupAbortedParts,
  /** Typed chat output stream for writing custom chunks or piping from subtasks. */
  stream: chatStream,
};

/**
 * Writes a turn-complete control chunk to the chat output stream.
 * The frontend transport intercepts this to close the ReadableStream for the current turn.
 * @internal
 */
async function writeTurnCompleteChunk(chatId?: string, publicAccessToken?: string): Promise<StreamWriteResult> {
  const { waitUntilComplete } = streams.writer(CHAT_STREAM_KEY, {
    spanName: "turn complete",
    collapsed: true,
    execute: ({ write }) => {
      write({
        type: "__trigger_turn_complete",
        ...(publicAccessToken ? { publicAccessToken } : {}),
      });
    },
  });
  return await waitUntilComplete();
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

/**
 * Strips ephemeral OpenAI Responses API `itemId` from a UIMessage's parts.
 *
 * The OpenAI Responses provider attaches `itemId` to message parts via
 * `providerMetadata.openai.itemId`. These IDs are ephemeral — sending them
 * back in a subsequent `streamText` call causes 404s because the provider
 * can't find the referenced item (especially for stopped/partial responses).
 *
 * @internal
 */
function stripProviderMetadata(message: UIMessage): UIMessage {
  if (!message.parts) return message;
  return {
    ...message,
    parts: message.parts.map((part: any) => {
      const openai = part.providerMetadata?.openai;
      if (!openai?.itemId) return part;

      const { itemId, ...restOpenai } = openai;
      const { openai: _, ...restProviders } = part.providerMetadata;
      return {
        ...part,
        providerMetadata: {
          ...restProviders,
          ...(Object.keys(restOpenai).length > 0 ? { openai: restOpenai } : {}),
        },
      };
    }),
  };
}
