"use client";

import { ShapeStream } from "@electric-sql/client";
import { EventSourceParserStream } from "eventsource-parser/stream";

import { useChat, type UseChatHelpers } from "@ai-sdk/react";
import type {
  UIMessage,
  UIMessageChunk,
  ChatRequestOptions,
  ChatInit,
} from "ai";
import type {
  AnyTask,
  TaskIdentifier,
  AnyRealtimeRun,
} from "@trigger.dev/core/v3";

const DEFAULT_TASK = "chat";
const DEFAULT_STREAM_KEY = "chat";
const DEFAULT_BASE_URL = "https://api.trigger.dev";

export interface TriggerChatTaskPayload<
  UI_MESSAGE extends UIMessage = UIMessage,
> {
  chatId?: string;
  messageId?: string;
  messages: UI_MESSAGE[];
  headers?: Record<string, string> | Headers;
  body?: object;
  metadata?: unknown;
}

export interface TriggerChatTransportOptions<
  TPayload extends TriggerChatTaskPayload = TriggerChatTaskPayload,
> {
  /**
   * The Trigger.dev task identifier to trigger
   * @default "chat"
   *
   * @remarks
   * **CRITICAL:** Your Trigger.dev task MUST call `metadata.stream()` with the AI SDK stream.
   * The stream key used in `metadata.stream()` must match the `streamKey` option (default: "chat").
   *
   * @example Trigger.dev task that streams AI responses:
   * ```ts
   * import { metadata, task } from "@trigger.dev/sdk/v3";
   * import { streamText, convertToModelMessages, type UIMessage } from "ai";
   * import { openai } from "@ai-sdk/openai";
   *
   * export const chatTask = task({
   *   id: "chat",
   *   run: async ({ messages: UIMessage[] }) => {
   *     const result = streamText({
   *       model: openai("gpt-4"),
   *       messages: convertToModelMessages(messages),
   *     });
   *
   *     // CRITICAL: Stream to client using metadata.stream()
   *     await metadata.stream("chat", result.toUIMessageStream());
   *
   *     return { text: await result.text };
   *   },
   * });
   * ```
   */
  task?: TaskIdentifier<AnyTask>;

  /**
   * Server action to trigger the task
   * Must call tasks.trigger() server-side and return run info
   *
   * @example Server action implementation:
   * ```ts
   * "use server";
   * import { tasks } from "@trigger.dev/sdk/v3";
   * import { chatTask } from "./trigger/chat";
   *
   * export async function triggerChatTask(task, payload) {
   *   const handle = await tasks.trigger(task, payload);
   *   return {
   *     success: true,
   *     runId: handle.id,
   *     publicAccessToken: handle.publicAccessToken,
   *   };
   * }
   * ```
   *
   * @remarks
   * This must be a server action in a separate file with "use server" directive.
   * Since this hook runs on the client, it cannot directly call tasks.trigger().
   */
  triggerTask: (
    task: TaskIdentifier<AnyTask>,
    payload: TriggerChatTaskPayload,
  ) => Promise<{
    success: boolean;
    runId?: string;
    publicAccessToken?: string;
    error?: string;
  }>;

  /**
   * Access token for Trigger.dev realtime subscriptions
   * Provide as string or function for dynamic token generation
   *
   * @default Uses the publicAccessToken from tasks.trigger() response
   */
  accessToken?: string | (() => string | Promise<string>);

  /**
   * The stream key used in metadata.stream() on the backend
   * Must match the key used in your Trigger.dev task
   * @default "chat"
   *
   * @example
   * If your task uses `await metadata.stream("my-stream", ...)`,
   * then set `streamKey: "my-stream"` in the hook options.
   */
  streamKey?: string;

  /**
   * Base URL for the Trigger.dev API
   * @default "https://api.trigger.dev"
   */
  baseURL?: string;

  /**
   * Transform chat options into the task payload
   * Use this to customize what gets sent to your Trigger.dev task
   */
  preparePayload?: (params: TriggerChatTaskPayload) => TPayload;
}

type ParsedMetadata = {
  $$streams?: string[];
  $$streamsVersion?: string;
  $$streamsBaseUrl?: string;
} & Record<string, unknown>;

/**
 * Chat transport implementation for AI SDK that integrates with Trigger.dev
 *
 * This transport enables long-running AI conversations by:
 * - Triggering Trigger.dev background tasks
 * - Subscribing to realtime run updates via Electric SQL
 * - Streaming AI responses via Server-Sent Events (SSE)
 *
 * @example Basic usage with defaults:
 * ```ts
 * import { triggerChatTask } from "./actions.ts"; // Your server action with "use server" directive
 *
 * const transport = new TriggerChatTransport({
 *   triggerTask: triggerChatTask,
 * });
 *
 * const { messages } = useChat({ transport });
 * ```
 */
export class TriggerChatTransport {
  private readonly task: TaskIdentifier<AnyTask>;
  private readonly triggerTask: NonNullable<
    TriggerChatTransportOptions["triggerTask"]
  >;
  private readonly accessToken?: string | (() => string | Promise<string>);
  private readonly streamKey: string;
  private readonly baseURL: string;
  private readonly preparePayload?: TriggerChatTransportOptions["preparePayload"];

