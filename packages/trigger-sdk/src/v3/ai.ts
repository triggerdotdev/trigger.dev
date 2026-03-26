import {
  accessoryAttributes,
  AnyTask,
  getSchemaParseFn,
  isSchemaZodEsque,
  logger,
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
import type { ModelMessage, UIMessage, UIMessageChunk, UIMessageStreamOptions, LanguageModelUsage } from "ai";
import type { StreamWriteResult } from "@trigger.dev/core/v3";
import { convertToModelMessages, dynamicTool, generateId as generateMessageId, jsonSchema, JSONSchema7, Schema, Tool, ToolCallOptions, zodSchema } from "ai";
import { type Attributes, trace } from "@opentelemetry/api";
import { auth } from "./auth.js";
import { locals } from "./locals.js";
import { metadata } from "./metadata.js";
import type { ResolvedPrompt } from "./prompt.js";
import { streams } from "./streams.js";
import { createTask } from "./shared.js";
import { tracer } from "./tracer.js";
import {
  CHAT_STREAM_KEY as _CHAT_STREAM_KEY,
  CHAT_MESSAGES_STREAM_ID,
  CHAT_STOP_STREAM_ID,
} from "./chat-constants.js";

const METADATA_KEY = "tool.execute.options";

/**
 * Wrapper around `convertToModelMessages` that always passes
 * `ignoreIncompleteToolCalls: true` to prevent failures from
 * stopped/aborted conversations with partial tool parts.
 */
function toModelMessages(messages: UIMessage[]): Promise<ModelMessage[]> {
  return convertToModelMessages(messages, { ignoreIncompleteToolCalls: true });
}

export type ToolCallExecutionOptions = {
  toolCallId: string;
  experimental_context?: unknown;
  /** Chat context — only present when the tool runs inside a chat.task turn. */
  chatId?: string;
  turn?: number;
  continuation?: boolean;
  clientData?: unknown;
  /** Serialized chat.local values from the parent run. @internal */
  chatLocals?: Record<string, unknown>;
};

/** Chat context stored in locals during each chat.task turn for auto-detection. */
type ChatTurnContext<TClientData = unknown> = {
  chatId: string;
  turn: number;
  continuation: boolean;
  clientData?: TClientData;
};
const chatTurnContextKey = locals.create<ChatTurnContext>("chat.turnContext");

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
      // Build tool metadata — skip messages (can be large) and abortSignal (non-serializable)
      const toolMeta: ToolCallExecutionOptions = {
        toolCallId: options?.toolCallId ?? "",
      };
      if (options?.experimental_context !== undefined) {
        try {
          toolMeta.experimental_context = JSON.parse(JSON.stringify(options.experimental_context));
        } catch {
          // Non-serializable context — skip
        }
      }

      // Auto-detect chat context from the parent turn
      const chatCtx = locals.get(chatTurnContextKey);
      if (chatCtx) {
        toolMeta.chatId = chatCtx.chatId;
        toolMeta.turn = chatCtx.turn;
        toolMeta.continuation = chatCtx.continuation;
        toolMeta.clientData = chatCtx.clientData;
      }

      // Serialize initialized chat.local values for subtask hydration
      const chatLocals: Record<string, unknown> = {};
      for (const entry of chatLocalRegistry) {
        const value = locals.get(entry.key);
        if (value !== undefined) {
          chatLocals[entry.id] = value;
        }
      }
      if (Object.keys(chatLocals).length > 0) {
        toolMeta.chatLocals = chatLocals;
      }

      return await task
        .triggerAndWait(input as inferSchemaIn<TTaskSchema>, {
          metadata: {
            [METADATA_KEY]: toolMeta as any,
          },
          tags: options?.toolCallId ? [`toolCallId:${options.toolCallId}`] : undefined,
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

/**
 * Get the current tool call ID from inside a subtask invoked via `ai.tool()`.
 * Returns `undefined` if not running as a tool subtask.
 */
function getToolCallId(): string | undefined {
  return getToolOptionsFromMetadata()?.toolCallId;
}

/**
 * Get the chat context from inside a subtask invoked via `ai.tool()` within a `chat.task`.
 * Pass `typeof yourChatTask` as the type parameter to get typed `clientData`.
 * Returns `undefined` if the parent is not a chat task.
 *
 * @example
 * ```ts
 * const ctx = ai.chatContext<typeof myChat>();
 * // ctx?.clientData is typed based on myChat's clientDataSchema
 * ```
 */
function getToolChatContext<TChatTask extends AnyTask = AnyTask>(): ChatTurnContext<InferChatClientData<TChatTask>> | undefined {
  const opts = getToolOptionsFromMetadata();
  if (!opts?.chatId) return undefined;
  return {
    chatId: opts.chatId,
    turn: opts.turn ?? 0,
    continuation: opts.continuation ?? false,
    clientData: opts.clientData as InferChatClientData<TChatTask>,
  };
}

/**
 * Get the chat context from inside a subtask, throwing if not in a chat context.
 * Pass `typeof yourChatTask` as the type parameter to get typed `clientData`.
 *
 * @example
 * ```ts
 * const ctx = ai.chatContextOrThrow<typeof myChat>();
 * // ctx.chatId, ctx.clientData are guaranteed non-null
 * ```
 */
function getToolChatContextOrThrow<TChatTask extends AnyTask = AnyTask>(): ChatTurnContext<InferChatClientData<TChatTask>> {
  const ctx = getToolChatContext<TChatTask>();
  if (!ctx) {
    throw new Error(
      "ai.chatContextOrThrow() called outside of a chat.task context. " +
        "This helper can only be used inside a subtask invoked via ai.tool() from a chat.task."
    );
  }
  return ctx;
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
  /** Get the tool call ID from inside a subtask invoked via `ai.tool()`. */
  toolCallId: getToolCallId,
  /** Get chat context (chatId, turn, clientData, etc.) from inside a subtask of a `chat.task`. Returns undefined if not in a chat context. */
  chatContext: getToolChatContext,
  /** Get chat context or throw if not in a chat context. Pass `typeof yourChatTask` for typed clientData. */
  chatContextOrThrow: getToolChatContextOrThrow,
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

// ---------------------------------------------------------------------------
// ChatWriter — stream writer for callbacks
// ---------------------------------------------------------------------------

/**
 * A stream writer passed to chat lifecycle callbacks (`onPreload`, `onChatStart`,
 * `onTurnStart`, `onTurnComplete`, `onCompacted`).
 *
 * Write custom `UIMessageChunk` parts (e.g. `data-*` parts) directly to the chat
 * stream without the ceremony of `chat.stream.writer({ execute })`.
 *
 * The writer is lazy — no stream overhead if you don't call `write()` or `merge()`.
 *
 * @example
 * ```ts
 * onTurnStart: async ({ writer }) => {
 *   writer.write({ type: "data-status", data: { loading: true } });
 * },
 * onTurnComplete: async ({ writer, uiMessages }) => {
 *   writer.write({ type: "data-analytics", data: { messageCount: uiMessages.length } });
 * },
 * ```
 */
export type ChatWriter = {
  /** Write a single UIMessageChunk to the chat stream. */
  write(part: UIMessageChunk): void;
  /** Merge another stream's chunks into the chat stream. */
  merge(stream: ReadableStream<UIMessageChunk>): void;
};

/**
 * Creates a lazy ChatWriter that only opens a realtime stream on first use.
 * Call `flush()` after the callback returns to await stream completion.
 * @internal
 */
function createLazyChatWriter(): { writer: ChatWriter; flush: () => Promise<void> } {
  let writeImpl: ((part: UIMessageChunk) => void) | null = null;
  let mergeImpl: ((stream: ReadableStream<UIMessageChunk>) => void) | null = null;
  let waitPromise: (() => Promise<unknown>) | null = null;
  let resolveExecute: (() => void) | null = null;

  function ensureInitialized() {
    if (writeImpl) return;

    const executePromise = new Promise<void>((resolve) => {
      resolveExecute = resolve;
    });

    const { waitUntilComplete } = chatStream.writer({
      collapsed: true,
      spanName: "callback writer",
      execute: ({ write, merge }) => {
        writeImpl = write;
        mergeImpl = merge;
        return executePromise; // Keep execute alive until flush()
      },
    });
    waitPromise = waitUntilComplete;
  }

  return {
    writer: {
      write(part: UIMessageChunk) {
        ensureInitialized();
        writeImpl!(part);
      },
      merge(stream: ReadableStream<UIMessageChunk>) {
        ensureInitialized();
        mergeImpl!(stream);
      },
    },
    async flush() {
      if (resolveExecute) {
        resolveExecute(); // Signal execute to complete
        await waitPromise!(); // Wait for stream to finish piping
      }
    },
  };
}

/**
 * Runs a callback with a lazy ChatWriter, flushing the stream after completion.
 * @internal
 */
async function withChatWriter<T>(fn: (writer: ChatWriter) => Promise<T> | T): Promise<T> {
  const { writer, flush } = createLazyChatWriter();
  const result = await fn(writer);
  await flush();
  return result;
}

/**
 * The wire payload shape sent by `TriggerChatTransport`.
 * Uses `metadata` to match the AI SDK's `ChatRequestOptions` field name.
 */
export type ChatTaskWirePayload<TMessage extends UIMessage = UIMessage, TMetadata = unknown> = {
  messages: TMessage[];
  chatId: string;
  trigger: "submit-message" | "regenerate-message" | "preload";
  messageId?: string;
  metadata?: TMetadata;
  /** Whether this run is continuing an existing chat whose previous run ended. */
  continuation?: boolean;
  /** The run ID of the previous run (only set when `continuation` is true). */
  previousRunId?: string;
  /** Override idle timeout for this run (seconds). Set by transport.preload(). */
  idleTimeoutInSeconds?: number;
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
   * - `"preload"`: Run was preloaded before the first message (only on turn 0)
   */
  trigger: "submit-message" | "regenerate-message" | "preload";

  /** The ID of the message to regenerate (only for `"regenerate-message"`) */
  messageId?: string;

  /** Custom data from the frontend (passed via `metadata` on `sendMessage()` or the transport). */
  clientData?: TClientData;

  /** Whether this run is continuing an existing chat (previous run timed out or was cancelled). False for brand new chats. */
  continuation: boolean;
  /** The run ID of the previous run (only set when `continuation` is true). */
  previousRunId?: string;
  /** Whether this run was preloaded before the first message. */
  preloaded: boolean;
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
export type ChatTaskRunPayload<TClientData = unknown> = ChatTaskPayload<TClientData> & ChatTaskSignals & {
  /** Token usage from the previous turn. Undefined on turn 0. */
  previousTurnUsage?: LanguageModelUsage;
  /** Cumulative token usage across all completed turns so far. */
  totalUsage: LanguageModelUsage;
};

// Input streams for bidirectional chat communication
const messagesInput = streams.input<ChatTaskWirePayload>({ id: CHAT_MESSAGES_STREAM_ID });
const stopInput = streams.input<{ stop: true; message?: string }>({ id: CHAT_STOP_STREAM_ID });

/**
 * Per-turn deferred promises. Registered via `chat.defer()`, awaited
 * before `onTurnComplete` fires. Reset each turn.
 * @internal
 */
const chatDeferKey = locals.create<Set<Promise<unknown>>>("chat.defer");

/**
 * Run-scoped pipe counter. Stored in locals so concurrent runs in the
 * same worker don't share state.
 * @internal
 */
const chatPipeCountKey = locals.create<number>("chat.pipeCount");
const chatStopControllerKey = locals.create<AbortController>("chat.stopController");
/** Static (task-level) UIMessageStream options, set once during chatTask setup. @internal */
const chatUIStreamStaticKey = locals.create<ChatUIMessageStreamOptions>("chat.uiMessageStreamOptions.static");
/** Per-turn UIMessageStream options, set via chat.setUIMessageStreamOptions(). @internal */
const chatUIStreamPerTurnKey = locals.create<ChatUIMessageStreamOptions>("chat.uiMessageStreamOptions.perTurn");

// ---------------------------------------------------------------------------
// Token usage helpers (internal)
// ---------------------------------------------------------------------------

/** Convenience re-export of the AI SDK's `LanguageModelUsage` type. */
export type ChatTurnUsage = LanguageModelUsage;

function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  };
}

function addUsage(a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage {
  const add = (x: number | undefined, y: number | undefined) =>
    x != null || y != null ? (x ?? 0) + (y ?? 0) : undefined;
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    inputTokenDetails: {
      noCacheTokens: add(a.inputTokenDetails?.noCacheTokens, b.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: add(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: add(a.inputTokenDetails?.cacheWriteTokens, b.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokenDetails: {
      textTokens: add(a.outputTokenDetails?.textTokens, b.outputTokenDetails?.textTokens),
      reasoningTokens: add(a.outputTokenDetails?.reasoningTokens, b.outputTokenDetails?.reasoningTokens),
    },
  };
}

// ---------------------------------------------------------------------------
// chat.setMessages — replace accumulated messages for compaction
// ---------------------------------------------------------------------------

/** @internal */
const chatOverrideMessagesKey = locals.create<UIMessage[]>("chat.overrideMessages");

/**
 * Replace the accumulated conversation messages for the current run.
 *
 * Call from `onTurnStart` to compact before `run()` executes, or from
 * `onTurnComplete` to compact before the next turn. Takes `UIMessage[]`
 * and converts to `ModelMessage[]` internally.
 */
function setChatMessages(uiMessages: UIMessage[]): void {
  locals.set(chatOverrideMessagesKey, uiMessages);
}

/**
 * Model-only message override. Set by compaction to replace only the model
 * messages (what goes to the LLM) without affecting UI messages (what gets
 * persisted and displayed). This preserves full conversation history for the
 * user while keeping LLM context compact.
 * @internal
 */
const chatOverrideModelMessagesKey = locals.create<ModelMessage[]>("chat.overrideModelMessages");

// ---------------------------------------------------------------------------
// chat.compaction — prepareStep compaction API
// ---------------------------------------------------------------------------

/** State stored in locals during prepareStep compaction. */
interface CompactionState {
  summary: string;
  baseResponseMessageCount: number;
}

/** @internal */
const chatCompactionStateKey = locals.create<CompactionState>("chat.compaction");
const chatOnCompactedKey = locals.create<(event: CompactedEvent) => Promise<void> | void>("chat.onCompacted");
const chatPrepareMessagesKey = locals.create<(event: PrepareMessagesEvent<unknown>) => ModelMessage[] | Promise<ModelMessage[]>>("chat.prepareMessages");

/**
 * Event passed to `summarize` callbacks.
 */
export type SummarizeEvent = {
  /** The current model messages to summarize. */
  messages: ModelMessage[];
  /** Full usage object from the triggering step/turn. */
  usage?: LanguageModelUsage;
  /** Cumulative token usage across all completed turns. Present in chat.task contexts. */
  totalUsage?: LanguageModelUsage;
  /** The chat session ID (if running inside a chat.task). */
  chatId?: string;
  /** The current turn number (0-indexed, if inside a chat.task). */
  turn?: number;
  /** Custom data from the frontend (if inside a chat.task). */
  clientData?: unknown;
  /**
   * Where compaction is running:
   * - `"inner"` — between tool-call steps (prepareStep)
   * - `"outer"` — between turns
   */
  source?: "inner" | "outer";
  /** The step number (0-indexed). Only present when `source` is `"inner"`. */
  stepNumber?: number;
};

/**
 * Event passed to `compactUIMessages` and `compactModelMessages` callbacks.
 */
export type CompactMessagesEvent = {
  /** The generated summary text. */
  summary: string;
  /** The current UI messages (full conversation). */
  uiMessages: UIMessage[];
  /** The current model messages (full conversation). */
  modelMessages: ModelMessage[];
  /** The chat session ID. */
  chatId: string;
  /** The current turn number (0-indexed). */
  turn: number;
  /** Custom data from the frontend. */
  clientData?: unknown;
  /**
   * Where compaction is running:
   * - `"inner"` — between tool-call steps (prepareStep)
   * - `"outer"` — between turns
   */
  source: "inner" | "outer";
};

/**
 * Options for the `compaction` field on `chat.task()`.
 *
 * Handles compaction automatically in both the inner loop (prepareStep, between
 * tool-call steps) and the outer loop (between turns, for single-step responses
 * where prepareStep never fires).
 */
export type ChatTaskCompactionOptions = {
  /** Decide whether to compact. Return true to trigger compaction. */
  shouldCompact: (event: ShouldCompactEvent) => boolean | Promise<boolean>;
  /** Generate a summary from the current messages. Return the summary text. */
  summarize: (event: SummarizeEvent) => Promise<string>;
  /**
   * Transform UI messages after compaction (what gets persisted and displayed).
   * Default: preserve all UI messages unchanged.
   *
   * @example
   * ```ts
   * // Flatten to summary
   * compactUIMessages: ({ summary }) => [{
   *   id: generateId(), role: "assistant",
   *   parts: [{ type: "text", text: `[Summary]\n\n${summary}` }],
   * }],
   *
   * // Summary + keep last 4 messages
   * compactUIMessages: ({ uiMessages, summary }) => [
   *   { id: generateId(), role: "assistant",
   *     parts: [{ type: "text", text: `[Summary]\n\n${summary}` }] },
   *   ...uiMessages.slice(-4),
   * ],
   * ```
   */
  compactUIMessages?: (event: CompactMessagesEvent) => UIMessage[] | Promise<UIMessage[]>;
  /**
   * Transform model messages after compaction (what gets sent to the LLM).
   * Default: replace all with a single summary message.
   *
   * @example
   * ```ts
   * // Summary + keep last 2 model messages
   * compactModelMessages: ({ modelMessages, summary }) => [
   *   { role: "user", content: summary },
   *   ...modelMessages.slice(-2),
   * ],
   * ```
   */
  compactModelMessages?: (event: CompactMessagesEvent) => ModelMessage[] | Promise<ModelMessage[]>;
};

/** @internal */
const chatTaskCompactionKey = locals.create<ChatTaskCompactionOptions>("chat.taskCompaction");

// ---------------------------------------------------------------------------
// Pending messages — mid-execution message injection via prepareStep
// ---------------------------------------------------------------------------

/**
 * Event passed to `shouldInject` and `prepareMessages` callbacks.
 */
export type PendingMessagesBatchEvent = {
  /** All pending UI messages that arrived during streaming (batch). */
  messages: UIMessage[];
  /** Current model messages in the conversation. */
  modelMessages: ModelMessage[];
  /** Completed steps so far. */
  steps: CompactionStep[];
  /** Current step number (0-indexed). */
  stepNumber: number;
  /** Chat session ID. */
  chatId: string;
  /** Current turn number (0-indexed). */
  turn: number;
  /** Custom data from the frontend. */
  clientData?: unknown;
};

/**
 * Event passed to `onReceived` callback (per-message, as they arrive).
 */
export type PendingMessageReceivedEvent = {
  /** The UI message that arrived during streaming. */
  message: UIMessage;
  /** Chat session ID. */
  chatId: string;
  /** Current turn number (0-indexed). */
  turn: number;
};

/**
 * Event passed to `onInjected` callback (batch, after injection).
 */
export type PendingMessagesInjectedEvent = {
  /** All UI messages that were injected. */
  messages: UIMessage[];
  /** The model messages that were injected. */
  injectedModelMessages: ModelMessage[];
  /** Chat session ID. */
  chatId: string;
  /** Current turn number (0-indexed). */
  turn: number;
  /** Step number where injection occurred. */
  stepNumber: number;
};

/**
 * Options for the `pendingMessages` field on `chat.task()`, `chat.createSession()`,
 * or `ChatMessageAccumulator`.
 *
 * Configures how messages that arrive during streaming are handled. When
 * `shouldInject` is provided and returns `true`, the full batch of pending
 * messages is injected between tool-call steps via `prepareStep`.
 * Otherwise, messages queue for the next turn.
 */
export type PendingMessagesOptions = {
  /**
   * Decide whether to inject pending messages between tool-call steps.
   * Called once per step boundary with the full batch of pending messages.
   * If absent, no injection happens — messages only queue for the next turn.
   */
  shouldInject?: (event: PendingMessagesBatchEvent) => boolean | Promise<boolean>;
  /**
   * Transform the batch of pending messages before injection.
   * Return the model messages to inject.
   * Default: convert each UI message via `convertToModelMessages`.
   */
  prepare?: (event: PendingMessagesBatchEvent) => ModelMessage[] | Promise<ModelMessage[]>;
  /** Called when a message arrives during streaming (per-message). */
  onReceived?: (event: PendingMessageReceivedEvent) => void | Promise<void>;
  /** Called after a batch of messages is injected via `prepareStep`. */
  onInjected?: (event: PendingMessagesInjectedEvent) => void | Promise<void>;
};

/**
 * The data part type used to signal that pending messages were injected
 * between tool-call steps. The frontend can match on this to render
 * injection points inline in the assistant response.
 */
export const PENDING_MESSAGE_INJECTED_TYPE = "data-pending-message-injected" as const;

/** @internal */
type SteeringQueueEntry = { uiMessage: UIMessage; modelMessages: ModelMessage[] };
/** @internal */
const chatPendingMessagesKey = locals.create<PendingMessagesOptions>("chat.pendingMessages");
/** @internal */
const chatSteeringQueueKey = locals.create<SteeringQueueEntry[]>("chat.steeringQueue");
/** @internal — IDs of messages that were successfully injected via prepareStep */
const chatInjectedMessageIdsKey = locals.create<Set<string>>("chat.injectedMessageIds");

/**
 * Event passed to the `prepareMessages` hook.
 */
export type PrepareMessagesEvent<TClientData = unknown> = {
  /** The messages to transform. Return the transformed array. */
  messages: ModelMessage[];
  /** Why messages are being prepared. */
  reason:
    | "run"                // Messages being passed to run() for streamText
    | "compaction-rebuild" // Rebuilding from a previous compaction summary
    | "compaction-result"; // Fresh compaction just produced these messages
  /** The chat session ID. */
  chatId: string;
  /** The current turn number (0-indexed). */
  turn: number;
  /** Custom data from the frontend. */
  clientData?: TClientData;
};

/**
 * Data shape for `data-compaction` stream chunks emitted during compaction.
 * Use to type the `data` field when rendering compaction parts in the frontend.
 */
export type CompactionChunkData = {
  status: "compacting" | "complete";
  totalTokens: number | undefined;
};

/**
 * Event passed to the `onCompacted` callback.
 */
export type CompactedEvent = {
  /** The generated summary text. */
  summary: string;
  /** The messages that were compacted (pre-compaction). */
  messages: ModelMessage[];
  /** Number of messages before compaction. */
  messageCount: number;
  /** Token usage from the step that triggered compaction. */
  usage: LanguageModelUsage;
  /** Total token count that triggered compaction. */
  totalTokens: number | undefined;
  /** Input token count from the triggering step. */
  inputTokens: number | undefined;
  /** Output token count from the triggering step. */
  outputTokens: number | undefined;
  /** The step number where compaction occurred (0-indexed). */
  stepNumber: number;
  /** The chat session ID (if running inside a chat.task). */
  chatId?: string;
  /** The current turn number (if running inside a chat.task). */
  turn?: number;
  /** Stream writer — write custom `UIMessageChunk` parts to the chat stream. Lazy: no overhead if unused. */
  writer: ChatWriter;
};

/**
 * Event passed to `shouldCompact` callbacks.
 */
export type ShouldCompactEvent = {
  /** The current model messages (full conversation). */
  messages: ModelMessage[];
  /** Total token count from the triggering step/turn. */
  totalTokens: number | undefined;
  /** Input token count from the triggering step/turn. */
  inputTokens: number | undefined;
  /** Output token count from the triggering step/turn. */
  outputTokens: number | undefined;
  /** Full usage object from the triggering step/turn. */
  usage?: LanguageModelUsage;
  /** Cumulative token usage across all completed turns. Present in chat.task contexts. */
  totalUsage?: LanguageModelUsage;
  /** The chat session ID (if running inside a chat.task). */
  chatId?: string;
  /** The current turn number (0-indexed, if inside a chat.task). */
  turn?: number;
  /** Custom data from the frontend (if inside a chat.task). */
  clientData?: unknown;
  /**
   * Where this check is running:
   * - `"inner"` — between tool-call steps (prepareStep)
   * - `"outer"` — between turns (after response, before onBeforeTurnComplete)
   */
  source?: "inner" | "outer";
  /** The step number (0-indexed). Only present when `source` is `"inner"`. */
  stepNumber?: number;
  /** The steps array from prepareStep. Only present when `source` is `"inner"`. */
  steps?: CompactionStep[];
};

/**
 * Options for `chat.compaction()` — the high-level prepareStep factory.
 */
export type CompactionOptions = {
  /** Generate a summary from the current messages. Return the summary text. */
  summarize: (messages: ModelMessage[]) => Promise<string>;
  /** Token threshold — compact when totalTokens exceeds this. Ignored if `shouldCompact` is provided. */
  threshold?: number;
  /** Custom compaction trigger. When provided, used instead of `threshold`. */
  shouldCompact?: (event: ShouldCompactEvent) => boolean | Promise<boolean>;
};

/** A step object as received in prepareStep's `steps` array. */
export type CompactionStep = {
  usage: LanguageModelUsage;
  finishReason: string;
  content: Array<{ type: string; toolCallId?: string }>;
  response: { messages: Array<any> };
};

/**
 * Result of `chat.compact()`. Discriminated union so you can inspect
 * what happened, but also directly compatible with prepareStep's return type.
 *
 * - `"skipped"` — no compaction needed (first step, boundary unsafe, or under threshold). Return `undefined` to prepareStep.
 * - `"rebuilt"` — previous compaction exists, messages rebuilt from summary + new response messages.
 * - `"compacted"` — compaction just happened, includes the generated summary.
 */
export type CompactResult =
  | { type: "skipped" }
  | { type: "rebuilt"; messages: ModelMessage[] }
  | { type: "compacted"; messages: ModelMessage[]; summary: string };

/**
 * Options for `chat.compact()` — the low-level compaction function.
 */
export type CompactOptions = {
  /** Generate a summary from the current messages. Return the summary text. */
  summarize: (messages: ModelMessage[]) => Promise<string>;
  /** Token threshold — compact when totalTokens exceeds this. Ignored if `shouldCompact` is provided. */
  threshold?: number;
  /** Custom compaction trigger. When provided, used instead of `threshold`. */
  shouldCompact?: (event: ShouldCompactEvent) => boolean | Promise<boolean>;
};

/**
 * Check that no tool calls are in-flight in a step's content.
 * Used before compaction to avoid losing tool state mid-execution.
 * @internal
 */
function isStepBoundarySafe(step: {
  finishReason: string;
  content: Array<{ type: string; toolCallId?: string }>;
}): boolean {
  if (step.finishReason === "error") return false;
  const callIds = new Set(
    step.content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId)
  );
  const settledIds = new Set(
    step.content
      .filter((p) => p.type === "tool-result" || p.type === "tool-error")
      .map((p) => p.toolCallId)
  );
  return ![...callIds].some((id) => !settledIds.has(id));
}

/**
 * Apply the prepareMessages hook if one is set in locals.
 * @internal
 */
async function applyPrepareMessages(messages: ModelMessage[], reason: PrepareMessagesEvent["reason"]): Promise<ModelMessage[]> {
  const hook = locals.get(chatPrepareMessagesKey);
  if (!hook) return messages;

  const turnCtx = locals.get(chatTurnContextKey);

  return tracer.startActiveSpan(
    "prepareMessages()",
    async () => {
      return hook({
        messages,
        reason,
        chatId: turnCtx?.chatId ?? "",
        turn: turnCtx?.turn ?? 0,
        clientData: turnCtx?.clientData,
      });
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "task-hook-onStart",
        [SemanticInternalAttributes.COLLAPSED]: true,
        "chat.prepareMessages.reason": reason,
        "chat.prepareMessages.messageCount": messages.length,
      },
    }
  );
}

/**
 * Read the current compaction state. Returns the summary and base message count
 * if compaction has occurred in this turn, or `undefined` if not.
 *
 * Use in a custom `prepareStep` to rebuild from a previous compaction:
 * ```ts
 * const state = chat.getCompactionState();
 * if (state) {
 *   return { messages: [{ role: "user", content: state.summary }, ...newMsgs] };
 * }
 * ```
 */
function getCompactionState(): CompactionState | undefined {
  return locals.get(chatCompactionStateKey);
}

/**
 * Low-level compaction for use inside a custom `prepareStep`.
 *
 * Handles the full decision tree: first step, already-compacted rebuild,
 * boundary safety, threshold check, summarization, stream chunks, state
 * storage, and accumulator update.
 *
 * Returns a `CompactResult` — inspect `result.type` to see what happened,
 * or convert to a prepareStep return with `result.type === "skipped" ? undefined : result`.
 *
 * @example
 * ```ts
 * prepareStep: async ({ messages, steps }) => {
 *   // your custom logic here...
 *   const result = await chat.compact(messages, steps, {
 *     threshold: 80_000,
 *     summarize: async (msgs) => generateText({ model, messages: msgs }).then(r => r.text),
 *   });
 *   if (result.type === "compacted") {
 *     logger.info("Compacted!", { summary: result.summary });
 *   }
 *   return result.type === "skipped" ? undefined : result;
 * },
 * ```
 */
async function chatCompact(
  messages: ModelMessage[],
  steps: CompactionStep[],
  options: CompactOptions
): Promise<CompactResult> {
  const currentStep = steps.at(-1);

  // First step — nothing to check
  if (!currentStep) {
    return { type: "skipped" };
  }

  // Already compacted — rebuild from summary + new response messages
  const state = locals.get(chatCompactionStateKey);
  if (state && isStepBoundarySafe(currentStep)) {
    return {
      type: "rebuilt",
      messages: await applyPrepareMessages([
        { role: "user" as const, content: state.summary },
        ...currentStep.response.messages.slice(state.baseResponseMessageCount),
      ], "compaction-rebuild"),
    };
  }

  // Boundary unsafe — skip
  if (!isStepBoundarySafe(currentStep)) {
    return { type: "skipped" };
  }

  const totalTokens = currentStep.usage.totalTokens;
  const inputTokens = currentStep.usage.inputTokens;
  const outputTokens = currentStep.usage.outputTokens;

  const turnCtx = locals.get(chatTurnContextKey);
  const stepNumber = steps.length - 1;

  const shouldTrigger = options.shouldCompact
    ? await options.shouldCompact({
        messages,
        totalTokens,
        inputTokens,
        outputTokens,
        usage: currentStep.usage,
        source: "inner",
        stepNumber,
        steps,
        chatId: turnCtx?.chatId,
        turn: turnCtx?.turn,
        clientData: turnCtx?.clientData,
      })
    : (totalTokens != null && options.threshold != null && totalTokens > options.threshold);

  if (!shouldTrigger) {
    return { type: "skipped" };
  }

  const result = await tracer.startActiveSpan(
    "context compaction",
    async (span) => {
      const compactionId = generateMessageId();
      let summary!: string;

      const { waitUntilComplete } = streams.writer(CHAT_STREAM_KEY, {
        spanName: "stream compaction chunks",
        collapsed: true,
        execute: async ({ write, merge }) => {
          write({ type: "step-start" });
          write({
            type: "data-compaction",
            id: compactionId,
            data: { status: "compacting", totalTokens },
          });

          // Generate summary
          summary = await options.summarize(messages);

          // Store state in locals for subsequent steps
          locals.set(chatCompactionStateKey, {
            summary,
            baseResponseMessageCount: currentStep.response.messages.length,
          });

          // Set model-only override — UI messages stay intact for persistence.
          // The summary becomes the model message history for the next turn,
          // while accumulatedUIMessages keeps the full conversation for display.
          locals.set(chatOverrideModelMessagesKey, [
            { role: "assistant" as const, content: [{ type: "text" as const, text: `[Conversation summary]\n\n${summary}` }] },
          ]);

          // Fire onCompacted hook — pass the existing writer so the callback
          // can write custom chunks without creating a separate stream.
          const onCompactedHook = locals.get(chatOnCompactedKey);
          if (onCompactedHook) {
            await onCompactedHook({
              summary,
              messages,
              messageCount: messages.length,
              usage: currentStep.usage,
              totalTokens,
              inputTokens,
              outputTokens,
              stepNumber,
              chatId: turnCtx?.chatId,
              turn: turnCtx?.turn,
              writer: { write, merge },
            });
          }

          write({
            type: "data-compaction",
            id: compactionId,
            data: { status: "complete", totalTokens },
          });
          write({ type: "finish-step" });
        },
      });
      await waitUntilComplete();

      // Set attributes after we have the summary
      span.setAttribute("compaction.summary_length", summary.length);

      return {
        type: "compacted" as const,
        messages: await applyPrepareMessages(
          [{ role: "user" as const, content: summary }],
          "compaction-result"
        ),
        summary,
      };
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "tabler-scissors",
        "compaction.threshold": options.threshold,
        "compaction.total_tokens": totalTokens ?? 0,
        "compaction.input_tokens": inputTokens ?? 0,
        "compaction.message_count": messages.length,
        "compaction.step_number": stepNumber,
        ...(turnCtx?.chatId ? { "compaction.chat_id": turnCtx.chatId } : {}),
        ...(turnCtx?.turn != null ? { "compaction.turn": turnCtx.turn } : {}),
        ...accessoryAttributes({
          items: [
            { text: `${totalTokens ?? 0} tokens`, variant: "normal" },
            { text: `${messages.length} msgs`, variant: "normal" },
          ],
          style: "codepath",
        }),
      },
    }
  );

  return result;
}

/**
 * Returns a `prepareStep` function that handles context compaction automatically.
 *
 * Monitors token usage between tool-call steps. When `totalTokens` exceeds
 * the threshold, generates a summary via `summarize()`, replaces the message
 * history, and emits `data-compaction` stream chunks for the frontend.
 *
 * @example
 * ```ts
 * return streamText({
 *   ...chat.toStreamTextOptions({ registry }),
 *   messages: chat.addCacheBreaks(messages),
 *   prepareStep: chat.compactionStep({
 *     threshold: 80_000,
 *     summarize: async (messages) => {
 *       return generateText({ model, messages: [...messages, { role: "user", content: "Summarize." }] })
 *         .then((r) => r.text);
 *     },
 *   }),
 *   tools: { ... },
 * });
 * ```
 */
function chatCompactionStep(options: CompactionOptions): (args: { messages: ModelMessage[]; steps: CompactionStep[] }) => Promise<{ messages: ModelMessage[] } | undefined> {
  return async ({ messages, steps }) => {
    const result = await chatCompact(messages, steps, options);
    return result.type === "skipped" ? undefined : result;
  };
}

// ---------------------------------------------------------------------------
// Steering queue drain — shared by toStreamTextOptions, session, accumulator
// ---------------------------------------------------------------------------

/**
 * Drain the steering queue as a batch. Calls `shouldInject` once with all
 * pending messages. If it returns true, calls `prepareMessages` once to
 * transform the batch, then clears the queue.
 * Returns the model messages to inject (empty if none).
 * @internal
 */
async function drainSteeringQueue(
  config: PendingMessagesOptions,
  messages: ModelMessage[],
  steps: CompactionStep[],
  queueOverride?: SteeringQueueEntry[],
): Promise<ModelMessage[]> {
  const queue = queueOverride ?? locals.get(chatSteeringQueueKey);
  if (!queue || queue.length === 0) return [];

  const ctx = locals.get(chatTurnContextKey);
  const stepNumber = steps.length - 1;
  const uiMessages = queue.map((e) => e.uiMessage);

  const batchEvent: PendingMessagesBatchEvent = {
    messages: uiMessages,
    modelMessages: messages,
    steps,
    stepNumber,
    chatId: ctx?.chatId ?? "",
    turn: ctx?.turn ?? 0,
    clientData: ctx?.clientData,
  };

  // Call shouldInject once for the whole batch
  const shouldInject = config.shouldInject
    ? await config.shouldInject(batchEvent)
    : false;

  if (!shouldInject) return [];

  // Extract message texts for span attributes
  const messageTexts = uiMessages.map((m) =>
    (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("") || ""
  );
  const previewText = messageTexts.length === 1
    ? messageTexts[0]!.slice(0, 80)
    : `${queue.length} messages`;

  return tracer.startActiveSpan(
    "pending message injected",
    async () => {
      // Transform the batch — default: concatenate all pre-converted model messages
      const injected = config.prepare
        ? await config.prepare(batchEvent)
        : queue.flatMap((e) => e.modelMessages);

      // Clear the queue and record injected IDs
      queue.length = 0;
      const injectedIds = locals.get(chatInjectedMessageIdsKey);
      if (injectedIds) {
        for (const m of uiMessages) injectedIds.add(m.id);
      }

      // Write injection confirmation chunk to the stream so the frontend
      // knows which messages were injected and where in the response.
      if (injected.length > 0) {
        try {
          const { waitUntilComplete } = streams.writer(CHAT_STREAM_KEY, {
            collapsed: true,
            execute: ({ write }) => {
              write({
                type: PENDING_MESSAGE_INJECTED_TYPE,
                id: generateMessageId(),
                data: {
                  messageIds: uiMessages.map((m) => m.id),
                  messages: uiMessages.map((m, idx) => ({
                    id: m.id,
                    text: messageTexts[idx] ?? "",
                  })),
                },
              });
            },
          });
          await waitUntilComplete();
        } catch { /* non-fatal — stream write failed */ }
      }

      // Fire onInjected callback
      if (config.onInjected && injected.length > 0) {
        try {
          await config.onInjected({
            messages: uiMessages,
            injectedModelMessages: injected,
            chatId: ctx?.chatId ?? "",
            turn: ctx?.turn ?? 0,
            stepNumber,
          });
        } catch { /* non-fatal */ }
      }

      return injected;
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "tabler-message-forward",
        "pending.message_count": uiMessages.length,
        "pending.step_number": stepNumber,
        "pending.messages": messageTexts,
        ...(ctx?.chatId ? { "pending.chat_id": ctx.chatId } : {}),
        ...(ctx?.turn != null ? { "pending.turn": ctx.turn } : {}),
        ...accessoryAttributes({
          items: [
            { text: `${uiMessages.length} message${uiMessages.length === 1 ? "" : "s"}`, variant: "normal" },
            { text: `between steps ${stepNumber} and ${stepNumber + 1}`, variant: "normal" },
          ],
          style: "codepath",
        }),
      },
    }
  );
}

// ---------------------------------------------------------------------------
// chat.isCompactionSafe — check if it's safe to compact messages
// ---------------------------------------------------------------------------

/**
 * Checks whether it's safe to compact the message history. Returns `false`
 * if any tool calls are in-flight (incomplete tool invocations without results).
 *
 * Call before `chat.setMessages()` to avoid corrupting tool-call state.
 */
function isCompactionSafe(messages: UIMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts as any[]) {
      if (part.type === "tool-invocation") {
        const state = part.toolInvocation?.state ?? part.state;
        if (state !== "result" && state !== "error") {
          return false;
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// chat.prompt — store and retrieve a resolved prompt for the current run
// ---------------------------------------------------------------------------

/**
 * A resolved prompt stored via `chat.prompt.set()`. Either a full `ResolvedPrompt`
 * from `prompts.define().resolve()`, or a lightweight wrapper around a plain string.
 */
export type ChatPromptValue = ResolvedPrompt | {
  text: string;
  model: undefined;
  config: undefined;
  promptId: string;
  version: number;
  labels: string[];
  toAISDKTelemetry: (additionalMetadata?: Record<string, string>) => {
    experimental_telemetry: { isEnabled: true; metadata: Record<string, string> };
  };
};

/** @internal */
const chatPromptKey = locals.create<ChatPromptValue>("chat.prompt");

/**
 * Store a resolved prompt (or plain string) for the current run.
 * Call from any hook (`onPreload`, `onChatStart`, `onTurnStart`) or `run()`.
 */
function setChatPrompt(resolved: ResolvedPrompt | string): void {
  if (typeof resolved === "string") {
    locals.set(chatPromptKey, {
      text: resolved,
      model: undefined,
      config: undefined,
      promptId: "",
      version: 0,
      labels: [],
      toAISDKTelemetry: () => ({
        experimental_telemetry: { isEnabled: true, metadata: {} },
      }),
    });
  } else {
    locals.set(chatPromptKey, resolved);
  }
}

/**
 * Read the stored prompt. Throws if `chat.prompt.set()` has not been called.
 */
function getChatPrompt(): ChatPromptValue {
  const prompt = locals.get(chatPromptKey);
  if (!prompt) {
    throw new Error(
      "chat.prompt() called before chat.prompt.set(). Set a prompt in onPreload, onChatStart, onTurnStart, or run() first."
    );
  }
  return prompt;
}

/**
 * Options for {@link toStreamTextOptions}.
 */
export type ToStreamTextOptionsOptions = {
  /** Additional telemetry metadata merged into `experimental_telemetry.metadata`. */
  telemetry?: Record<string, string>;
  /**
   * An AI SDK provider registry (from `createProviderRegistry`) or any object
   * with a `languageModel(id)` method. When provided and the stored prompt has
   * a `model` string, the resolved `LanguageModel` is included in the returned
   * options so `streamText` uses it directly.
   *
   * The model string should use the `"provider:model-id"` format
   * (e.g. `"openai:gpt-4o"`, `"anthropic:claude-sonnet-4-6"`).
   */
  registry?: { languageModel(modelId: string): unknown };
};

/**
 * Returns an options object ready to spread into `streamText()`.
 *
 * Includes `system`, `experimental_telemetry`, and any config fields
 * (temperature, maxTokens, etc.) from the stored prompt.
 *
 * When a `registry` is provided and the prompt has a `model` string,
 * the resolved `LanguageModel` is included as `model`.
 *
 * If no prompt has been set, returns `{}` (no-op spread).
 */
function toStreamTextOptions(options?: ToStreamTextOptionsOptions): Record<string, unknown> {
  const prompt = locals.get(chatPromptKey);
  if (!prompt) return {};

  const result: Record<string, unknown> = {
    system: prompt.text,
  };

  // Resolve model via registry if both are present
  if (options?.registry && prompt.model) {
    result.model = options.registry.languageModel(prompt.model);
  }

  // Spread config (temperature, maxTokens, etc.)
  if (prompt.config) {
    Object.assign(result, prompt.config);
  }

  // Add telemetry (forward additional metadata from caller)
  const telemetry = prompt.toAISDKTelemetry(options?.telemetry);
  Object.assign(result, telemetry);

  // Auto-inject prepareStep when compaction or pendingMessages is configured.
  const taskCompaction = locals.get(chatTaskCompactionKey);
  const taskPendingMessages = locals.get(chatPendingMessagesKey);

  if (taskCompaction || taskPendingMessages) {
    result.prepareStep = async ({ messages, steps }: { messages: ModelMessage[]; steps: CompactionStep[] }) => {
      let resultMessages: ModelMessage[] | undefined;

      // 1. Compaction
      if (taskCompaction) {
        const compactResult = await chatCompact(messages, steps, {
          shouldCompact: taskCompaction.shouldCompact,
          summarize: (msgs) => {
            const ctx = locals.get(chatTurnContextKey);
            const lastStep = steps.at(-1);
            return taskCompaction.summarize({
              messages: msgs,
              usage: lastStep?.usage,
              source: "inner",
              stepNumber: steps.length - 1,
              chatId: ctx?.chatId,
              turn: ctx?.turn,
              clientData: ctx?.clientData,
            });
          },
        });
        if (compactResult.type !== "skipped") {
          resultMessages = compactResult.messages;
        }
      }

      // 2. Pending message injection (steering)
      if (taskPendingMessages) {
        const injected = await drainSteeringQueue(
          taskPendingMessages,
          resultMessages ?? messages,
          steps,
        );
        if (injected.length > 0) {
          resultMessages = [...(resultMessages ?? messages), ...injected];
        }
      }

      return resultMessages ? { messages: resultMessages } : undefined;
    };
  }

  return result;
}

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
 * Options for customizing the `toUIMessageStream()` call used when piping
 * `streamText` results to the frontend.
 *
 * Set static defaults via `uiMessageStreamOptions` on `chat.task()`, or
 * override per-turn via `chat.setUIMessageStreamOptions()`.
 *
 * `onFinish`, `originalMessages`, and `generateMessageId` are omitted because
 * they are managed internally for response capture and message accumulation.
 * Use `streamText`'s `onFinish` for custom finish handling, or drop down to
 * raw task mode with `chat.pipe()` for full control.
 */
export type ChatUIMessageStreamOptions = Omit<
  UIMessageStreamOptions<UIMessage>,
  "onFinish" | "originalMessages" | "generateMessageId"
>;

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
 * Event passed to the `onPreload` callback.
 */
export type PreloadEvent<TClientData = unknown> = {
  /** The unique identifier for the chat session. */
  chatId: string;
  /** The Trigger.dev run ID for this conversation. */
  runId: string;
  /** A scoped access token for this chat run. */
  chatAccessToken: string;
  /** Custom data from the frontend. */
  clientData?: TClientData;
  /** Stream writer — write custom `UIMessageChunk` parts to the chat stream. Lazy: no overhead if unused. */
  writer: ChatWriter;
};

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
  /** Whether this run was preloaded before the first message. */
  preloaded: boolean;
  /** Stream writer — write custom `UIMessageChunk` parts to the chat stream. Lazy: no overhead if unused. */
  writer: ChatWriter;
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
  /** Whether this run was preloaded before the first message. */
  preloaded: boolean;
  /** Token usage from the previous turn. Undefined on turn 0. */
  previousTurnUsage?: LanguageModelUsage;
  /** Cumulative token usage across all completed turns so far. */
  totalUsage: LanguageModelUsage;
  /** Stream writer — write custom `UIMessageChunk` parts to the chat stream. Lazy: no overhead if unused. */
  writer: ChatWriter;
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
  /** Whether this run was preloaded before the first message. */
  preloaded: boolean;
  /** Token usage for this turn. Undefined if usage couldn't be captured (e.g. manual pipeChat). */
  usage?: LanguageModelUsage;
  /** Cumulative token usage across all turns in this run (including this turn). */
  totalUsage: LanguageModelUsage;
};

/**
 * Event passed to the `onBeforeTurnComplete` callback.
 * Same as `TurnCompleteEvent` but includes a `writer` since the stream is still open.
 */
export type BeforeTurnCompleteEvent<TClientData = unknown> = TurnCompleteEvent<TClientData> & {
  /** Stream writer — write custom `UIMessageChunk` parts to the chat stream. Lazy: no overhead if unused. */
  writer: ChatWriter;
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
   * Called when a preloaded run starts, before the first message arrives.
   *
   * Use this to initialize state, create DB records, and load context early —
   * so everything is ready when the user's first message comes through.
   *
   * @example
   * ```ts
   * onPreload: async ({ chatId, clientData }) => {
   *   await db.chat.create({ data: { id: chatId } });
   *   userContext.init(await loadUser(clientData.userId));
   * }
   * ```
   */
  onPreload?: (event: PreloadEvent<inferSchemaOut<TClientDataSchema>>) => Promise<void> | void;

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
   * Called after the response is captured but before the stream closes.
   * The stream is still open, so you can write custom chunks to the frontend
   * (e.g. compaction progress). Use this for compaction, post-processing,
   * or any work where the user should see real-time status updates.
   *
   * @example
   * ```ts
   * onBeforeTurnComplete: async ({ writer, usage }) => {
   *   if (usage?.inputTokens && usage.inputTokens > 5000) {
   *     writer.write({ type: "data-compaction", id: generateId(), data: { status: "compacting" } });
   *     // ... compact messages ...
   *     chat.setMessages(compactedMessages);
   *     writer.write({ type: "data-compaction", id: generateId(), data: { status: "complete" } });
   *   }
   * }
   * ```
   */
  onBeforeTurnComplete?: (event: BeforeTurnCompleteEvent<inferSchemaOut<TClientDataSchema>>) => Promise<void> | void;

  /**
   * Called when conversation compaction occurs (via `chat.compact()` or
   * `chat.compactionStep()`). Use for logging, billing, or persisting the summary.
   *
   * @example
   * ```ts
   * onCompacted: async ({ summary, totalTokens, chatId }) => {
   *   logger.info("Compacted", { totalTokens, chatId });
   *   await db.compactionLog.create({ data: { chatId, summary } });
   * }
   * ```
   */
  onCompacted?: (event: CompactedEvent) => Promise<void> | void;

  /**
   * Automatic context compaction. When provided, compaction runs automatically
   * in both the inner loop (prepareStep, between tool-call steps) and the
   * outer loop (between turns, for single-step responses where prepareStep
   * never fires).
   *
   * The `shouldCompact` callback decides when to compact, and `summarize`
   * generates the summary. The prepareStep is auto-injected into
   * `chat.toStreamTextOptions()` — if you provide your own `prepareStep`
   * after spreading, it overrides the auto-injected one.
   *
   * @example
   * ```ts
   * chat.task({
   *   id: "my-chat",
   *   compaction: {
   *     shouldCompact: ({ totalTokens }) => (totalTokens ?? 0) > 80_000,
   *     summarize: async (messages) =>
   *       generateText({ model, messages: [...messages, { role: "user", content: "Summarize." }] })
   *         .then((r) => r.text),
   *   },
   *   run: async ({ messages, signal }) => {
   *     return streamText({ ...chat.toStreamTextOptions({ registry }), messages });
   *   },
   * });
   * ```
   */
  compaction?: ChatTaskCompactionOptions;

  /**
   * Configure how messages that arrive during streaming are handled.
   *
   * By default, messages queue for the next turn. When `shouldInject` is provided
   * and returns `true`, messages are injected between tool-call steps via
   * `prepareStep` — allowing users to steer the agent mid-execution.
   *
   * @example
   * ```ts
   * pendingMessages: {
   *   shouldInject: ({ steps }) => steps.length > 0,
   *   onReceived: ({ message }) => logger.info("Steering message received"),
   * },
   * ```
   */
  pendingMessages?: PendingMessagesOptions;

  /**
   * conversation to your database after each assistant response.
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
   * How long (in seconds) the run stays idle (active, using compute) after each
   * turn, waiting for the next message. During this window responses are instant.
   * After this timeout the run suspends (frees compute) and waits via
   * `inputStream.wait()`.
   *
   * Set to `0` to suspend immediately after each turn.
   *
   * @default 30
   */
  idleTimeoutInSeconds?: number;

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

  /**
   * How long (in seconds) the run stays idle after `onPreload` fires,
   * waiting for the first message before suspending.
   *
   * Only applies to preloaded runs (triggered via `transport.preload()`).
   *
   * @default Same as `idleTimeoutInSeconds`
   */
  preloadIdleTimeoutInSeconds?: number;

  /**
   * How long to wait (suspended) for the first message after a preloaded run starts.
   * If no message arrives within this time, the run ends.
   *
   * Only applies to preloaded runs.
   *
   * @default Same as `turnTimeout`
   */
  preloadTimeout?: string;

  /**
   * Transform model messages before they're used anywhere — in `run()`,
   * in compaction rebuilds, and in compaction results.
   *
   * Define once, applied everywhere. Use for Anthropic cache breaks,
   * injecting system context, stripping PII, etc.
   *
   * @example
   * ```ts
   * prepareMessages: async ({ messages, reason }) => {
   *   // Add Anthropic cache breaks to the last message
   *   if (messages.length === 0) return messages;
   *   const last = messages[messages.length - 1];
   *   return [...messages.slice(0, -1), {
   *     ...last,
   *     providerOptions: { ...last.providerOptions, anthropic: { cacheControl: { type: "ephemeral" } } },
   *   }];
   * }
   * ```
   */
  prepareMessages?: (event: PrepareMessagesEvent<inferSchemaOut<TClientDataSchema>>) => ModelMessage[] | Promise<ModelMessage[]>;

  /**
   * Default options for `toUIMessageStream()` when auto-piping or using
   * `turn.complete()` / `chat.pipeAndCapture()`.
   *
   * Controls how the `StreamTextResult` is converted to a `UIMessageChunk`
   * stream — error handling, reasoning/source visibility, metadata, etc.
   *
   * Can be overridden per-turn by calling `chat.setUIMessageStreamOptions()`
   * inside `run()` or lifecycle hooks. Per-turn values are merged on top
   * of these defaults (per-turn wins on conflicts).
   *
   * `onFinish`, `originalMessages`, and `generateMessageId` are managed
   * internally and cannot be overridden here. Use `streamText`'s `onFinish`
   * for custom finish handling, or drop to raw task mode for full control.
   *
   * @example
   * ```ts
   * chat.task({
   *   id: "my-chat",
   *   uiMessageStreamOptions: {
   *     sendReasoning: true,
   *     onError: (error) => error instanceof Error ? error.message : "An error occurred.",
   *   },
   *   run: async ({ messages, signal }) => { ... },
   * });
   * ```
   */
  uiMessageStreamOptions?: ChatUIMessageStreamOptions;
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
    onPreload,
    onChatStart,
    onTurnStart,
    onBeforeTurnComplete,
    onCompacted,
    compaction,
    pendingMessages: pendingMessagesConfig,
    prepareMessages,
    onTurnComplete,
    maxTurns = 100,
    turnTimeout = "1h",
    idleTimeoutInSeconds = 30,
    chatAccessTokenTTL = "1h",
    preloadIdleTimeoutInSeconds,
    preloadTimeout,
    uiMessageStreamOptions,
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

      // Store static UIMessageStream options in locals so resolveUIMessageStreamOptions() can read them
      if (uiMessageStreamOptions) {
        locals.set(chatUIStreamStaticKey, uiMessageStreamOptions);
      }

      // Store onCompacted hook in locals so chat.compact() can call it
      if (onCompacted) {
        locals.set(chatOnCompactedKey, onCompacted);
      }

      if (prepareMessages) {
        locals.set(chatPrepareMessagesKey, prepareMessages);
      }

      if (compaction) {
        locals.set(chatTaskCompactionKey, compaction);
      }

      if (pendingMessagesConfig) {
        locals.set(chatPendingMessagesKey, pendingMessagesConfig);
      }

      let currentWirePayload = payload;
      const continuation = payload.continuation ?? false;
      const previousRunId = payload.previousRunId;
      const preloaded = payload.trigger === "preload";

      // Accumulated model messages across turns. Turn 1 initialises from the
      // full history the frontend sends; subsequent turns append only the new
      // user message(s) and the captured assistant response.
      let accumulatedMessages: ModelMessage[] = [];

      // Accumulated UI messages for persistence. Mirrors the model accumulator
      // but in frontend-friendly UIMessage format (with parts, id, etc.).
      let accumulatedUIMessages: UIMessage[] = [];

      // Token usage tracking across turns
      let previousTurnUsage: LanguageModelUsage | undefined;
      let cumulativeUsage: LanguageModelUsage = emptyUsage();

      // Mutable reference to the current turn's stop controller so the
      // stop input stream listener (registered once) can abort the right turn.
      let currentStopController: AbortController | undefined;

      // Listen for stop signals for the lifetime of the run
      const stopSub = stopInput.on((data) => {
        currentStopController?.abort(data?.message || "stopped");
      });

      try {
        // Handle preloaded runs — fire onPreload, then wait for the first real message
        if (preloaded) {
          if (activeSpan) {
            activeSpan.setAttribute("chat.preloaded", true);
          }

          const currentRunId = taskContext.ctx?.run.id ?? "";
          let preloadAccessToken = "";
          if (currentRunId) {
            try {
              preloadAccessToken = await auth.createPublicToken({
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

          // Parse client data for the preload hook
          const preloadClientData = (parseClientData
            ? await parseClientData(payload.metadata)
            : payload.metadata) as inferSchemaOut<TClientDataSchema>;

          // Fire onPreload hook
          if (onPreload) {
            await tracer.startActiveSpan(
              "onPreload()",
              async () => {
                await withChatWriter(async (writer) => {
                  await onPreload({
                    chatId: payload.chatId,
                    runId: currentRunId,
                    chatAccessToken: preloadAccessToken,
                    clientData: preloadClientData,
                    writer,
                  });
                });
              },
              {
                attributes: {
                  [SemanticInternalAttributes.STYLE_ICON]: "task-hook-onStart",
                  [SemanticInternalAttributes.COLLAPSED]: true,
                  "chat.id": payload.chatId,
                  "chat.preloaded": true,
                },
              }
            );
          }

          // Wait for the first real message — use preload-specific timeouts if configured
          const effectivePreloadIdleTimeout =
            payload.idleTimeoutInSeconds
            ?? preloadIdleTimeoutInSeconds
            ?? idleTimeoutInSeconds;

          const effectivePreloadTimeout =
            (metadata.get(TURN_TIMEOUT_METADATA_KEY) as string | undefined)
            ?? preloadTimeout
            ?? turnTimeout;

          const preloadResult = await messagesInput.waitWithIdleTimeout({
            idleTimeoutInSeconds: effectivePreloadIdleTimeout,
            timeout: effectivePreloadTimeout,
            spanName: "waiting for first message",
          });

          if (!preloadResult.ok) {
            return; // Timed out waiting for first message — end run
          }

          let firstMessage = preloadResult.output;

          currentWirePayload = firstMessage;
        }

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
            async (turnSpan) => {
              locals.set(chatPipeCountKey, 0);
              locals.set(chatDeferKey, new Set());
              locals.set(chatCompactionStateKey, undefined);
              locals.set(chatSteeringQueueKey, []);
              locals.set(chatInjectedMessageIdsKey, new Set());

              // Store chat context for auto-detection by ai.tool subtasks
              locals.set(chatTurnContextKey, {
                chatId: currentWirePayload.chatId,
                turn,
                continuation,
                clientData,
              });

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
              const pmConfig = locals.get(chatPendingMessagesKey);
              const msgSub = messagesInput.on(async (msg) => {
                // If pendingMessages is configured, route to the steering queue
                // instead of the wire buffer. The frontend handles re-sending
                // non-injected messages via sendMessage on turn complete.
                if (pmConfig) {
                  const lastUIMessage = msg.messages?.[msg.messages.length - 1];
                  if (lastUIMessage) {
                    if (pmConfig.onReceived) {
                      try {
                        await pmConfig.onReceived({
                          message: lastUIMessage,
                          chatId: currentWirePayload.chatId,
                          turn,
                        });
                      } catch { /* non-fatal */ }
                    }

                    try {
                      const queue = locals.get(chatSteeringQueueKey) ?? [];
                      // Deduplicate by message ID — guards against double-sends
                      if (lastUIMessage.id && queue.some((e) => e.uiMessage.id === lastUIMessage.id)) {
                        return;
                      }
                      const modelMsgs = await toModelMessages([lastUIMessage]);
                      queue.push({ uiMessage: lastUIMessage, modelMessages: modelMsgs });
                      locals.set(chatSteeringQueueKey, queue);
                    } catch { /* conversion failed — skip steering queue */ }
                  }
                  return; // Don't add to wire buffer — frontend handles non-injected case
                }

                // No pendingMessages config — standard wire buffer for next turn
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
              const incomingModelMessages = await toModelMessages(cleanedUIMessages);

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
                    await withChatWriter(async (writer) => {
                      await onChatStart({
                        chatId: currentWirePayload.chatId,
                        messages: accumulatedMessages,
                        clientData,
                        runId: currentRunId,
                        chatAccessToken: turnAccessToken,
                        continuation,
                        previousRunId,
                        preloaded,
                        writer,
                      });
                    });
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "task-hook-onStart",
                      [SemanticInternalAttributes.COLLAPSED]: true,
                      "chat.id": currentWirePayload.chatId,
                      "chat.messages.count": accumulatedMessages.length,
                      "chat.continuation": continuation,
                      "chat.preloaded": preloaded,
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
                    await withChatWriter(async (writer) => {
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
                        preloaded,
                        previousTurnUsage,
                        totalUsage: cumulativeUsage,
                        writer,
                      });
                    });

                    // Check if onTurnStart replaced messages (compaction)
                    const turnStartOverride = locals.get(chatOverrideMessagesKey);
                    if (turnStartOverride) {
                      locals.set(chatOverrideMessagesKey, undefined);
                      accumulatedUIMessages = [...turnStartOverride];
                      accumulatedMessages = await toModelMessages(turnStartOverride);
                    }
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
                      "chat.preloaded": preloaded,
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
              let runResult: unknown;

              try {
                runResult = await userRun({
                  ...restWire,
                  messages: await applyPrepareMessages(accumulatedMessages, "run"),
                  clientData,
                  continuation,
                  previousRunId,
                  preloaded,
                  previousTurnUsage,
                  totalUsage: cumulativeUsage,
                  signal: combinedSignal,
                  cancelSignal,
                  stopSignal,
                } as any);

                // Auto-pipe if the run function returned a StreamTextResult or similar,
                // but only if pipeChat() wasn't already called manually during this turn.
                // We call toUIMessageStream ourselves to attach onFinish for response capture.
                if ((locals.get(chatPipeCountKey) ?? 0) === 0 && isUIMessageStreamable(runResult)) {
                  onFinishAttached = true;
                  const uiStream = runResult.toUIMessageStream({
                    ...resolveUIMessageStreamOptions(),
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

              // Capture token usage from the streamText result (if available).
              // totalUsage is a PromiseLike that resolves after the stream is consumed.
              let turnUsage: LanguageModelUsage | undefined;
              if (runResult != null && typeof (runResult as any).totalUsage?.then === "function") {
                try {
                  turnUsage = await (runResult as any).totalUsage;
                } catch { /* non-fatal — usage capture failed */ }
              }
              if (turnUsage) {
                cumulativeUsage = addUsage(cumulativeUsage, turnUsage);
                previousTurnUsage = turnUsage;

                // Add usage attributes to the turn span
                if (turnUsage.inputTokens != null) {
                  turnSpan.setAttribute("gen_ai.usage.input_tokens", turnUsage.inputTokens);
                }
                if (turnUsage.outputTokens != null) {
                  turnSpan.setAttribute("gen_ai.usage.output_tokens", turnUsage.outputTokens);
                }
                if (turnUsage.totalTokens != null) {
                  turnSpan.setAttribute("gen_ai.usage.total_tokens", turnUsage.totalTokens);
                }
                if (cumulativeUsage.totalTokens != null) {
                  turnSpan.setAttribute("gen_ai.usage.cumulative_total_tokens", cumulativeUsage.totalTokens);
                }
                if (cumulativeUsage.inputTokens != null) {
                  turnSpan.setAttribute("gen_ai.usage.cumulative_input_tokens", cumulativeUsage.inputTokens);
                }
                if (cumulativeUsage.outputTokens != null) {
                  turnSpan.setAttribute("gen_ai.usage.cumulative_output_tokens", cumulativeUsage.outputTokens);
                }
              }

              // Check if run() (e.g. via prepareStep) replaced messages during this turn.
              // This supports intra-turn compaction — the compacted messages become the
              // new base, and the response gets appended on top.
              const runOverride = locals.get(chatOverrideMessagesKey);
              if (runOverride) {
                locals.set(chatOverrideMessagesKey, undefined);
                accumulatedUIMessages = [...runOverride];
                accumulatedMessages = await toModelMessages(runOverride);
              }

              // Check if compaction set a model-only override (preserves UI messages).
              // Apply compactUIMessages/compactModelMessages callbacks if configured.
              const modelOnlyOverride = locals.get(chatOverrideModelMessagesKey);
              if (modelOnlyOverride) {
                const compactionSummary = locals.get(chatCompactionStateKey)?.summary ?? "";
                const taskCompactionConfig = locals.get(chatTaskCompactionKey);
                locals.set(chatOverrideModelMessagesKey, undefined);

                const compactEvent: CompactMessagesEvent = {
                  summary: compactionSummary,
                  uiMessages: accumulatedUIMessages,
                  modelMessages: accumulatedMessages,
                  chatId: currentWirePayload.chatId,
                  turn,
                  clientData,
                  source: "inner",
                };

                // Apply model messages: callback or default (use override)
                accumulatedMessages = taskCompactionConfig?.compactModelMessages
                  ? await taskCompactionConfig.compactModelMessages(compactEvent)
                  : modelOnlyOverride;

                // Apply UI messages: callback or default (preserve all)
                if (taskCompactionConfig?.compactUIMessages) {
                  accumulatedUIMessages = await taskCompactionConfig.compactUIMessages(compactEvent);
                }

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
                  const responseModelMessages = await toModelMessages([
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

              // Await deferred background work (e.g. DB writes from onTurnStart)
              // before firing hooks so they can rely on the work being done.
              const deferredWork = locals.get(chatDeferKey);
              if (deferredWork && deferredWork.size > 0) {
                await Promise.race([
                  Promise.allSettled(deferredWork),
                  new Promise<void>((r) => setTimeout(r, 5_000)),
                ]);
              }

              // Outer-loop compaction: runs between turns for single-step responses
              // where prepareStep never fires (no tool calls = no step boundaries).
              // Only triggers when: task has compaction configured, prepareStep didn't
              // already compact this turn, and shouldCompact returns true.
              const outerCompaction = locals.get(chatTaskCompactionKey);
              const innerCompactionState = locals.get(chatCompactionStateKey);

              if (outerCompaction && !innerCompactionState && turnUsage && !wasStopped) {
                const shouldTrigger = await outerCompaction.shouldCompact({
                  messages: accumulatedMessages,
                  totalTokens: turnUsage.totalTokens,
                  inputTokens: turnUsage.inputTokens,
                  outputTokens: turnUsage.outputTokens,
                  usage: turnUsage,
                  totalUsage: cumulativeUsage,
                  chatId: currentWirePayload.chatId,
                  turn,
                  clientData,
                  source: "outer",
                });

                if (shouldTrigger) {
                  await tracer.startActiveSpan(
                    "context compaction (outer loop)",
                    async (compactionSpan) => {
                      const compactionId = generateMessageId();

                      const { waitUntilComplete } = streams.writer(CHAT_STREAM_KEY, {
                        spanName: "stream compaction chunks",
                        collapsed: true,
                        execute: async ({ write, merge }) => {
                          write({
                            type: "data-compaction",
                            id: compactionId,
                            data: { status: "compacting", totalTokens: turnUsage.totalTokens },
                          });

                          const summary = await outerCompaction.summarize({
                            messages: accumulatedMessages,
                            usage: turnUsage,
                            totalUsage: cumulativeUsage,
                            chatId: currentWirePayload.chatId,
                            turn,
                            clientData,
                            source: "outer",
                          });

                          // Apply compactModelMessages/compactUIMessages callbacks, or defaults.

                          const outerCompactEvent: CompactMessagesEvent = {
                            summary,
                            uiMessages: accumulatedUIMessages,
                            modelMessages: accumulatedMessages,
                            chatId: currentWirePayload.chatId,
                            turn,
                            clientData,
                            source: "outer",
                          };

                          // Model messages: callback or default (replace with summary)
                          accumulatedMessages = outerCompaction.compactModelMessages
                            ? await outerCompaction.compactModelMessages(outerCompactEvent)
                            : [{ role: "assistant" as const, content: [{ type: "text" as const, text: `[Conversation summary]\n\n${summary}` }] }];

                          // UI messages: callback or default (preserve all)
                          if (outerCompaction.compactUIMessages) {
                            accumulatedUIMessages = await outerCompaction.compactUIMessages(outerCompactEvent);
                          }

                          // Fire onCompacted hook
                          const onCompactedHook = locals.get(chatOnCompactedKey);
                          if (onCompactedHook) {
                            await onCompactedHook({
                              summary,
                              messages: accumulatedMessages,
                              messageCount: accumulatedMessages.length,
                              usage: turnUsage,
                              totalTokens: turnUsage.totalTokens,
                              inputTokens: turnUsage.inputTokens,
                              outputTokens: turnUsage.outputTokens,
                              stepNumber: -1, // outer loop, not a step
                              chatId: currentWirePayload.chatId,
                              turn,
                              writer: { write, merge },
                            });
                          }

                          compactionSpan.setAttribute("compaction.summary_length", summary.length);

                          write({
                            type: "data-compaction",
                            id: compactionId,
                            data: { status: "complete", totalTokens: turnUsage.totalTokens },
                          });
                        },
                      });
                      await waitUntilComplete();
                    },
                    {
                      attributes: {
                        [SemanticInternalAttributes.STYLE_ICON]: "tabler-scissors",
                        "compaction.total_tokens": turnUsage.totalTokens ?? 0,
                        "compaction.input_tokens": turnUsage.inputTokens ?? 0,
                        "compaction.message_count": accumulatedMessages.length,
                        "compaction.outer_loop": true,
                        "compaction.turn": turn,
                        ...(currentWirePayload.chatId ? { "compaction.chat_id": currentWirePayload.chatId } : {}),
                        ...accessoryAttributes({
                          items: [
                            { text: `${turnUsage.totalTokens ?? 0} tokens`, variant: "normal" },
                            { text: `${accumulatedMessages.length} msgs`, variant: "normal" },
                            { text: "outer loop", variant: "normal" },
                          ],
                          style: "codepath",
                        }),
                      },
                    }
                  );
                }
              }

              const turnCompleteEvent = {
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
                clientData,
                stopped: wasStopped,
                continuation,
                previousRunId,
                preloaded,
                usage: turnUsage,
                totalUsage: cumulativeUsage,
              };

              // Fire onBeforeTurnComplete — stream is still open so the hook
              // can write custom chunks to the frontend (e.g. compaction progress).
              if (onBeforeTurnComplete) {
                await tracer.startActiveSpan(
                  "onBeforeTurnComplete()",
                  async () => {
                    await withChatWriter(async (writer) => {
                      await onBeforeTurnComplete({ ...turnCompleteEvent, writer });
                    });

                    // Check if the hook replaced messages (compaction)
                    const override = locals.get(chatOverrideMessagesKey);
                    if (override) {
                      locals.set(chatOverrideMessagesKey, undefined);
                      accumulatedUIMessages = [...override];
                      accumulatedMessages = await toModelMessages(override);
                      // Update event so onTurnComplete sees compacted messages
                      turnCompleteEvent.messages = accumulatedMessages;
                      turnCompleteEvent.uiMessages = accumulatedUIMessages;
                    }
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "task-hook-onComplete",
                      [SemanticInternalAttributes.COLLAPSED]: true,
                      "chat.id": currentWirePayload.chatId,
                      "chat.turn": turn + 1,
                    },
                  }
                );
              }

              // Write turn-complete control chunk — closes the frontend stream.
              const turnCompleteResult = await writeTurnCompleteChunk(
                currentWirePayload.chatId,
                turnAccessToken
              );

              // Fire onTurnComplete — stream is closed, use for persistence.
              if (onTurnComplete) {
                await tracer.startActiveSpan(
                  "onTurnComplete()",
                  async () => {
                    await onTurnComplete({
                      ...turnCompleteEvent,
                      lastEventId: turnCompleteResult.lastEventId,
                    });

                    // Check if onTurnComplete replaced messages (compaction)
                    const turnCompleteOverride = locals.get(chatOverrideMessagesKey);
                    if (turnCompleteOverride) {
                      locals.set(chatOverrideMessagesKey, undefined);
                      accumulatedUIMessages = [...turnCompleteOverride];
                      accumulatedMessages = await toModelMessages(turnCompleteOverride);
                    }
                  },
                  {
                    attributes: {
                      [SemanticInternalAttributes.STYLE_ICON]: "task-hook-onComplete",
                      [SemanticInternalAttributes.COLLAPSED]: true,
                      "chat.id": currentWirePayload.chatId,
                      "chat.turn": turn + 1,
                      "chat.stopped": wasStopped,
                      "chat.continuation": continuation,
                      "chat.preloaded": preloaded,
                      ...(previousRunId ? { "chat.previous_run_id": previousRunId } : {}),
                      "chat.messages.count": accumulatedMessages.length,
                      "chat.response.parts.count": capturedResponseMessage?.parts?.length ?? 0,
                      "chat.new_messages.count": turnNewUIMessages.length,
                      ...(turnUsage?.inputTokens != null ? { "gen_ai.usage.input_tokens": turnUsage.inputTokens } : {}),
                      ...(turnUsage?.outputTokens != null ? { "gen_ai.usage.output_tokens": turnUsage.outputTokens } : {}),
                      ...(turnUsage?.totalTokens != null ? { "gen_ai.usage.total_tokens": turnUsage.totalTokens } : {}),
                      ...(cumulativeUsage.totalTokens != null ? { "gen_ai.usage.cumulative_total_tokens": cumulativeUsage.totalTokens } : {}),
                    },
                  }
                );
              }

              // If messages arrived during streaming (without pendingMessages config),
              // use the first one immediately as the next turn.
              if (pendingMessages.length > 0) {
                currentWirePayload = pendingMessages[0]!;
                return "continue";
              }

              // Wait for the next message — stay idle briefly, then suspend
              const effectiveIdleTimeout =
                (metadata.get(IDLE_TIMEOUT_METADATA_KEY) as number | undefined) ?? idleTimeoutInSeconds;
              const effectiveTurnTimeout =
                (metadata.get(TURN_TIMEOUT_METADATA_KEY) as string | undefined) ?? turnTimeout;

              const next = await messagesInput.waitWithIdleTimeout({
                idleTimeoutInSeconds: effectiveIdleTimeout,
                timeout: effectiveTurnTimeout,
                spanName: "waiting for next message",
              });

              if (!next.ok) {
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
const IDLE_TIMEOUT_METADATA_KEY = "chat.idleTimeout";

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
 * Override the idle timeout for subsequent turns in the current run.
 *
 * The idle timeout controls how long the run stays active (using compute)
 * after each turn, waiting for the next message. During this window,
 * responses are instant. After it expires, the run suspends.
 *
 * @param seconds - Number of seconds to stay idle (0 to suspend immediately)
 *
 * @example
 * ```ts
 * run: async ({ messages, signal }) => {
 *   chat.setIdleTimeoutInSeconds(60);
 *   return streamText({ model, messages, abortSignal: signal });
 * }
 * ```
 */
function setIdleTimeoutInSeconds(seconds: number): void {
  metadata.set(IDLE_TIMEOUT_METADATA_KEY, seconds);
}

/**
 * Override the `toUIMessageStream()` options for the current turn.
 *
 * These options control how the `StreamTextResult` is converted to a
 * `UIMessageChunk` stream — error handling, reasoning/source visibility,
 * message metadata, etc.
 *
 * Per-turn options are merged on top of the static `uiMessageStreamOptions`
 * set on `chat.task()`. Per-turn values win on conflicts.
 *
 * @example
 * ```ts
 * run: async ({ messages, signal }) => {
 *   chat.setUIMessageStreamOptions({
 *     sendReasoning: true,
 *     onError: (error) => error instanceof Error ? error.message : "An error occurred.",
 *   });
 *   return streamText({ model, messages, abortSignal: signal });
 * }
 * ```
 */
function setUIMessageStreamOptions(options: ChatUIMessageStreamOptions): void {
  locals.set(chatUIStreamPerTurnKey, options);
}

/**
 * Resolve the effective UIMessageStream options by merging:
 * 1. Static task-level options (from `chat.task({ uiMessageStreamOptions })`)
 * 2. Per-turn overrides (from `chat.setUIMessageStreamOptions()`)
 *
 * Per-turn values win on conflicts. Clears the per-turn override after reading
 * so it doesn't leak into subsequent turns.
 * @internal
 */
function resolveUIMessageStreamOptions(): ChatUIMessageStreamOptions {
  const staticOptions = locals.get(chatUIStreamStaticKey) ?? {};
  const perTurnOptions = locals.get(chatUIStreamPerTurnKey) ?? {};
  // Clear per-turn override so it doesn't leak into subsequent turns
  locals.set(chatUIStreamPerTurnKey, undefined);
  return { ...staticOptions, ...perTurnOptions };
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
// Per-turn deferred work
// ---------------------------------------------------------------------------

/**
 * Register a promise that runs in the background during the current turn.
 *
 * Use this to move non-blocking work (DB writes, analytics, etc.) out of
 * the critical path. The promise runs in parallel with streaming and is
 * awaited (with a 5 s timeout) before `onTurnComplete` fires.
 *
 * @example
 * ```ts
 * onTurnStart: async ({ chatId, uiMessages }) => {
 *   // Persist messages without blocking the LLM call
 *   chat.defer(db.chat.update({ where: { id: chatId }, data: { messages: uiMessages } }));
 * },
 * ```
 */
function chatDefer(promise: Promise<unknown>): void {
  const promises = locals.get(chatDeferKey);
  if (promises) {
    promises.add(promise);
  }
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
// Composable primitives for raw task chat
// ---------------------------------------------------------------------------

/**
 * Create a managed stop signal wired to the chat stop input stream.
 *
 * Call once at the start of your run. Use `signal` as the abort signal for
 * `streamText`. Call `reset()` at the start of each turn to get a fresh
 * per-turn signal. Call `cleanup()` when the run ends.
 *
 * @example
 * ```ts
 * const stop = chat.createStopSignal();
 * for (let turn = 0; turn < 100; turn++) {
 *   stop.reset();
 *   const result = streamText({ model, messages, abortSignal: stop.signal });
 *   await chat.pipe(result);
 *   // ...
 * }
 * stop.cleanup();
 * ```
 */
function createStopSignal(): { readonly signal: AbortSignal; reset: () => void; cleanup: () => void } {
  let controller = new AbortController();
  const sub = stopInput.on((data) => {
    controller.abort(data?.message || "stopped");
  });
  return {
    get signal() { return controller.signal; },
    reset() { controller = new AbortController(); },
    cleanup() { sub.off(); },
  };
}

/**
 * Signal the frontend that the current turn is complete.
 *
 * The `TriggerChatTransport` intercepts this to close the ReadableStream
 * for the current turn. Call after piping the response stream.
 *
 * @example
 * ```ts
 * await chat.pipe(result);
 * await chat.writeTurnComplete();
 * ```
 */
async function chatWriteTurnComplete(options?: { publicAccessToken?: string }): Promise<void> {
  await writeTurnCompleteChunk(undefined, options?.publicAccessToken);
}

/**
 * Pipe a `StreamTextResult` (or similar) to the chat stream and capture
 * the assistant's response message via `onFinish`.
 *
 * Combines `toUIMessageStream()` + `onFinish` callback + `chat.pipe()`.
 * Returns the captured `UIMessage`, or `undefined` if capture failed.
 *
 * @example
 * ```ts
 * const result = streamText({ model, messages, abortSignal: signal });
 * const response = await chat.pipeAndCapture(result, { signal });
 * if (response) conversation.addResponse(response);
 * ```
 */
async function pipeChatAndCapture(
  source: UIMessageStreamable,
  options?: { signal?: AbortSignal; spanName?: string }
): Promise<UIMessage | undefined> {
  let captured: UIMessage | undefined;
  let resolveOnFinish: () => void;
  const onFinishPromise = new Promise<void>((r) => { resolveOnFinish = r; });

  const uiStream = source.toUIMessageStream({
    ...resolveUIMessageStreamOptions(),
    onFinish: ({ responseMessage }: { responseMessage: UIMessage }) => {
      captured = responseMessage;
      resolveOnFinish!();
    },
  });

  await pipeChat(uiStream, { signal: options?.signal, spanName: options?.spanName ?? "stream response" });
  await onFinishPromise;

  return captured;
}

/**
 * Accumulates conversation messages across turns.
 *
 * Handles the transport protocol: turn 0 sends full history (replace),
 * subsequent turns send only new messages (append), regenerate sends
 * full history minus last assistant message (replace).
 *
 * @example
 * ```ts
 * const conversation = new chat.MessageAccumulator();
 * for (let turn = 0; turn < 100; turn++) {
 *   const messages = await conversation.addIncoming(payload.messages, payload.trigger, turn);
 *   const result = streamText({ model, messages });
 *   const response = await chat.pipeAndCapture(result);
 *   if (response) await conversation.addResponse(response);
 * }
 * ```
 */
class ChatMessageAccumulator {
  modelMessages: ModelMessage[] = [];
  uiMessages: UIMessage[] = [];
  private _compaction?: ChatTaskCompactionOptions;
  private _pendingMessages?: PendingMessagesOptions;
  private _steeringQueue: SteeringQueueEntry[] = [];

  constructor(options?: { compaction?: ChatTaskCompactionOptions; pendingMessages?: PendingMessagesOptions }) {
    this._compaction = options?.compaction;
    this._pendingMessages = options?.pendingMessages;
  }

  /**
   * Add incoming messages from the transport payload.
   * Returns the full accumulated model messages for `streamText`.
   */
  async addIncoming(
    messages: UIMessage[],
    trigger: string,
    turn: number
  ): Promise<ModelMessage[]> {
    const cleaned = messages.map((m) =>
      m.role === "assistant" ? cleanupAbortedParts(m) : m
    );
    const model = await toModelMessages(cleaned);

    if (turn === 0 || trigger === "regenerate-message") {
      this.modelMessages = model;
      this.uiMessages = [...cleaned];
    } else {
      this.modelMessages.push(...model);
      this.uiMessages.push(...cleaned);
    }
    return this.modelMessages;
  }

  /**
   * Add the assistant's response to the accumulator.
   * Call after `pipeAndCapture` with the captured response.
   */
  /**
   * Replace all accumulated messages (for compaction).
   * Converts UIMessages to ModelMessages internally.
   */
  async setMessages(uiMessages: UIMessage[]): Promise<void> {
    this.uiMessages = [...uiMessages];
    this.modelMessages = await toModelMessages(uiMessages);
  }

  async addResponse(response: UIMessage): Promise<void> {
    if (!response.id) {
      response = { ...response, id: generateMessageId() };
    }
    this.uiMessages.push(response);
    try {
      const msgs = await toModelMessages([stripProviderMetadata(response)]);
      this.modelMessages.push(...msgs);
    } catch {
      // Conversion failed — skip model message accumulation for this response
    }
  }

  /**
   * Queue a message for injection via `prepareStep`. Call from a
   * `messagesInput.on()` listener when a message arrives during streaming.
   */
  steer(message: UIMessage, modelMessages?: ModelMessage[]): void {
    if (modelMessages) {
      this._steeringQueue.push({ uiMessage: message, modelMessages });
    } else {
      // Defer conversion — will be done in prepareStep if needed
      this._steeringQueue.push({ uiMessage: message, modelMessages: [] });
    }
  }

  /**
   * Queue a message for injection, converting to model messages automatically.
   */
  async steerAsync(message: UIMessage): Promise<void> {
    const modelMsgs = await toModelMessages([message]);
    this._steeringQueue.push({ uiMessage: message, modelMessages: modelMsgs });
  }

  /**
   * Get and clear unconsumed steering messages.
   */
  drainSteering(): UIMessage[] {
    const result = this._steeringQueue.map((e) => e.uiMessage);
    this._steeringQueue = [];
    return result;
  }

  /**
   * Returns a `prepareStep` function that handles both compaction and
   * pending message injection. Pass to `streamText({ prepareStep: conversation.prepareStep() })`.
   */
  prepareStep(): ((args: { messages: ModelMessage[]; steps: CompactionStep[] }) => Promise<{ messages: ModelMessage[] } | undefined>) | undefined {
    if (!this._compaction && !this._pendingMessages) return undefined;
    const comp = this._compaction;
    const pm = this._pendingMessages;
    const queue = this._steeringQueue;

    return async ({ messages, steps }) => {
      let resultMessages: ModelMessage[] | undefined;

      // 1. Compaction
      if (comp) {
        const result = await chatCompact(messages, steps, {
          shouldCompact: comp.shouldCompact,
          summarize: (msgs) => comp.summarize({ messages: msgs, source: "inner" }),
        });
        if (result.type !== "skipped") {
          resultMessages = result.messages;
        }
      }

      // 2. Pending message injection
      if (pm && queue.length > 0) {
        const injected = await drainSteeringQueue(
          pm,
          resultMessages ?? messages,
          steps,
          queue,
        );
        if (injected.length > 0) {
          resultMessages = [...(resultMessages ?? messages), ...injected];
        }
      }

      return resultMessages ? { messages: resultMessages } : undefined;
    };
  }

  /**
   * Run outer-loop compaction if needed. Call after adding the response
   * and capturing usage. Applies `compactModelMessages` and `compactUIMessages`
   * callbacks if configured.
   *
   * @returns `true` if compaction was performed, `false` otherwise.
   */
  async compactIfNeeded(usage: LanguageModelUsage | undefined, context?: {
    chatId?: string;
    turn?: number;
    clientData?: unknown;
    totalUsage?: LanguageModelUsage;
  }): Promise<boolean> {
    if (!this._compaction || !usage) return false;

    const shouldTrigger = await this._compaction.shouldCompact({
      messages: this.modelMessages,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usage,
      totalUsage: context?.totalUsage,
      chatId: context?.chatId,
      turn: context?.turn,
      clientData: context?.clientData,
      source: "outer",
    });

    if (!shouldTrigger) return false;

    const summary = await this._compaction.summarize({
      messages: this.modelMessages,
      usage,
      totalUsage: context?.totalUsage,
      chatId: context?.chatId,
      turn: context?.turn,
      clientData: context?.clientData,
      source: "outer",
    });

    const compactEvent: CompactMessagesEvent = {
      summary,
      uiMessages: this.uiMessages,
      modelMessages: this.modelMessages,
      chatId: context?.chatId ?? "",
      turn: context?.turn ?? 0,
      clientData: context?.clientData,
      source: "outer",
    };

    this.modelMessages = this._compaction.compactModelMessages
      ? await this._compaction.compactModelMessages(compactEvent)
      : [{ role: "assistant" as const, content: [{ type: "text" as const, text: `[Conversation summary]\n\n${summary}` }] }];

    if (this._compaction.compactUIMessages) {
      this.uiMessages = await this._compaction.compactUIMessages(compactEvent);
    }

    return true;
  }
}

// ---------------------------------------------------------------------------
// chat.createSession — async iterator for chat turns
// ---------------------------------------------------------------------------

export type ChatSessionOptions = {
  /** Run-level cancel signal (from task context). */
  signal: AbortSignal;
  /** Seconds to stay idle between turns before suspending. @default 30 */
  idleTimeoutInSeconds?: number;
  /** Duration string for suspend timeout. @default "1h" */
  timeout?: string;
  /** Max turns before ending. @default 100 */
  maxTurns?: number;
  /** Automatic context compaction — same options as `chat.task({ compaction })`. */
  compaction?: ChatTaskCompactionOptions;
  /** Configure mid-execution message injection — same options as `chat.task({ pendingMessages })`. */
  pendingMessages?: PendingMessagesOptions;
};

export type ChatTurn = {
  /** Turn number (0-indexed). */
  number: number;
  /** Chat session ID. */
  chatId: string;
  /** What triggered this turn. */
  trigger: string;
  /** Client data from the transport (`metadata` field on the wire payload). */
  clientData: unknown;
  /** Full accumulated model messages — pass directly to `streamText`. */
  readonly messages: ModelMessage[];
  /** Full accumulated UI messages — use for persistence. */
  readonly uiMessages: UIMessage[];
  /** Combined stop+cancel AbortSignal (fresh each turn). */
  signal: AbortSignal;
  /** Whether the user stopped generation this turn. */
  readonly stopped: boolean;
  /** Whether this is a continuation run. */
  continuation: boolean;
  /** Token usage from the previous turn. Undefined on turn 0. */
  previousTurnUsage?: LanguageModelUsage;
  /** Cumulative token usage across all completed turns so far. */
  totalUsage: LanguageModelUsage;

  /**
   * Replace accumulated messages (for compaction). Takes UIMessages and
   * converts to ModelMessages internally. After calling this, `turn.messages`
   * reflects the compacted history.
   */
  setMessages(uiMessages: UIMessage[]): Promise<void>;

  /**
   * Easy path: pipe stream, capture response, accumulate it,
   * clean up aborted parts if stopped, and write turn-complete chunk.
   */
  complete(source: UIMessageStreamable): Promise<UIMessage | undefined>;

  /**
   * Manual path: just write turn-complete chunk.
   * Use when you've already piped and accumulated manually.
   */
  done(): Promise<void>;

  /**
   * Add the response to the accumulator manually.
   * Use with `chat.pipeAndCapture` when you need control between pipe and done.
   */
  addResponse(response: UIMessage): Promise<void>;

  /**
   * Returns a `prepareStep` function that handles both compaction and
   * pending message injection. Pass to `streamText({ prepareStep: turn.prepareStep() })`.
   * Only needed when not using `chat.toStreamTextOptions()` (which auto-injects it).
   */
  prepareStep(): ((args: { messages: ModelMessage[]; steps: CompactionStep[] }) => Promise<{ messages: ModelMessage[] } | undefined>) | undefined;
};

/**
 * Create a chat session that yields turns as an async iterator.
 *
 * Handles: preload wait, stop signals, message accumulation, turn-complete
 * signaling, and idle/suspend between turns. You control: initialization,
 * model/tool selection, persistence, and any custom per-turn logic.
 *
 * @example
 * ```ts
 * import { task } from "@trigger.dev/sdk";
 * import { chat, type ChatTaskWirePayload } from "@trigger.dev/sdk/ai";
 * import { streamText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * export const myChat = task({
 *   id: "my-chat",
 *   run: async (payload: ChatTaskWirePayload, { signal }) => {
 *     const session = chat.createSession(payload, { signal });
 *
 *     for await (const turn of session) {
 *       const result = streamText({
 *         model: openai("gpt-4o"),
 *         messages: turn.messages,
 *         abortSignal: turn.signal,
 *       });
 *       await turn.complete(result);
 *     }
 *   },
 * });
 * ```
 */
function createChatSession(
  payload: ChatTaskWirePayload,
  options: ChatSessionOptions
): AsyncIterable<ChatTurn> {
  const {
    signal: runSignal,
    idleTimeoutInSeconds = 30,
    timeout = "1h",
    maxTurns = 100,
    compaction: sessionCompaction,
    pendingMessages: sessionPendingMessages,
  } = options;

  return {
    [Symbol.asyncIterator]() {
      let currentPayload = payload;
      let turn = -1;
      const stop = createStopSignal();
      const accumulator = new ChatMessageAccumulator();
      let previousTurnUsage: LanguageModelUsage | undefined;
      let cumulativeUsage: LanguageModelUsage = emptyUsage();

      return {
        async next(): Promise<IteratorResult<ChatTurn>> {
          turn++;

          // First turn: handle preload — wait for the first real message
          if (turn === 0 && currentPayload.trigger === "preload") {
            const result = await messagesInput.waitWithIdleTimeout({
              idleTimeoutInSeconds: currentPayload.idleTimeoutInSeconds ?? idleTimeoutInSeconds,
              timeout,
              spanName: "waiting for first message",
            });
            if (!result.ok || runSignal.aborted) {
              stop.cleanup();
              return { done: true, value: undefined };
            }
            currentPayload = result.output;
          }

          // Subsequent turns: wait for the next message
          if (turn > 0) {
            const next = await messagesInput.waitWithIdleTimeout({
              idleTimeoutInSeconds,
              timeout,
              spanName: "waiting for next message",
            });
            if (!next.ok || runSignal.aborted) {
              stop.cleanup();
              return { done: true, value: undefined };
            }
            currentPayload = next.output;
          }

          // Check limits
          if (turn >= maxTurns || runSignal.aborted) {
            stop.cleanup();
            return { done: true, value: undefined };
          }

          // Reset stop signal for this turn
          stop.reset();

          // Set up steering queue and pending messages config in locals
          // so toStreamTextOptions() auto-injects prepareStep for steering
          const turnSteeringQueue: SteeringQueueEntry[] = [];
          locals.set(chatSteeringQueueKey, turnSteeringQueue);
          if (sessionPendingMessages) {
            locals.set(chatPendingMessagesKey, sessionPendingMessages);
          }
          locals.set(chatTurnContextKey, {
            chatId: currentPayload.chatId,
            turn,
            continuation: currentPayload.continuation ?? false,
            clientData: currentPayload.metadata,
          });

          // Listen for messages during streaming (steering + next-turn buffer)
          const sessionPendingWire: ChatTaskWirePayload[] = [];
          const sessionMsgSub = messagesInput.on(async (msg) => {
            sessionPendingWire.push(msg);

            if (sessionPendingMessages) {
              const lastUIMessage = msg.messages?.[msg.messages.length - 1];
              if (lastUIMessage) {
                if (sessionPendingMessages.onReceived) {
                  try {
                    await sessionPendingMessages.onReceived({
                      message: lastUIMessage,
                      chatId: currentPayload.chatId,
                      turn,
                    });
                  } catch { /* non-fatal */ }
                }
                try {
                  const modelMsgs = await toModelMessages([lastUIMessage]);
                  turnSteeringQueue.push({ uiMessage: lastUIMessage, modelMessages: modelMsgs });
                } catch { /* non-fatal */ }
              }
            }
          });

          // Accumulate messages
          const messages = await accumulator.addIncoming(
            currentPayload.messages,
            currentPayload.trigger,
            turn,
          );

          const combinedSignal = AbortSignal.any([runSignal, stop.signal]);

          const turnObj: ChatTurn = {
            number: turn,
            chatId: currentPayload.chatId,
            trigger: currentPayload.trigger,
            clientData: currentPayload.metadata,
            get messages() { return accumulator.modelMessages; },
            get uiMessages() { return accumulator.uiMessages; },
            signal: combinedSignal,
            get stopped() { return stop.signal.aborted && !runSignal.aborted; },
            continuation: currentPayload.continuation ?? false,
            previousTurnUsage,
            totalUsage: cumulativeUsage,

            async setMessages(uiMessages: UIMessage[]) {
              await accumulator.setMessages(uiMessages);
            },

            async complete(source: UIMessageStreamable) {
              let response: UIMessage | undefined;
              try {
                response = await pipeChatAndCapture(source, { signal: combinedSignal });
              } catch (error) {
                if (error instanceof Error && error.name === "AbortError") {
                  if (runSignal.aborted) {
                    // Full cancel — don't accumulate
                    sessionMsgSub.off();
                    await chatWriteTurnComplete();
                    return undefined;
                  }
                  // Stop — fall through to accumulate partial response
                } else {
                  throw error;
                }
              }

              if (response) {
                const cleaned = (stop.signal.aborted && !runSignal.aborted)
                  ? cleanupAbortedParts(response)
                  : response;
                await accumulator.addResponse(cleaned);
              }

              // Capture token usage from the streamText result
              let turnUsage: LanguageModelUsage | undefined;
              if (typeof (source as any).totalUsage?.then === "function") {
                try {
                  const usage: LanguageModelUsage = await (source as any).totalUsage;
                  turnUsage = usage;
                  previousTurnUsage = usage;
                  cumulativeUsage = addUsage(cumulativeUsage, usage);
                } catch { /* non-fatal */ }
              }

              // Outer-loop compaction (same logic as chat.task)
              if (sessionCompaction && turnUsage && !turnObj.stopped) {
                const shouldTrigger = await sessionCompaction.shouldCompact({
                  messages: accumulator.modelMessages,
                  totalTokens: turnUsage.totalTokens,
                  inputTokens: turnUsage.inputTokens,
                  outputTokens: turnUsage.outputTokens,
                  usage: turnUsage,
                  totalUsage: cumulativeUsage,
                  chatId: currentPayload.chatId,
                  turn,
                  clientData: currentPayload.metadata,
                  source: "outer",
                });

                if (shouldTrigger) {
                  const summary = await sessionCompaction.summarize({
                    messages: accumulator.modelMessages,
                    usage: turnUsage,
                    totalUsage: cumulativeUsage,
                    chatId: currentPayload.chatId,
                    turn,
                    clientData: currentPayload.metadata,
                    source: "outer",
                  });

                  const compactEvent: CompactMessagesEvent = {
                    summary,
                    uiMessages: accumulator.uiMessages,
                    modelMessages: accumulator.modelMessages,
                    chatId: currentPayload.chatId,
                    turn,
                    clientData: currentPayload.metadata,
                    source: "outer",
                  };

                  accumulator.modelMessages = sessionCompaction.compactModelMessages
                    ? await sessionCompaction.compactModelMessages(compactEvent)
                    : [{ role: "assistant" as const, content: [{ type: "text" as const, text: `[Conversation summary]\n\n${summary}` }] }];

                  if (sessionCompaction.compactUIMessages) {
                    accumulator.uiMessages = await sessionCompaction.compactUIMessages(compactEvent);
                  }
                }
              }

              sessionMsgSub.off();
              await chatWriteTurnComplete();
              return response;
            },

            async addResponse(response: UIMessage) {
              await accumulator.addResponse(response);
            },

            async done() {
              sessionMsgSub.off();
              await chatWriteTurnComplete();
            },

            prepareStep() {
              const hasCompaction = !!sessionCompaction;
              const hasPending = !!sessionPendingMessages;
              if (!hasCompaction && !hasPending) return undefined;

              return async ({ messages: stepMsgs, steps }: { messages: ModelMessage[]; steps: CompactionStep[] }) => {
                let resultMessages: ModelMessage[] | undefined;

                if (sessionCompaction) {
                  const compactResult = await chatCompact(stepMsgs, steps, {
                    shouldCompact: sessionCompaction.shouldCompact,
                    summarize: (msgs) => sessionCompaction.summarize({ messages: msgs, source: "inner" }),
                  });
                  if (compactResult.type !== "skipped") {
                    resultMessages = compactResult.messages;
                  }
                }

                if (sessionPendingMessages) {
                  const injected = await drainSteeringQueue(
                    sessionPendingMessages,
                    resultMessages ?? stepMsgs,
                    steps,
                    turnSteeringQueue,
                  );
                  if (injected.length > 0) {
                    resultMessages = [...(resultMessages ?? stepMsgs), ...injected];
                  }
                }

                return resultMessages ? { messages: resultMessages } : undefined;
              };
            },
          };

          return { done: false, value: turnObj };
        },

        async return() {
          stop.cleanup();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// chat.local — per-run typed data with Proxy access
// ---------------------------------------------------------------------------

/** @internal Symbol for storing the locals key on the proxy target. */
const CHAT_LOCAL_KEY: unique symbol = Symbol("chatLocalKey");
/** @internal Symbol for storing the dirty-tracking locals key. */
const CHAT_LOCAL_DIRTY_KEY: unique symbol = Symbol("chatLocalDirtyKey");

// ---------------------------------------------------------------------------
// chat.local registry — tracks all declared locals for serialization
// ---------------------------------------------------------------------------

type ChatLocalEntry = { key: ReturnType<typeof locals.create>; id: string };
const chatLocalRegistry = new Set<ChatLocalEntry>();

/** @internal Run-scoped flag to ensure hydration happens at most once per run. */
const chatLocalsHydratedKey = locals.create<boolean>("chat.locals.hydrated");

/**
 * Hydrate chat.local values from subtask metadata (set by toolFromTask).
 * Runs once per run — subsequent calls are no-ops.
 * @internal
 */
function hydrateLocalsFromMetadata(): void {
  if (locals.get(chatLocalsHydratedKey)) return;
  locals.set(chatLocalsHydratedKey, true);
  const opts = metadata.get(METADATA_KEY) as ToolCallExecutionOptions | undefined;
  if (!opts?.chatLocals) return;
  for (const [id, value] of Object.entries(opts.chatLocals)) {
    locals.set(locals.create(id), value);
  }
}

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
 * The `id` is required and must be unique across all `chat.local()` calls in
 * your project. It's used to serialize values into subtask metadata so that
 * `ai.tool()` subtasks can auto-hydrate parent locals (read-only).
 *
 * @example
 * ```ts
 * import { chat } from "@trigger.dev/sdk/ai";
 *
 * const userPrefs = chat.local<{ theme: string; language: string }>({ id: "userPrefs" });
 * const gameState = chat.local<{ score: number; streak: number }>({ id: "gameState" });
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
function chatLocal<T extends Record<string, unknown>>(options: { id: string }): ChatLocal<T> {
  const id = `chat.local.${options.id}`;
  const localKey = locals.create<T>(id);
  const dirtyKey = locals.create<boolean>(`${id}.dirty`);

  chatLocalRegistry.add({ key: localKey, id });

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
          let current = locals.get(localKey);
          if (current === undefined) {
            hydrateLocalsFromMetadata();
            current = locals.get(localKey);
          }
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
          let current = locals.get(localKey);
          if (current === undefined) {
            hydrateLocalsFromMetadata();
            current = locals.get(localKey);
          }
          return current ? { ...current } : undefined;
        };
      }

      let current = locals.get(localKey);
      if (current === undefined) {
        // Auto-hydrate from parent metadata in subtask context
        hydrateLocalsFromMetadata();
        current = locals.get(localKey);
      }
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
      let current = locals.get(localKey);
      if (current === undefined) {
        hydrateLocalsFromMetadata();
        current = locals.get(localKey);
      }
      return current !== undefined && prop in current;
    },

    ownKeys() {
      let current = locals.get(localKey);
      if (current === undefined) {
        hydrateLocalsFromMetadata();
        current = locals.get(localKey);
      }
      return current ? Reflect.ownKeys(current) : [];
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      let current = locals.get(localKey);
      if (current === undefined) {
        hydrateLocalsFromMetadata();
        current = locals.get(localKey);
      }
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
  /** Override the idle timeout at runtime. See {@link setIdleTimeoutInSeconds}. */
  setIdleTimeoutInSeconds,
  /** Override toUIMessageStream() options for the current turn. See {@link setUIMessageStreamOptions}. */
  setUIMessageStreamOptions,
  /** Check if the current turn was stopped by the user. See {@link isStopped}. */
  isStopped,
  /** Clean up aborted parts from a UIMessage. See {@link cleanupAbortedParts}. */
  cleanupAbortedParts,
  /** Register background work that runs in parallel with streaming. See {@link chatDefer}. */
  defer: chatDefer,
  /** Typed chat output stream for writing custom chunks or piping from subtasks. */
  stream: chatStream,
  /** Pre-built input stream for receiving messages from the transport. */
  messages: messagesInput,
  /** Create a managed stop signal wired to the stop input stream. See {@link createStopSignal}. */
  createStopSignal,
  /** Signal the frontend that the current turn is complete. See {@link chatWriteTurnComplete}. */
  writeTurnComplete: chatWriteTurnComplete,
  /** Pipe a stream and capture the response message. See {@link pipeChatAndCapture}. */
  pipeAndCapture: pipeChatAndCapture,
  /** Message accumulator class for raw task chat. See {@link ChatMessageAccumulator}. */
  MessageAccumulator: ChatMessageAccumulator,
  /** Create a chat session (async iterator). See {@link createChatSession}. */
  createSession: createChatSession,
  /**
   * Store and retrieve a resolved prompt for the current run.
   *
   * - `chat.prompt.set(resolved)` — store a `ResolvedPrompt` or plain string
   * - `chat.prompt()` — read the stored prompt (throws if not set)
   */
  prompt: Object.assign(getChatPrompt, { set: setChatPrompt }),
  /**
   * Returns an options object ready to spread into `streamText()`.
   * Reads the stored prompt and returns `{ system, experimental_telemetry, ...config }`.
   * Returns `{}` if no prompt has been set.
   */
  toStreamTextOptions,
  /**
   * Replace the accumulated conversation messages for compaction.
   * Call from `onTurnStart` or `onTurnComplete`. Takes `UIMessage[]` and
   * converts to `ModelMessage[]` internally.
   */
  setMessages: setChatMessages,
  /** Check if it's safe to compact messages (no in-flight tool calls). */
  isCompactionSafe,
  /** Returns a `prepareStep` function that handles context compaction automatically. */
  compactionStep: chatCompactionStep,
  /** Low-level compaction for use inside a custom `prepareStep`. */
  compact: chatCompact,
  /** Read the current compaction state (summary + base message count). */
  getCompactionState,
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
