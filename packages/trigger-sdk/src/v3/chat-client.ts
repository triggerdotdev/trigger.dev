/**
 * Server-side API for chatting with Trigger.dev agents.
 *
 * @example
 * ```ts
 * import { AgentChat } from "@trigger.dev/sdk/chat";
 *
 * const chat = new AgentChat<typeof myAgent>({
 *   agent: "my-agent",
 *   clientData: { userId: "user_123" },
 * });
 *
 * const stream = await chat.sendMessage("Review PR #1");
 * const text = await stream.text();
 * await chat.close();
 * ```
 */

import type { SessionTriggerConfig, Task } from "@trigger.dev/core/v3";
import type { ModelMessage, UIMessage, UIMessageChunk } from "ai";
import { readUIMessageStream } from "ai";
import {
  ApiClient,
  apiClientManager,
  controlSubtype,
  SSEStreamSubscription,
  TRIGGER_CONTROL_SUBTYPE,
} from "@trigger.dev/core/v3";
import type { ChatInputChunk, ChatTaskWirePayload } from "./ai-shared.js";
import { sessions } from "./sessions.js";

// ─── Type inference ────────────────────────────────────────────────

/** Extract the client data (metadata) type from a chat agent task. */
export type InferChatClientData<T> =
  T extends Task<any, ChatTaskWirePayload<any, infer TMetadata>, any>
    ? unknown extends TMetadata
      ? Record<string, unknown>
      : TMetadata
    : Record<string, unknown>;

/** Extract the UIMessage type from a chat agent task. */
export type InferChatUIMessage<T> =
  T extends Task<any, ChatTaskWirePayload<infer TUIMessage, any>, any>
    ? TUIMessage
    : UIMessage;

// ─── Types ─────────────────────────────────────────────────────────

/** Persistable session state — store this to resume across requests. */
export type ChatSession = {
  /** Last SSE event ID seen on `session.out` — used to resume without replay. */
  lastEventId?: string;
};

export type AgentChatOptions<TAgent = unknown> = {
  /** The agent task ID to trigger. */
  agent: string;
  /**
   * Conversation ID. Used for tagging runs and correlating messages.
   * @default crypto.randomUUID()
   */
  id?: string;
  /** Client data included in every request. Typed from the agent's clientDataSchema. */
  clientData?: InferChatClientData<TAgent>;
  /**
   * Restore a previous session. Pass `lastEventId` from a previous
   * request to resume the SSE stream without replaying old chunks.
   */
  session?: ChatSession;
  /**
   * Called when a new run is triggered for this session (initial start).
   * Useful for telemetry / dashboard linking. The runId is the
   * friendlyId.
   */
  onTriggered?: (event: { runId: string; chatId: string }) => void | Promise<void>;
  /**
   * Called when a turn completes. Persist `lastEventId` for stream
   * resumption across requests.
   */
  onTurnComplete?: (event: {
    chatId: string;
    lastEventId?: string;
  }) => void | Promise<void>;
  /** SSE timeout in seconds. @default 120 */
  streamTimeoutSeconds?: number;
  /**
   * Default trigger config used when starting a new session for this
   * chat. Folded into `sessions.start({...triggerConfig})` body.
   */
  triggerConfig?: SessionTriggerConfig;
};

// ─── ChatStream ────────────────────────────────────────────────────