  private readonly activeRuns = new Map<string, string>();
  private readonly runTokens = new Map<string, string>();

  constructor(options: TriggerChatTransportOptions) {
    this.task = options.task ?? DEFAULT_TASK;
    this.streamKey = options.streamKey ?? DEFAULT_STREAM_KEY;
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    this.triggerTask = options.triggerTask;
    this.accessToken = options.accessToken;
    this.preparePayload = options.preparePayload;
  }

  async sendMessages(
    options: {
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions &
      TriggerChatTaskPayload,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { abortSignal, ...payloadOptions } = options;

    const payload = this.buildPayload({
      ...payloadOptions,
    });

    const result = await this.triggerTask(this.task, payload);

    if (!result.success || !result.runId) {
      throw new Error(result.error || "Failed to trigger task");
    }

    if (payloadOptions.chatId) {
      this.activeRuns.set(payloadOptions.chatId, result.runId);
    }

    if (result.publicAccessToken) {
      this.runTokens.set(result.runId, result.publicAccessToken);
    }

    return this.subscribeToRun(result.runId, abortSignal);
  }

  async reconnectToStream(
    options: { chatId: string } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const runId = this.activeRuns.get(options.chatId);

    if (!runId) {
      return null;
    }

    try {
      return this.subscribeToRun(runId, undefined);
    } catch {
      this.activeRuns.delete(options.chatId);
      return null;
    }
  }

  private buildPayload(params: TriggerChatTaskPayload) {
    if (this.preparePayload) {
      return this.preparePayload(params);
    }

    return params;
  }

  private async subscribeToRun(
    runId: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const accessToken = await this.resolveAccessToken(runId);
    const streamKey = this.streamKey;
    const baseURL = this.baseURL;

    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const runAbortController = new AbortController();
        let unsubscribeFromRun: (() => void) | undefined;

        function cleanup() {
          runAbortController.abort();
          unsubscribeFromRun?.();
        }

        function handleAbort() {
          cleanup();
          controller.close();
        }

        if (abortSignal) {
          abortSignal.addEventListener("abort", handleAbort, { once: true });
        }

        try {
          const runStreamUrl = `${baseURL}/realtime/v1/runs/${runId}`;
          const runStream = new ShapeStream({
            url: runStreamUrl,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "x-trigger-electric-version": "1.0.0-beta.1",
              "x-trigger-api-version": "2024-11-28",
            },
            signal: runAbortController.signal,
          });

          const subscribedStreams = new Set<string>();

          unsubscribeFromRun = runStream.subscribe(
            (messages) => {
              for (const message of messages) {
                if (!("value" in message) || !message.value) continue;

                const run = message.value as unknown as AnyRealtimeRun;
                const metadata = parseMetadata(run.metadata);

                subscribeToDataStreams({
                  metadata,
                  subscribedStreams,
                  streamKey,
                  runId,
                  baseURL,
                  accessToken,
                  runAbortController,
                  controller,
                });

                if (run.finishedAt) {
                  cleanup();
                  controller.close();
                  if (abortSignal) {
                    abortSignal.removeEventListener("abort", handleAbort);
                  }
                }
              }
            },
            (error) => {
              controller.error(error);
              if (abortSignal) {
                abortSignal.removeEventListener("abort", handleAbort);
              }
            },
          );
        } catch (error) {
          cleanup();
          controller.error(error);
        }
      },
    });
  }

  private async resolveAccessToken(runId: string): Promise<string> {
    const storedToken = this.runTokens.get(runId);
    if (storedToken) {
      return storedToken;
    }

    if (!this.accessToken) {
      throw new Error(
        "No access token available. Provide accessToken option or ensure tasks.trigger() returns publicAccessToken",
      );
    }

    if (typeof this.accessToken === "function") {
      return await this.accessToken();
    }

    return this.accessToken;
  }
}

/**
 * Parse metadata from Trigger.dev run
 * Handles both string (JSON) and object formats
 */
function parseMetadata(
  metadata: Record<string, unknown> | string | undefined,
): ParsedMetadata | undefined {
  if (!metadata) return undefined;

  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata) as ParsedMetadata;
    } catch {
      return undefined;
    }
  }

  if (typeof metadata === "object") {
    return metadata as ParsedMetadata;
  }

  return undefined;
}

/**
 * Subscribe to data streams when metadata indicates they're available
 * Uses Server-Sent Events to stream AI responses in real-time
 */
