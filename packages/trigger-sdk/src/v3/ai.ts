import {
  AnyTask,
  isSchemaZodEsque,
  Task,
  type inferSchemaIn,
  type PipeStreamOptions,
  type TaskOptions,
  type TaskSchema,
  type TaskWithSchema,
} from "@trigger.dev/core/v3";
import type { UIMessage } from "ai";
import { dynamicTool, jsonSchema, JSONSchema7, Schema, Tool, ToolCallOptions, zodSchema } from "ai";
import { metadata } from "./metadata.js";
import { streams } from "./streams.js";
import { createTask } from "./shared.js";

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

// ---------------------------------------------------------------------------
// Chat transport helpers — backend side
// ---------------------------------------------------------------------------

/**
 * The default stream key used for chat transport communication.
 * Both `TriggerChatTransport` (frontend) and `pipeChat`/`chatTask` (backend)
 * use this key by default.
 */
export const CHAT_STREAM_KEY = "chat";

/**
 * The payload shape that the chat transport sends to the triggered task.
 *
 * When using `chatTask()`, the payload is automatically typed — you don't need
 * to import this type. Use this type only if you're using `task()` directly
 * with `pipeChat()`.
 */
export type ChatTaskPayload<TMessage extends UIMessage = UIMessage> = {
  /** The conversation messages */
  messages: TMessage[];

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

  /** Custom metadata from the frontend */
  metadata?: unknown;
};

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
 * import { pipeChat, type ChatTaskPayload } from "@trigger.dev/sdk/ai";
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
 * // Works from anywhere inside a task — even deep in your agent code
 * async function runAgentLoop(messages: CoreMessage[]) {
 *   const result = streamText({ model, messages });
 *   await pipeChat(result);
 * }
 * ```
 */
export async function pipeChat(
  source: UIMessageStreamable | AsyncIterable<unknown> | ReadableStream<unknown>,
  options?: PipeChatOptions
): Promise<void> {
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

  const { waitUntilComplete } = streams.pipe(streamKey, stream, pipeOptions);
  await waitUntilComplete();
}

/**
 * Options for defining a chat task.
 *
 * Extends the standard `TaskOptions` but pre-types the payload as `ChatTaskPayload`
 * and overrides `run` to accept `ChatTaskPayload` directly.
 *
 * **Auto-piping:** If the `run` function returns a value with `.toUIMessageStream()`
 * (like a `StreamTextResult`), the stream is automatically piped to the frontend.
 * For complex flows, use `pipeChat()` manually from anywhere in your code.
 */
export type ChatTaskOptions<TIdentifier extends string> = Omit<
  TaskOptions<TIdentifier, ChatTaskPayload, unknown>,
  "run"
> & {
  /**
   * The run function for the chat task.
   *
   * Receives a `ChatTaskPayload` with the conversation messages, chat session ID,
   * and trigger type.
   *
   * **Auto-piping:** If this function returns a value with `.toUIMessageStream()`,
   * the stream is automatically piped to the frontend.
   */
  run: (payload: ChatTaskPayload) => Promise<unknown>;
};

/**
 * Creates a Trigger.dev task pre-configured for AI SDK chat.
 *
 * - **Pre-types the payload** as `ChatTaskPayload` — no manual typing needed
 * - **Auto-pipes the stream** if `run` returns a `StreamTextResult`
 * - For complex flows, use `pipeChat()` from anywhere inside your task code
 *
 * @example
 * ```ts
 * import { chatTask } from "@trigger.dev/sdk/ai";
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
 * import { chatTask, pipeChat } from "@trigger.dev/sdk/ai";
 *
 * // Complex: pipeChat() from deep in your agent code
 * export const myAgentTask = chatTask({
 *   id: "my-agent-task",
 *   run: async ({ messages }) => {
 *     await runComplexAgentLoop(messages);
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

      // Auto-pipe if the run function returned a StreamTextResult or similar
      if (isUIMessageStreamable(result)) {
        await pipeChat(result);
      }

      return result;
    },
  });
}