/** Parsed tool call from the stream. */
export type ChatToolCall = {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

/** Parsed tool result from the stream. */
export type ChatToolResult = {
  toolCallId: string;
  output: unknown;
};

/** Accumulated result after a stream completes. */
export type ChatStreamResult = {
  text: string;
  toolCalls: ChatToolCall[];
  toolResults: ChatToolResult[];
};

/**
 * A single turn's response stream from an agent.
 *
 * Pick one consumption mode:
 * - `for await (const chunk of stream)` — typed UIMessageChunk iteration
 * - `await stream.result()` — accumulated `{ text, toolCalls, toolResults }`
 * - `await stream.text()` — just the text
 * - `yield* stream.messages()` — sub-agent pattern (yields UIMessage snapshots)
 */
export class ChatStream {
  private readonly _consumerStream: ReadableStream<UIMessageChunk>;
  private readonly _messageCollector?: Promise<void>;
  private resultPromise: Promise<ChatStreamResult> | undefined;
  /** @internal Last UIMessage snapshot from the assistant's response. */
  private lastAssistantMessage: UIMessage | undefined;
  /** @internal Callback to capture the assistant's response message for accumulation. */
  private readonly onAssistantMessage?: (message: UIMessage) => void;

  constructor(
    stream: ReadableStream<UIMessageChunk>,
    onAssistantMessage?: (message: UIMessage) => void
  ) {
    this.onAssistantMessage = onAssistantMessage;

    if (onAssistantMessage) {
      // Tee the stream: one branch for the consumer, one for message collection
      const [consumer, collector] = stream.tee();
      this._consumerStream = consumer;
      this._messageCollector = (async () => {
        for await (const msg of readUIMessageStream({ stream: collector })) {
          this.lastAssistantMessage = msg;
        }
        if (this.lastAssistantMessage) {
          onAssistantMessage(this.lastAssistantMessage);
        }
      })();
    } else {
      this._consumerStream = stream;
    }
  }

  /** The raw ReadableStream for direct use with AI SDK utilities. */
  get stream(): ReadableStream<UIMessageChunk> {
    return this._consumerStream;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<UIMessageChunk> {
    const reader = this._consumerStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Yields accumulated UIMessage snapshots for the sub-agent tool pattern.
   *
   * @example
   * ```ts
   * const stream = await chat.sendMessage("Research this topic");
   * yield* stream.messages();
   * ```
   */
  async *messages(): AsyncGenerator<UIMessage, void, unknown> {
    for await (const message of readUIMessageStream({ stream: this._consumerStream })) {
      this.lastAssistantMessage = message;
      yield message;
    }
    // When the constructor set up `_messageCollector` (because
    // `onAssistantMessage` was provided), that collector IIFE owns
    // firing the callback. Skipping it here prevents a double-invoke.
    if (this.lastAssistantMessage && this.onAssistantMessage && !this._messageCollector) {
      this.onAssistantMessage(this.lastAssistantMessage);
    }
  }

  /** Consume the stream and return the accumulated result. */
  result(): Promise<ChatStreamResult> {
    if (!this.resultPromise) {
      this.resultPromise = this.consumeStream();
    }
    return this.resultPromise;
  }

  /** Consume the stream and return just the text. */
  async text(): Promise<string> {
    return (await this.result()).text;
  }

  private async consumeStream(): Promise<ChatStreamResult> {
    let text = "";
    const toolCalls: ChatToolCall[] = [];
    const toolResults: ChatToolResult[] = [];

    for await (const chunk of this) {
      if (chunk.type === "text-delta") {
        text += chunk.delta;
      } else if (chunk.type === "tool-input-available") {
        toolCalls.push({
          toolName: chunk.toolName,
          toolCallId: chunk.toolCallId,
          input: chunk.input,
        });
      } else if (chunk.type === "tool-output-available") {
        toolResults.push({
          toolCallId: chunk.toolCallId,
          output: chunk.output,
        });
      }
    }

    return { text, toolCalls, toolResults };
  }
}

// ─── Internal ──────────────────────────────────────────────────────

type SessionState = {
  lastEventId?: string;
  skipToTurnComplete?: boolean;
  /** True after the session has been started (sessions.start). */
  started: boolean;
};

// ─── AgentChat ─────────────────────────────────────────────────────

/**
 * A chat conversation with a Trigger.dev agent.
 *
 * @example
 * ```ts
 * // Simple usage
 * const chat = new AgentChat<typeof myAgent>({ agent: "my-agent" });
 * const text = await (await chat.sendMessage("Hello")).text();
 * await chat.close();
 *
 * // Stateless request handler — persist and restore session
 * const chat = new AgentChat<typeof myAgent>({
 *   agent: "my-agent",
 *   id: chatId,
 *   session: { lastEventId: savedLastEventId },
 *   onTriggered: ({ runId }) => db.save(chatId, { runId }),
 *   onTurnComplete: ({ lastEventId }) => db.update(chatId, { lastEventId }),
 * });
 * ```
 */
export class AgentChat<TAgent = unknown> {
  private readonly taskId: string;
  private readonly chatId: string;
  private readonly streamTimeoutSeconds: number;
  private readonly clientData: Record<string, unknown> | undefined;
  private readonly triggerConfigDefault: SessionTriggerConfig | undefined;
  private readonly onTriggered: AgentChatOptions["onTriggered"];
  private readonly onTurnComplete: AgentChatOptions["onTurnComplete"];

  private state: SessionState;

  constructor(options: AgentChatOptions<TAgent>) {
    this.taskId = options.agent;
    this.chatId = options.id ?? crypto.randomUUID();
    this.streamTimeoutSeconds = options.streamTimeoutSeconds ?? 120;
    this.clientData = options.clientData as Record<string, unknown> | undefined;
    this.triggerConfigDefault = options.triggerConfig;
    this.onTriggered = options.onTriggered;
    this.onTurnComplete = options.onTurnComplete;

    // Hydration: a non-empty `session` means the caller knows the
    // session already exists (started in a previous request). Mark
    // `started` so we don't re-`sessions.start()` on first message.
    const hydrated = !!options.session;
    this.state = {
      lastEventId: options.session?.lastEventId,
      started: hydrated,
    };
  }

  /** The conversation ID. */
  get id(): string {
    return this.chatId;
  }

  /** Persistable session state — pass back via `options.session` to resume. */
  get session(): ChatSession {
    return { lastEventId: this.state.lastEventId };
  }

  /**
   * Eagerly start the session — creates the row and triggers the first
   * run. The agent's `onPreload` hook fires immediately. Idempotent: a
   * second call is a no-op.
   */
  async preload(options?: { idleTimeoutInSeconds?: number }): Promise<ChatSession> {
    await this.ensureStarted({ idleTimeoutInSeconds: options?.idleTimeoutInSeconds });
    return this.session;
  }

  /**
   * Send a text message and get the response stream.
   *
   * @example
   * ```ts
   * const stream = await chat.sendMessage("Review PR #1");
   * const text = await stream.text();
   * ```
   */
  async sendMessage(
    text: string,
    options?: { abortSignal?: AbortSignal }
  ): Promise<ChatStream> {
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message: UIMessage = {
      id: msgId,
      role: "user",
      parts: [{ type: "text", text }],
    };

    const rawStream = await this.sendRaw([message], { abortSignal: options?.abortSignal });
    return new ChatStream(rawStream);
  }

  /** Send raw UIMessage-like objects. Use `sendMessage()` for simple text. */
  async sendRaw(
    messages: UIMessage[] | Array<{
      id: string;
      role: string;
      parts?: unknown[];
      [key: string]: unknown;
    }>,
    options?: {
      trigger?: "submit-message" | "regenerate-message";
      abortSignal?: AbortSignal;
    }
  ): Promise<ReadableStream<UIMessageChunk>> {
    const triggerType = options?.trigger ?? "submit-message";

    // Make sure the session exists (and a run is alive). The .in/append
    // handler on the server probes currentRunId on every call and
    // re-triggers if needed — so we don't need to track runId here.
    await this.ensureStarted();

    // Slim wire — at most ONE message per record. The agent rebuilds prior
    // history from its durable S3 snapshot + session.out replay at run
    // boot. `regenerate-message` omits `message` (the agent slices its own
    // history). See plan vivid-humming-bonbon.
    if (triggerType === "submit-message" && messages.length === 0) {
      throw new Error(
        "AgentChat.sendRaw: 'submit-message' trigger requires at least one message"
      );
    }
    const lastIfSubmit =
      triggerType === "submit-message"
        ? (messages.at(-1) as UIMessage | undefined)
        : undefined;
    const payload: ChatTaskWirePayload = {
      ...(lastIfSubmit ? { message: lastIfSubmit } : {}),
      chatId: this.chatId,
      trigger: triggerType,
      metadata: this.clientData,
    } as ChatTaskWirePayload;

    const api = this.createApiClient();
    await api.appendToSessionStream(
      this.chatId,
      "in",
      serializeInputChunk({ kind: "message", payload })
    );

    return this.subscribeToSessionStream(options?.abortSignal);
  }

  /** Send a steering message during an active stream. */
  async steer(text: string): Promise<boolean> {
    if (!this.state.started) return false;

    const payload: ChatTaskWirePayload = {
      message: {
        id: `steer-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text }],
      } as unknown as UIMessage,
      chatId: this.chatId,
      trigger: "submit-message" as const,
      metadata: this.clientData,
    };

    try {
      const api = this.createApiClient();
      await api.appendToSessionStream(
        this.chatId,
        "in",
        serializeInputChunk({
          kind: "message",
          payload,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Stop the current generation (agent stays alive for next turn). */
  async stop(): Promise<void> {
    if (!this.state.started) return;

    this.state.skipToTurnComplete = true;
    const api = this.createApiClient();
    await api
      .appendToSessionStream(
        this.chatId,
        "in",
        serializeInputChunk({ kind: "stop" })
      )
      .catch(() => {});
  }

  /**
   * Hand over from a `chat.handover` route handler to a parked
   * `handover-prepare` agent run. Wakes the run, which seeds its
   * accumulators with `partialAssistantMessage` and continues from
   * tool execution onward — the model call for step 1 is skipped.
   *
   * Used internally by `chat.handover`; not part of the customer
   * surface.
   */
  async sendHandover(args: {
    partialAssistantMessage: ModelMessage[];
    /**
     * UI messageId from the customer's step-1 stream — propagated to
     * the agent so its post-handover chunks merge into the same
     * assistant message on the browser.
     */
    messageId?: string;
    /**
     * Whether the customer's step 1 is the final response (pure-text
     * finish). When true, the agent runs hooks but skips the LLM
     * call. When false, the agent runs `streamText` which executes
     * pending tool-calls and continues from step 2.
     */
    isFinal: boolean;
  }): Promise<void> {
    const api = this.createApiClient();
    await api.appendToSessionStream(
      this.chatId,
      "in",
      serializeInputChunk({
        kind: "handover",
        partialAssistantMessage: args.partialAssistantMessage,
        messageId: args.messageId,
        isFinal: args.isFinal,
      })
    );
  }

  /**
   * Tell a parked `handover-prepare` agent run that the customer's
   * first turn finished pure-text (no tool calls) — the run exits
   * cleanly without making an LLM call.
   *
   * Used internally by `chat.handover`; not part of the customer
   * surface.
   */
  async sendHandoverSkip(): Promise<void> {
    const api = this.createApiClient();
    await api.appendToSessionStream(
      this.chatId,
      "in",
      serializeInputChunk({ kind: "handover-skip" })
    );
  }

  /**
   * Send a custom action to the agent.
   *
   * Actions are not turns. They wake the agent, fire `hydrateMessages`
   * (if configured) and `onAction` only — no `onTurnStart` /
   * `prepareMessages` / `onBeforeTurnComplete` / `onTurnComplete`, no
   * `run()` invocation.
   *
   * The action payload is validated against the agent's `actionSchema`
   * on the backend. Use `chat.history.*` inside `onAction` to mutate
   * state. To produce a model response from the action, return a
   * `StreamTextResult` (or `string` / `UIMessage`) from `onAction` —
   * the returned stream is auto-piped over this stream. When `onAction`
   * returns `void`, the action is side-effect-only and the returned
   * stream completes immediately with `trigger:turn-complete`.
   *
   * @returns A `ChatStream`. For void actions the stream completes
   * immediately. For actions that return a model response, the stream
   * carries the assistant chunks.
   *
   * @example
   * ```ts
   * const stream = await agentChat.sendAction({ type: "undo" });
   * for await (const chunk of stream) {
   *   if (chunk.type === "text-delta") process.stdout.write(chunk.delta);
   * }
   * ```
   */
  async sendAction(
    action: unknown,
    options?: { abortSignal?: AbortSignal }
  ): Promise<ChatStream> {
    await this.ensureStarted();

    const payload: ChatTaskWirePayload = {
      chatId: this.chatId,
      trigger: "action" as const,
      action,
      metadata: this.clientData,
    };

    try {
      const api = this.createApiClient();
      await api.appendToSessionStream(
        this.chatId,
        "in",
        serializeInputChunk({
          kind: "message",
          payload,
        })
      );
    } catch {
      throw new Error("Failed to send action. The session may have ended.");
    }

    const rawStream = this.subscribeToSessionStream(options?.abortSignal);
    return new ChatStream(rawStream);
  }

  /** Close the conversation — agent exits its loop gracefully. */
  async close(): Promise<boolean> {
    if (!this.state.started) return false;

    try {
      const api = this.createApiClient();
      await api.appendToSessionStream(
        this.chatId,
        "in",
        serializeInputChunk({
          kind: "message",
          payload: {
            chatId: this.chatId,
            trigger: "close",
          } satisfies ChatTaskWirePayload,
        })
      );
      this.state = { ...this.state, started: false };
      return true;
    } catch {
      return false;
    }
  }

  /** Reconnect to the response stream (e.g. after a disconnect). */
  async reconnect(
    abortSignal?: AbortSignal
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    if (!this.state.started) return null;
    return this.subscribeToSessionStream(abortSignal, { sendStopOnAbort: false });
  }

  // ─── Private ───────────────────────────────────────────────────

  private createApiClient(): ApiClient {
    const baseURL = apiClientManager.baseURL ?? "https://api.trigger.dev";
    const accessToken = apiClientManager.accessToken ?? "";
    return new ApiClient(baseURL, accessToken);
  }

  /**
   * Idempotent: `sessions.start` upserts on `(env, externalId)`. Two
   * concurrent AgentChat instances on the same chatId converge to the
   * same session.
   */
  private async ensureStarted(options?: { idleTimeoutInSeconds?: number }): Promise<void> {
    if (this.state.started) return;

    const triggerConfig: SessionTriggerConfig = {
      basePayload: {
        // `trigger: "preload"` mirrors the browser-mediated
        // `chat.createStartSessionAction` shape so the agent runtime fires
        // `onPreload` (not `onChatStart` with `preloaded: true`). Without
        // this, AgentChat's first run skips both preload and start hooks,
        // which is where customer apps typically upsert their Chat row.
        // Slim wire — preload carries no message body.
        trigger: "preload",
        ...(this.triggerConfigDefault?.basePayload ?? {}),
        chatId: this.chatId,
        ...(this.clientData ? { metadata: this.clientData } : {}),
      },
      ...(this.triggerConfigDefault?.machine
        ? { machine: this.triggerConfigDefault.machine }
        : {}),
      ...(this.triggerConfigDefault?.queue
        ? { queue: this.triggerConfigDefault.queue }
        : {}),
      ...(this.triggerConfigDefault?.tags
        ? { tags: this.triggerConfigDefault.tags }
        : {}),
      ...(this.triggerConfigDefault?.maxAttempts !== undefined
        ? { maxAttempts: this.triggerConfigDefault.maxAttempts }
        : {}),
      ...(options?.idleTimeoutInSeconds !== undefined ||
      this.triggerConfigDefault?.idleTimeoutInSeconds !== undefined
        ? {
            idleTimeoutInSeconds:
              options?.idleTimeoutInSeconds ??
              this.triggerConfigDefault?.idleTimeoutInSeconds!,
          }
        : {}),
    };

    const created = await sessions.start({
      type: "chat.agent",
      externalId: this.chatId,
      taskIdentifier: this.taskId,
      triggerConfig,
    });

    this.state.started = true;
    await this.onTriggered?.({
      runId: created.runId,
      chatId: this.chatId,
    });
  }

  private subscribeToSessionStream(
    abortSignal: AbortSignal | undefined,
    options?: { sendStopOnAbort?: boolean }
  ): ReadableStream<UIMessageChunk> {
    const state = this.state;
    const baseURL = apiClientManager.baseURL ?? "https://api.trigger.dev";
    const accessToken = apiClientManager.accessToken ?? "";
    const onTurnComplete = this.onTurnComplete;
    const chatId = this.chatId;

    const internalAbort = new AbortController();
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, internalAbort.signal])
      : internalAbort.signal;

    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          if (options?.sendStopOnAbort !== false) {
            state.skipToTurnComplete = true;
            const api = new ApiClient(baseURL, accessToken);
            api
              .appendToSessionStream(
                chatId,
                "in",
                serializeInputChunk({ kind: "stop" })
              )
              .catch(() => {});
          }
          internalAbort.abort();
        },
        { once: true }
      );
    }

    const streamUrl = `${baseURL}/realtime/v1/sessions/${encodeURIComponent(chatId)}/out`;

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        try {
          const subscription = new SSEStreamSubscription(streamUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            signal: combinedSignal,
            timeoutInSeconds: this.streamTimeoutSeconds,
            lastEventId: state.lastEventId,
          });
          const sseStream = await subscription.subscribe();
          const reader = sseStream.getReader();

          try {
            while (true) {
              const next = await reader.read();
              if (next.done) {
                controller.close();
                return;
              }

              if (combinedSignal.aborted) {
                internalAbort.abort();
                await reader.cancel();
                controller.close();
                return;
              }

              const value = next.value;

              if (value.id) state.lastEventId = value.id;

              // Trigger control records (turn-complete, upgrade-required)
              // route by header — see `client-protocol.mdx`. Their bodies
              // are empty; everything substantive is on `value.headers`.
              //
              // Cross-version bridge: an old agent SDK still writing
              // turn-complete / upgrade-required as `chunk.type` data
              // records would otherwise stall this loop. Fall back to
              // the legacy chunk-type form when no header is present
              // so the deploy-skew window between an `AgentChat`
              // consumer and a not-yet-redeployed agent doesn't hang.
              let controlValue = controlSubtype(value.headers);
              if (!controlValue && value.chunk && typeof value.chunk === "object") {
                const chunk = value.chunk as { type?: unknown };
                if (chunk.type === "trigger:turn-complete") {
                  controlValue = TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE;
                } else if (chunk.type === "trigger:upgrade-required") {
                  controlValue = TRIGGER_CONTROL_SUBTYPE.UPGRADE_REQUIRED;
                } else if (typeof chunk.type === "string" && chunk.type.startsWith("trigger:")) {
                  // Future / unknown `trigger:*` legacy control type —
                  // drop so it doesn't leak as a UIMessageChunk.
                  continue;
                }
              }

              if (state.skipToTurnComplete) {
                if (controlValue === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
                  state.skipToTurnComplete = false;
                }
                continue;
              }

              if (controlValue === TRIGGER_CONTROL_SUBTYPE.UPGRADE_REQUIRED) {
                // Server has already triggered the new run via
                // `end-and-continue`; v2's chunks arrive on the same
                // S2 stream. Filter the marker for cleanliness and
                // keep reading.
                continue;
              }

              if (controlValue === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
                // Customer's callback may be async (e.g. persisting
                // lastEventId to a DB). Wrap so a rejected Promise
                // doesn't surface as an unhandled rejection — that
                // would crash Node under `--unhandled-rejections=throw`.
                Promise.resolve(
                  onTurnComplete?.({
                    chatId,
                    lastEventId: state.lastEventId,
                  })
                ).catch(() => {});
                internalAbort.abort();
                try {
                  controller.close();
                } catch {
                  // Controller may already be closed
                }
                return;
              }

              // Data record — `value.chunk` is the parsed UIMessageChunk
              // (the SSE parser does the JSON envelope unwrap). Drop
              // empty/malformed payloads defensively.
              if (value.chunk == null) continue;
              controller.enqueue(value.chunk as UIMessageChunk);
            }
          } catch (readError) {
            reader.releaseLock();
            throw readError;
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            try {
              controller.close();
            } catch {
              // Controller may already be closed
            }
            return;
          }
          controller.error(error);
        }
      },
    });
  }
}

/**
 * Serialize a {@link ChatInputChunk} for `POST …/sessions/:session/:io/append`.
 * Session channel records are raw JSON strings — the server wraps them
 * in `{ data: <body>, id }` for S2 storage and the subscribe side
 * parses the string back for consumers.
 */
function serializeInputChunk(chunk: ChatInputChunk): string {
  return JSON.stringify(chunk);
}