function subscribeToDataStreams(params: {
  metadata: ParsedMetadata | undefined;
  subscribedStreams: Set<string>;
  streamKey: string;
  runId: string;
  baseURL: string;
  accessToken: string;
  runAbortController: AbortController;
  controller: ReadableStreamDefaultController<UIMessageChunk>;
}) {
  const {
    metadata,
    subscribedStreams,
    streamKey,
    runId,
    baseURL,
    accessToken,
    runAbortController,
    controller,
  } = params;

  if (!metadata?.$$streams || !Array.isArray(metadata.$$streams)) {
    console.warn(
      "Unable to subscribe to streams: metadata.$$streams does not contain an array",
    );
    return;
  }

  for (const stream of metadata.$$streams) {
    if (typeof stream !== "string") continue;
    if (stream !== streamKey) continue;
    if (subscribedStreams.has(stream)) continue;

    subscribedStreams.add(stream);
    streamDataFromTrigger({
      streamKey: stream,
      runId,
      baseURL,
      accessToken,
      runAbortController,
      controller,
    });
  }
}

/**
 * Stream data from Trigger.dev using Server-Sent Events
 * Reads stream chunks and enqueues them to the controller
 */
async function streamDataFromTrigger(params: {
  streamKey: string;
  runId: string;
  baseURL: string;
  accessToken: string;
  runAbortController: AbortController;
  controller: ReadableStreamDefaultController<UIMessageChunk>;
}) {
  const {
    streamKey,
    runId,
    baseURL,
    accessToken,
    runAbortController,
    controller,
  } = params;

  try {
    const streamUrl = `${baseURL}/realtime/v1/streams/${runId}/${streamKey}`;
    const response = await fetch(streamUrl, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: runAbortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Stream fetch failed: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break; // Don't close controller - let run.finishedAt handle it
        }

        // AI SDK streams typically send chunks as data events
        if (value.event && value.event !== "data") {
          continue; // Skip non-data events
        }

        try {
          const chunk = JSON.parse(value.data);
          controller.enqueue(chunk as UIMessageChunk);
        } catch (parseError) {
          console.warn("Failed to parse SSE chunk:", value.data, parseError);
          // Continue processing other chunks
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    const shouldIgnoreError =
      error instanceof Error && error.name === "AbortError";

    if (!shouldIgnoreError) {
      throw error;
    }
  }
}

type UseTriggerChatOptions = {
  transportOptions: TriggerChatTransportOptions;
} & Omit<ChatInit<UIMessage>, "transport">;

/**
 * Hook to use Trigger.dev chat transport with AI SDK's useChat
 *
 * Enables long-running AI conversations by triggering Trigger.dev background tasks,
 * subscribing to realtime run updates, and streaming AI responses via SSE.
 *
 * @param options - Options for the chat hook including transport configuration
 * @returns AI SDK chat helpers (messages, input, handleSubmit, etc.)
 *
 * @remarks
 * **CRITICAL SETUP REQUIREMENTS:**
 *
 * 1. Your Trigger.dev task MUST call `metadata.stream()` to stream responses:
 *    ```ts
 *    await metadata.stream("chat", result.toUIMessageStream());
 *    ```
 *
 * 2. You must provide a server action that calls `tasks.trigger()`:
 *    ```ts
 *    "use server";
 *    export async function triggerChat(task: string, payload: unknown) {
 *      const handle = await tasks.trigger(task, payload);
 *      return { success: true, runId: handle.id, publicAccessToken: handle.publicAccessToken };
 *    }
 *    ```
 *
 * @example Complete setup with three files:
 *
 * **1. Trigger.dev task (src/trigger/chat.ts):**
 * ```ts
 * import { metadata, task } from "@trigger.dev/sdk/v3";
 * import { streamText, convertToModelMessages, type UIMessage } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * export const chatTask = task({
 *   id: "chat",
 *   run: async ({ messages: UIMessage[] }) => {
 *     const result = streamText({
 *       model: openai("gpt-4"),
 *       messages: convertToModelMessages(messages),
 *      });
 *     // CRITICAL: Stream to client
 *     await metadata.stream("chat", result.toUIMessageStream());
 *     return { text: await result.text };
 *   },
 * });
 * ```
 *
 * **2. Server action (src/actions.ts):**
 * ```ts
 * "use server";
 * import { tasks } from "@trigger.dev/sdk/v3";
 *
 * export async function triggerChat(task: string, payload: unknown) {
 *   const handle = await tasks.trigger(task, payload);
 *   return { success: true, runId: handle.id, publicAccessToken: handle.publicAccessToken };
 * }
 * ```
 *
 * **3. Client component (src/components/Chat.tsx):**
 * ```ts
 * "use client";
 * import { useTriggerChat } from "@trigger.dev/react-hooks";
 * import { triggerChat } from "../actions";
 *
 * export function Chat() {
 *   const { messages, input, handleInputChange, handleSubmit } = useTriggerChat({
 *     transportOptions: { triggerTask: triggerChat }
 *   });
 *
 *   return (
 *     <form onSubmit={handleSubmit}>
 *       {messages.map(m => <div key={m.id}>{m.role}: {m.content}</div>)}
 *       <input value={input} onChange={handleInputChange} />
 *       <button type="submit">Send</button>
 *     </form>
 *   );
 * }
 * ```
 */
export function useTriggerChat(
  options: UseTriggerChatOptions,
): UseChatHelpers<UIMessage> {
  const { transportOptions, ...chatOptions } = options;

  return useChat({
    transport: new TriggerChatTransport(transportOptions),
    ...chatOptions,
  });
}
