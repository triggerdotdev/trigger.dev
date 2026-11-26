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

import type { Task } from "@trigger.dev/core/v3";
import type { ModelMessage, UIMessage, UIMessageChunk } from "ai";
// `readUIMessageStream` is a runtime value — via the ESM/CJS shim so the CJS
// build can `require` ESM-only `ai@7` (see ../imports/ai-runtime.ts).
import { readUIMessageStream } from "../imports/ai-runtime.js";
import {
  apiClientManager,
  controlSubtype,
  ReadSessionStreamRecordsResponseBody,
  SDK_CREDENTIAL_OPERATION_HEADER,
  SDK_CREDENTIAL_REASON_HEADER,
  SSEStreamSubscription,
  TRIGGER_CONTROL_SUBTYPE,
  TRIGGER_TURN_MARKER_SUBTYPE,
} from "@trigger.dev/core/v3";
import type { ChatInputChunk, ChatTaskWirePayload } from "./ai-shared.js";
import {
  appendedInSeq,
  boundaryInCursor,
  chatRunTags,
  isBoundaryBeforeSend,
  MAX_EOF_RESUBSCRIBES,
  PENDING_MESSAGE_INJECTED_TYPE,
  slimSubmitMessageForWire,
  turnJoinCovers,
  turnJoinInjectionId,
  turnStartInSeq,
  waitBeforeEofResubscribe,
} from "./ai-shared.js";
import { triggerConcurrencyBody } from "./concurrency-shared.js";
import { sessions, type SessionTriggerConfigInput } from "./sessions.js";

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
  T extends Task<any, ChatTaskWirePayload<infer TUIMessage, any>, any> ? TUIMessage : UIMessage;

// ─── Types ─────────────────────────────────────────────────────────

/** Persistable session state — store this to resume across requests. */
export type ChatSession = {
  /** Last SSE event ID seen on `session.out` — used to resume without replay. */
  lastEventId?: string;
};

/**
 * Discriminator passed to per-endpoint `baseURL` and `fetch` callbacks on
 * `AgentChat`. Same shape as the type on `TriggerChatTransport` — these
 * mirror so customers can share a single resolver between the two clients.
 */
type AgentChatEndpoint = "in" | "out";

type AgentChatEndpointContext = {
  endpoint: AgentChatEndpoint;
  chatId: string;
};

type AgentChatBaseURLResolver = (ctx: AgentChatEndpointContext) => string;

type AgentChatFetchOverride = (
  url: string,
  init: RequestInit,
  ctx: AgentChatEndpointContext
) => Promise<Response>;

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
  onTurnComplete?: (event: { chatId: string; lastEventId?: string }) => void | Promise<void>;
  /** SSE timeout in seconds. @default 120 */
  streamTimeoutSeconds?: number;
  /**
   * Default trigger config used when starting a new session for this
   * chat. Folded into `sessions.start({...triggerConfig})` body.
   */
  triggerConfig?: SessionTriggerConfigInput;
  /**
   * Override the Trigger.dev API base URL for the chat's `.in/append` and
   * `.out` SSE endpoints. String form applies to both; pass a function to
   * pick per endpoint. Defaults to `apiClientManager.baseURL` (whatever
   * `@trigger.dev/sdk` was configured with — typically `TRIGGER_API_URL`
   * env var).
   *
   * Session creation (`POST /api/v1/sessions`) and token mint
   * (`POST /api/v1/auth/public-tokens`) still flow through
   * `apiClientManager` — pass equivalent options to
   * `chat.createStartSessionAction` if you need those routed too.
   */
  baseURL?: string | AgentChatBaseURLResolver;
  /**
   * Optional per-request fetch override. Receives the resolved URL, the
   * RequestInit, and endpoint context. Use this for header injection
   * (tracing), proxy routing, or custom retries. Applies to both the
   * `.in/append` POSTs and the `.out` SSE GET.
   */
  fetch?: AgentChatFetchOverride;
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
 * - `yield* stream.messages()` — UIMessage snapshots (short replies only)
 *
 * To stream a sub-agent through a parent tool call, pass the stream to
 * `chat.forwardSubAgent` from `@trigger.dev/sdk/ai`.
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
   * Yields the accumulated UIMessage after almost every chunk.
   *
   * Every snapshot repeats the whole message so far, so yielding them as
   * preliminary tool results writes bytes in proportion to the square of the
   * reply length: a sub-agent reply with a few large tool results can write
   * hundreds of MB. Use `chat.forwardSubAgent(stream, { toolCallId })` from
   * `@trigger.dev/sdk/ai` to stream a sub-agent through a parent tool call.
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

/**
 * Page budget for the records drain that finds where a cursorless send's turn
 * starts. The agent trims `.out` to about one turn, so one page is the norm.
 */
const MAX_TURN_START_PAGES = 4;

/** Per request: a page of at most a turn's records is normally back in well under a second. */
const DRAIN_TIMEOUT_MS = 2_000;
const DRAIN_RETRY_DELAY_MS = 200;
/**
 * For the whole turn-start search, which the per-request timeout alone leaves
 * at pages x attempts x timeout (about 16s). It leaves a slow page and its
 * quick retry room, and caps what a send can wait before its stream opens.
 */
const TURN_START_DEADLINE_MS = 3_000;

/**
 * Statuses that say the server has no records endpoint behind this path (a
 * proxy that only forwards the streaming one), as opposed to a failure worth
 * holding the answer back for.
 */
const RECORDS_UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

class OutRecordsUnsupportedError extends Error {}

/** What the turn-start search found. */
type TurnStartSearch =
  | { kind: "found"; cursor: number | undefined; hold: boolean }
  | { kind: "unsupported" }
  | { kind: "failed" };

/**
 * The earlier of two event ids, where no id is the start of the retained
 * output, before every id.
 */
function earlierEventId(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined || b === undefined) return undefined;
  const x = Number(a);
  const y = Number(b);
  return Number.isNaN(x) || Number.isNaN(y) || x <= y ? a : b;
}

/**
 * The later of two event ids, so a cursor never moves backwards when streams of
 * one instance advance it out of order. Ids that aren't numbers take the newer.
 */
function laterEventId(current: string | undefined, next: string): string {
  if (current === undefined) return next;
  const a = Number(current);
  const b = Number(next);
  return Number.isNaN(a) || Number.isNaN(b) || b >= a ? next : current;
}

/** One `.out/records` entry; the turn-start search reads its seq and headers. */
type DrainedRecord = ReadSessionStreamRecordsResponseBody["records"][number];

type SessionState = {
  lastEventId?: string;
  skipToTurnComplete?: boolean;
  /** True after the session has been started (sessions.start). */
  started: boolean;
  /**
   * True once THIS instance has written the session's `triggerConfig`.
   *
   * Separate from {@link started} because a restored session is already
   * started, by an earlier request, under whatever config that release
   * resolved. Only `sessions.start` refreshes the stored config, so without a
   * flag of its own a persisted conversation keeps the deployment pin it was
   * created with for the rest of its life.
   */
  pinRefreshed: boolean;
  /**
   * True when THIS instance created the session, so its `.out` held nothing
   * before our first send. Any other session may retain earlier turns, which a
   * read that has no cursor replays ahead of the turn it asked for.
   */
  outStartedEmpty?: boolean;
  /** `.in` seq of the last send this instance made, until that turn's boundary is read. */
  activeInputSeq?: number;
  /**
   * The last turn boundary this instance read, with the `.in` cursor it carried:
   * proof of where the agent stood when it ended, for the send that follows.
   */
  boundaryProof?: { eventId: string; inCursor: number };
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
  private readonly triggerConfigDefault: SessionTriggerConfigInput | undefined;
  private readonly onTriggered: AgentChatOptions["onTriggered"];
  private readonly onTurnComplete: AgentChatOptions["onTurnComplete"];
  private readonly baseURLResolver: AgentChatBaseURLResolver;
  private readonly fetchOverride: AgentChatFetchOverride | undefined;

  private state: SessionState;
  /** The records endpoint is unsupported on this path; warned once. */
  private warnedOutRecordsUnsupported = false;
  /**
   * Where each response stream still reading began. Streams of one instance
   * share `state.lastEventId`, which one of them advances past records another
   * has yet to read, so a stream opened while others are live starts from the
   * earliest of them and picks out its own turn from there.
   */
  private readonly streamStarts = new Map<number, string | undefined>();
  /**
   * Which subscription armed `skipToTurnComplete`, so only that stream ends at
   * the gated boundary. A later stream reads the same boundary as stale history
   * and keeps reading to its own turn. Deliberately not in `state`: a stop does
   * not outlive the process that issued it.
   */
  private streamSeq = 0;
  private stoppedStreamId: number | undefined;

  constructor(options: AgentChatOptions<TAgent>) {
    this.taskId = options.agent;
    this.chatId = options.id ?? crypto.randomUUID();
    this.streamTimeoutSeconds = options.streamTimeoutSeconds ?? 120;
    this.clientData = options.clientData as Record<string, unknown> | undefined;
    this.triggerConfigDefault = options.triggerConfig;
    this.onTriggered = options.onTriggered;
    this.onTurnComplete = options.onTurnComplete;
    const baseURLOption = options.baseURL;
    this.baseURLResolver =
      typeof baseURLOption === "function"
        ? baseURLOption
        : () => baseURLOption ?? apiClientManager.baseURL ?? "https://api.trigger.dev";
    this.fetchOverride = options.fetch;

    // Hydration: a non-empty `session` means the caller knows the
    // session already exists (started in a previous request). Mark
    // `started` so we don't re-`sessions.start()` on first message.
    const hydrated = !!options.session;
    this.state = {
      lastEventId: options.session?.lastEventId,
      started: hydrated,
      pinRefreshed: !hydrated,
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
  async sendMessage(text: string, options?: { abortSignal?: AbortSignal }): Promise<ChatStream> {
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
    messages:
      | UIMessage[]
      | Array<{
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
    // boot (or `hydrateMessages` if registered).
    //
    // For `submit-message`, assistant messages carrying resolved tool parts
    // (HITL `addToolOutput` answers) are slimmed to just the resolution
    // payload — reasoning blobs, text, and tool `input` come from the
    // agent's authoritative chain. `regenerate-message` omits `message`.
    if (triggerType === "submit-message" && messages.length === 0) {
      throw new Error("AgentChat.sendRaw: 'submit-message' trigger requires at least one message");
    }
    const lastIfSubmit =
      triggerType === "submit-message"
        ? slimSubmitMessageForWire(messages.at(-1) as UIMessage | undefined)
        : undefined;
    const payload: ChatTaskWirePayload = {
      ...(lastIfSubmit ? { message: lastIfSubmit } : {}),
      chatId: this.chatId,
      trigger: triggerType,
      metadata: this.clientData,
    } as ChatTaskWirePayload;

    const inSeq = await this.appendInputChunk(serializeInputChunk({ kind: "message", payload }));
    // An earlier send of this instance whose boundary has not been read (still
    // streaming, or cancelled mid-turn): the cursor may sit inside its turn, so
    // unmarked chunks ahead of this send's own turn can belong to it.
    const earlierSendUnread = this.state.activeInputSeq !== undefined;
    this.state.activeInputSeq = inSeq;
    const holdUntilBoundary =
      (await this.locateTurnStart(inSeq, options?.abortSignal)) || earlierSendUnread;

    return this.subscribeToSessionStream(options?.abortSignal, {
      resumeAfterEof: true,
      sinceInSeq: inSeq,
      holdUntilBoundary,
    });
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
      await this.appendInputChunk(serializeInputChunk({ kind: "message", payload }));
      return true;
    } catch {
      return false;
    }
  }

  /** Stop the current generation (agent stays alive for next turn). */
  async stop(): Promise<void> {
    if (!this.state.started) return;

    this.state.skipToTurnComplete = true;
    this.stoppedStreamId = this.streamSeq;
    await this.appendInputChunk(serializeInputChunk({ kind: "stop" })).catch(() => {});
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
    await this.appendInputChunk(
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
    await this.appendInputChunk(serializeInputChunk({ kind: "handover-skip" }));
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
  async sendAction(action: unknown, options?: { abortSignal?: AbortSignal }): Promise<ChatStream> {
    await this.ensureStarted();

    const payload: ChatTaskWirePayload = {
      chatId: this.chatId,
      trigger: "action" as const,
      action,
      metadata: this.clientData,
    };

    let inSeq: number | undefined;
    try {
      inSeq = await this.appendInputChunk(serializeInputChunk({ kind: "message", payload }));
    } catch {
      throw new Error("Failed to send action. The session may have ended.");
    }
    // An earlier send of this instance whose boundary has not been read (still
    // streaming, or cancelled mid-turn): the cursor may sit inside its turn, so
    // unmarked chunks ahead of this send's own turn can belong to it.
    const earlierSendUnread = this.state.activeInputSeq !== undefined;
    this.state.activeInputSeq = inSeq;
    const holdUntilBoundary =
      (await this.locateTurnStart(inSeq, options?.abortSignal)) || earlierSendUnread;

    const rawStream = this.subscribeToSessionStream(options?.abortSignal, {
      resumeAfterEof: true,
      sinceInSeq: inSeq,
      holdUntilBoundary,
    });
    return new ChatStream(rawStream);
  }

  /** Close the conversation — agent exits its loop gracefully. */
  async close(): Promise<boolean> {
    if (!this.state.started) return false;

    try {
      await this.appendInputChunk(
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

  /**
   * Reconnect to the response stream to resume an already-established session
   * after a disconnect. Requests the caught-up settle probe (`X-Peek-Settled`)
   * so a resumed stream already at a turn-complete tail closes promptly instead
   * of holding the full SSE window, mirroring the browser transport's
   * `reconnectToStream`.
   *
   * Do not call this immediately after `sendMessage()` to read a fresh turn: the
   * settle probe can race the newly-triggered turn's first record, see the prior
   * turn's `turn-complete` tail, and hand back an empty stream (unlike the
   * browser transport, there is no auto-resubscribe). `sendMessage()` already
   * returns the turn's stream; use `reconnect()` only to resume an idle or
   * mid-turn stream.
   */
  async reconnect(abortSignal?: AbortSignal): Promise<ReadableStream<UIMessageChunk> | null> {
    if (!this.state.started) return null;
    return this.subscribeToSessionStream(abortSignal, {
      sendStopOnAbort: false,
      peekSettled: true,
      // Resuming a turn this instance sent: keep to that turn's boundary.
      sinceInSeq: this.state.activeInputSeq,
    });
  }

  // ─── Private ───────────────────────────────────────────────────

  private resolveBaseURL(endpoint: AgentChatEndpoint): string {
    return this.baseURLResolver({ endpoint, chatId: this.chatId }).replace(/\/$/, "");
  }

  private async doFetch(
    ctx: AgentChatEndpointContext,
    url: string,
    init: RequestInit
  ): Promise<Response> {
    return this.fetchOverride ? this.fetchOverride(url, init, ctx) : fetch(url, init);
  }

  /**
   * A send with no cursor on a session this instance did not create would read
   * `.out` from the oldest retained record, replaying earlier turns ahead of
   * its own. Drain the retained records once (`wait=0`, bounded pages) and find
   * the last boundary of a turn before this send's `.in` seq: that becomes the
   * cursor, so the stream starts where the unanswered work does.
   *
   * Returns whether the stream must hold unmarked chunks until a boundary says
   * whose they are. That is the case for an agent that doesn't mark where each
   * turn starts, when something unanswered may sit between the last earlier
   * boundary and this send (its `session-in-event-id` is below the send's seq
   * minus one), or when the drain can't tell: it failed, the server predates
   * record headers, a boundary carries no `.in` cursor, or the search ran past
   * its deadline. A server with no records endpoint on this path (a proxy that
   * only forwards the stream) holds too, with one warning. A caller abort ends
   * the search at once and also holds; the stream then posts the stop, as for
   * any abort.
   */
  private async locateTurnStart(
    inSeq: number | undefined,
    abortSignal: AbortSignal | undefined
  ): Promise<boolean> {
    const state = this.state;
    if (inSeq === undefined) return false;
    // The session was created by this instance and nothing has been read yet:
    // nothing earlier exists.
    if (state.outStartedEmpty && state.lastEventId === undefined) return false;
    if (state.lastEventId !== undefined) {
      // A saved cursor says where the reader stopped, not whose turn comes next:
      // a replacement run can have replayed other messages' turns after it. An
      // agent that marks its turns says so as it goes. For one that doesn't, the
      // records are this send's only with proof, which this instance has when its
      // own last boundary is the cursor and the agent had answered everything
      // before this send's message by then. Without it the stream holds unmarked
      // records until a boundary says whose they are.
      const proof = state.boundaryProof;
      return !(proof && proof.eventId === state.lastEventId && proof.inCursor === inSeq - 1);
    }
    // A stop is outstanding: the stream below skips records up to the stopped
    // turn's boundary, which is only right when it reads from before that
    // boundary. A cursor past it would have the gate swallow this turn instead.
    if (state.skipToTurnComplete) return true;
    // The drain does its own `fetch`; a caller routing `.out` through its own
    // fetch gets the fallback rather than a request that skips it.
    if (this.fetchOverride) return true;

    const found = await this.searchTurnStart(inSeq, abortSignal);
    // A stop can land while the drain is in flight, after the check above; the
    // cursor it found may then sit past the stopped turn's boundary. A caller
    // abort is the same: the stream below posts the stop for it.
    if (state.skipToTurnComplete || abortSignal?.aborted) return true;
    if (found.kind === "unsupported") {
      if (!this.warnedOutRecordsUnsupported) {
        this.warnedOutRecordsUnsupported = true;
        console.warn(
          `AgentChat: reading the chat's earlier output isn't supported by this server or proxy, ` +
            `so a send without \`session.lastEventId\` reads from the start of the retained output. ` +
            `With an agent on an older SDK version the reply is held until its turn completes. ` +
            `Pass \`session.lastEventId\` to avoid reading earlier turns.`
        );
      }
      // Nothing proves which records are this send's, so unmarked ones are held
      // until a turn-start marker or a boundary says whose they are.
      return true;
    }
    if (found.kind === "failed") return true;
    // Another stream of this instance may have moved the cursor while the drain
    // ran; it only ever moves forward.
    if (found.cursor !== undefined) {
      state.lastEventId = laterEventId(state.lastEventId, String(found.cursor));
    }
    return found.hold;
  }

  /**
   * Drain the retained records for the last boundary of a turn before `inSeq`.
   * The send's turn is then everything after it when that boundary's
   * `session-in-event-id` is `inSeq - 1`: the agent holds that cursor behind any
   * message it has not answered yet, so nothing unanswered sits between the two.
   * A lower one means earlier messages are still waiting, and their turns are
   * ahead of this one.
   */
  private async searchTurnStart(
    inSeq: number,
    abortSignal: AbortSignal | undefined
  ): Promise<TurnStartSearch> {
    // One deadline for the whole search, ended with the caller's own abort.
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), TURN_START_DEADLINE_MS);
    const signal = abortSignal ? AbortSignal.any([abortSignal, deadline.signal]) : deadline.signal;
    try {
      let after: string | undefined;
      let earlierBoundary: number | undefined;
      let earlierCursor: number | undefined;
      let chunksSinceBoundary = false;
      // A `turn-join` folded my message into the turn now being read, so its
      // boundary closes my turn even when its cursor sits below my seq.
      let joinedMyTurn = false;
      const found = (): TurnStartSearch => ({
        kind: "found",
        cursor: earlierBoundary,
        hold: earlierCursor !== inSeq - 1,
      });

      for (let page = 0; page < MAX_TURN_START_PAGES; page++) {
        const records = await this.drainOutRecords(after, signal);
        if (records.length === 0) {
          // Caught up with the tail without meeting a boundary of this turn.
          // Nothing retained after the last boundary: nothing to tell apart.
          return chunksSinceBoundary
            ? found()
            : { kind: "found", cursor: earlierBoundary, hold: false };
        }
        for (const record of records) {
          const subtype = controlSubtype(record.headers);
          if (subtype === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
            const cursor = boundaryInCursor(record.headers);
            // This turn's own boundary (already written). One that closes the
            // turn my message was folded into is mine too: an input or queued
            // action ahead of mine can still be owed, so it carries a lower cursor.
            if (joinedMyTurn || (cursor !== undefined && cursor >= inSeq)) return found();
            earlierBoundary = record.seqNum;
            earlierCursor = cursor;
            chunksSinceBoundary = false;
          } else if (subtype === TRIGGER_TURN_MARKER_SUBTYPE.TURN_JOIN) {
            if (turnJoinCovers(record.headers, inSeq)) joinedMyTurn = true;
          } else if (subtype === TRIGGER_TURN_MARKER_SUBTYPE.TURN_START) {
            joinedMyTurn = false;
          } else if (subtype === undefined && record.headers?.[0]?.[0] !== "") {
            // A data record; other control records and S2 commands say nothing.
            chunksSinceBoundary = true;
          }
        }
        // The server sets no page size, so only an empty page is the tail.
        after = String(records[records.length - 1]!.seqNum);
      }
      return { kind: "failed" };
    } catch (error) {
      return error instanceof OutRecordsUnsupportedError
        ? { kind: "unsupported" }
        : { kind: "failed" };
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  /**
   * The data chunks of the records from `fromSeq` up to (not including) `toSeq`:
   * a turn this stream dropped as another's and then found had answered its own
   * message. Bounded like the turn-start search; a read that fails or isn't
   * served returns what it has, which degrades to the send ending empty.
   */
  private async readTurnBack(
    fromSeq: number,
    toSeq: number,
    signal: AbortSignal
  ): Promise<UIMessageChunk[]> {
    const chunks: UIMessageChunk[] = [];
    // The route takes digits only, so a turn starting at seq 0 reads from the start.
    let after: string | undefined = fromSeq > 0 ? String(fromSeq - 1) : undefined;
    try {
      for (let page = 0; page < MAX_TURN_START_PAGES; page++) {
        const records = await this.drainOutRecords(after, signal);
        if (records.length === 0) break;
        for (const record of records) {
          if (record.seqNum >= toSeq) return chunks;
          if (record.headers && record.headers.length > 0) continue;
          if (record.data && typeof record.data === "object") {
            chunks.push(record.data as UIMessageChunk);
          }
        }
        after = String(records[records.length - 1]!.seqNum);
      }
    } catch {
      // Not readable: the send ends without that turn's output.
    }
    return chunks;
  }

  /**
   * One page of `GET .../out/records` (the `wait=0` drain). It sits in front of
   * a send's stream, so it gets a short timeout and at most one quick retry on a
   * 5xx or a network error; anything else, or `signal` aborting, fails at once
   * and the caller falls back to holding chunks.
   *
   * This stays a direct request rather than `apiClient.readSessionStreamRecords`:
   * that call takes no abort signal and runs the API client's retry schedule
   * with no per-request timeout, so it can't be bounded by a caller's abort or
   * this search's deadline without widening core's public API. The response is
   * checked with the same schema core uses for it.
   */
  private async drainOutRecords(
    afterEventId: string | undefined,
    signal: AbortSignal
  ): Promise<DrainedRecord[]> {
    const headers: Record<string, string> = {
      ...apiClientManager.clientOrThrow().getAuthenticationHeaders("readSessionStreamRecords"),
      "x-trigger-source": "sdk",
    };
    const branch = apiClientManager.branchName;
    if (branch) headers["x-trigger-branch"] = branch;
    const query =
      afterEventId !== undefined ? `?afterEventId=${encodeURIComponent(afterEventId)}` : "";
    const url = `${this.resolveBaseURL("out")}/realtime/v1/sessions/${encodeURIComponent(this.chatId)}/out/records${query}`;

    for (let attempt = 0; ; attempt++) {
      let retryable = true;
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(DRAIN_TIMEOUT_MS)]),
        });
        if (response.ok) {
          const body = ReadSessionStreamRecordsResponseBody.safeParse(await response.json());
          // A malformed body is not worth a retry.
          if (!body.success) {
            retryable = false;
            throw new Error("Unexpected records response");
          }
          return body.data.records;
        }
        await response.body?.cancel().catch(() => {});
        if (RECORDS_UNSUPPORTED_STATUSES.has(response.status)) {
          retryable = false;
          throw new OutRecordsUnsupportedError(`No .out/records endpoint: ${response.status}`);
        }
        retryable = response.status >= 500;
        throw new Error(`Reading the .out records failed: ${response.status}`);
      } catch (error) {
        if (!retryable || attempt > 0 || signal.aborted) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, DRAIN_RETRY_DELAY_MS));
    }
  }

  /** Resolves to the appended record's `.in` seq, when the server reports one. */
  private async appendInputChunk(body: string): Promise<number | undefined> {
    const authHeaders = apiClientManager
      .clientOrThrow()
      .getAuthenticationHeaders("appendToSessionStream");
    const ctx: AgentChatEndpointContext = { endpoint: "in", chatId: this.chatId };
    const url = `${this.resolveBaseURL("in")}/realtime/v1/sessions/${encodeURIComponent(this.chatId)}/in/append`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...authHeaders,
      "x-trigger-source": "sdk",
      // Idempotency key: the server skips appends whose part id it has
      // already committed, so a retried POST can't duplicate the record.
      "X-Part-Id": crypto.randomUUID(),
    };
    // Preview-env sessions are branch-scoped, so the realtime in/out calls must
    // carry the branch the session was created on. sessions.start sends it via
    // the API client; these raw fetches have to set it themselves.
    const branch = apiClientManager.branchName;
    if (branch) headers["x-trigger-branch"] = branch;
    const response = await this.doFetch(ctx, url, { method: "POST", headers, body });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Match the error shape that ApiClient/zodfetch produced before the
      // inline-POST refactor so callers inspecting `error.name ===
      // "TriggerApiError"` or `error.status` keep working.
      const err = new Error(`appendToSessionStream failed: ${response.status} ${text}`) as Error & {
        name: string;
        status: number;
      };
      err.name = "TriggerApiError";
      err.status = response.status;
      throw err;
    }
    const data = (await response.json().catch(() => undefined)) as { seq?: unknown } | undefined;
    return appendedInSeq(data);
  }

  /**
   * Idempotent: `sessions.start` upserts on `(env, externalId)`. Two
   * concurrent AgentChat instances on the same chatId converge to the
   * same session.
   */
  private async ensureStarted(options?: { idleTimeoutInSeconds?: number }): Promise<void> {
    if (this.state.started && this.state.pinRefreshed) return;

    const idleTimeoutInSeconds =
      options?.idleTimeoutInSeconds ?? this.triggerConfigDefault?.idleTimeoutInSeconds;

    const triggerConfig: SessionTriggerConfigInput = {
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
      ...(this.triggerConfigDefault?.machine ? { machine: this.triggerConfigDefault.machine } : {}),
      ...(this.triggerConfigDefault?.queue ? { queue: this.triggerConfigDefault.queue } : {}),
      ...(this.triggerConfigDefault?.concurrency !== undefined
        ? triggerConcurrencyBody(this.triggerConfigDefault.concurrency)
        : {}),
      ...(this.triggerConfigDefault?.concurrencyKey !== undefined
        ? { concurrencyKey: this.triggerConfigDefault.concurrencyKey }
        : {}),
      tags: chatRunTags(this.chatId, this.triggerConfigDefault?.tags),
      ...(this.triggerConfigDefault?.maxAttempts !== undefined
        ? { maxAttempts: this.triggerConfigDefault.maxAttempts }
        : {}),
      ...(this.triggerConfigDefault?.maxDuration !== undefined
        ? { maxDuration: this.triggerConfigDefault.maxDuration }
        : {}),
      ...(this.triggerConfigDefault?.region ? { region: this.triggerConfigDefault.region } : {}),
      ...(this.triggerConfigDefault?.lockToVersion
        ? { lockToVersion: this.triggerConfigDefault.lockToVersion }
        : {}),
      ...(this.triggerConfigDefault?.ttl !== undefined
        ? { ttl: this.triggerConfigDefault.ttl }
        : {}),
      // Not truthiness: `null` opts out and must reach the resolver in `sessions.start`.
      ...(this.triggerConfigDefault?.externalDeploymentId !== undefined
        ? { externalDeploymentId: this.triggerConfigDefault.externalDeploymentId }
        : {}),
      ...(idleTimeoutInSeconds !== undefined ? { idleTimeoutInSeconds } : {}),
    };

    const created = await sessions.start({
      type: "chat.agent",
      externalId: this.chatId,
      taskIdentifier: this.taskId,
      triggerConfig,
    });

    const wasInitialStart = !this.state.started;
    this.state.started = true;
    this.state.pinRefreshed = true;
    if (wasInitialStart) this.state.outStartedEmpty = created.isCached === false;

    // `onTriggered` is documented as the initial start, so a restored session
    // refreshing its config does not fire it: the caller handed us that
    // session, and a hook that writes a row would write it again on every
    // request that rehydrates the conversation.
    if (wasInitialStart) {
      await this.onTriggered?.({
        runId: created.runId,
        chatId: this.chatId,
      });
    }
  }

  private subscribeToSessionStream(
    abortSignal: AbortSignal | undefined,
    options?: {
      sendStopOnAbort?: boolean;
      peekSettled?: boolean;
      resumeAfterEof?: boolean;
      /** `.in` seq of the send this stream answers; boundaries below it are earlier turns'. */
      sinceInSeq?: number;
      /** Hold chunks until a boundary says whose they are (see `locateTurnStart`). */
      holdUntilBoundary?: boolean;
    }
  ): ReadableStream<UIMessageChunk> {
    const state = this.state;
    const streamId = ++this.streamSeq;
    const sinceInSeq = options?.sinceInSeq;
    // Without a cursor the read starts at the oldest retained record, so it
    // replays earlier turns ahead of this one. Chunks carry no turn marker, so
    // the fallback is to hold them until a boundary says whose they are: an
    // earlier turn's are dropped, this turn's flushed. A send first tries to
    // find where its turn starts (`locateTurnStart`) and streams live from
    // there; a session this instance just created has nothing earlier.
    let startCursor = state.lastEventId;
    for (const other of this.streamStarts.values())
      startCursor = earlierEventId(startCursor, other);
    this.streamStarts.set(streamId, startCursor);
    const holdUntilBoundary =
      (options?.holdUntilBoundary ??
        (sinceInSeq !== undefined && state.lastEventId === undefined && !state.outStartedEmpty)) ||
      // Reading from before this instance's own cursor, past records of a send it
      // already made: unmarked chunks there are not necessarily this send's.
      (sinceInSeq !== undefined && startCursor !== state.lastEventId);
    const held: UIMessageChunk[] = [];
    // Whose turn the records being read belong to, as the agent's `turn-start`
    // marker says (an agent that writes none leaves it "unknown"). Another
    // message's turn is dropped as it streams, never buffered; this send's is
    // delivered live from its marker. Reset at each boundary.
    //
    // "joining": my message was folded into the running turn. The records that
    // follow can still include the previous step's batched tail, so I start at
    // the next step, where the injected message first shapes the output.
    let owner: "mine" | "other" | "joining" | "unknown" = "unknown";
    // With "joining": the injection chunk the join record names, which ends the
    // previous step's tail (undefined: the record names none, start at a step).
    let joinInjectionId: string | undefined;
    // Where the turn I am dropping began, to read it back if it turns out to
    // have answered my message after all (see the boundary below).
    let droppedFrom: number | undefined;
    // While holding, the position the next read resumes from. `state.lastEventId`
    // is the caller's persisted cursor and must not move past chunks that were
    // never delivered, so it only catches up when they are flushed or dropped.
    let readCursor = startCursor;
    // A stop was outstanding when I subscribed and it isn't mine: my window
    // replays the stopped turn's tail, so I drop records up to and including
    // its boundary. Captured per subscription — the stopped stream is still
    // live and may consume the shared seed before I reach that record.
    let skipStaleBoundary = state.skipToTurnComplete === true && this.stoppedStreamId !== streamId;
    const apiClient = apiClientManager.clientOrThrow();
    const onTurnComplete = this.onTurnComplete;
    const chatId = this.chatId;
    const sseCtx: AgentChatEndpointContext = { endpoint: "out", chatId };
    const fetchOverride = this.fetchOverride;
    const sseFetchClient: typeof fetch = (input, init) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      headers.delete(SDK_CREDENTIAL_OPERATION_HEADER);
      headers.delete(SDK_CREDENTIAL_REASON_HEADER);
      for (const [key, value] of Object.entries(
        apiClient.getAuthenticationHeaders("subscribeToSessionStream")
      )) {
        headers.set(key, value);
      }
      init = { ...init, headers };
      if (fetchOverride) {
        if (typeof input === "string") {
          return fetchOverride(input, init ?? {}, sseCtx);
        }
        if (input instanceof URL) {
          return fetchOverride(input.toString(), init ?? {}, sseCtx);
        }
        // Request — preserve its url + intrinsic init, let any provided
        // init override on top (matches fetch(Request, init) semantics).
        return fetchOverride(
          input.url,
          {
            method: input.method,
            headers: input.headers,
            signal: input.signal,
            ...(init ?? {}),
          },
          sseCtx
        );
      }
      return fetch(input, init);
    };

    const internalAbort = new AbortController();
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, internalAbort.signal])
      : internalAbort.signal;

    // Detached once the stream ends (see the `finally` below): a caller reusing
    // one signal across turns would otherwise stack listeners, and a late abort
    // would post a stop that gates the next turn.
    const onExternalAbort = () => {
      if (options?.sendStopOnAbort !== false) {
        state.skipToTurnComplete = true;
        this.stoppedStreamId = streamId;
        this.appendInputChunk(serializeInputChunk({ kind: "stop" })).catch(() => {});
      }
      internalAbort.abort();
    };
    abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
    // Aborted before this subscription (while the turn's start was being
    // located): the listener never fires, but the turn is already on `.in`.
    if (abortSignal?.aborted) onExternalAbort();

    const streamUrl = `${this.resolveBaseURL("out")}/realtime/v1/sessions/${encodeURIComponent(chatId)}/out`;

    // Resolved when the consumer reads what is queued, or the stream is
    // cancelled or aborted. No timer: nothing outlives a consumer that goes away.
    let notifyDrained: (() => void) | undefined;

    const run = async (controller: ReadableStreamDefaultController<UIMessageChunk>) => {
      // Waits for the consumer to read everything queued, so a stream that must
      // end in an error delivers what it already produced first (an error
      // discards what is still queued).
      const untilDrained = () =>
        new Promise<void>((resolve) => {
          if ((controller.desiredSize ?? 1) >= 1 || combinedSignal.aborted) return resolve();
          notifyDrained = resolve;
          combinedSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      let eofResubscribes = 0;
      let sawLiveTurn = false;
      const closeController = () => {
        try {
          controller.close();
        } catch {
          // Controller may already be closed
        }
      };
      // Nothing is undelivered past the cursor once held chunks are resolved.
      const settleHeld = (deliver: boolean) => {
        if (deliver) for (const chunk of held) controller.enqueue(chunk);
        held.length = 0;
        if (holdUntilBoundary && readCursor !== undefined) {
          state.lastEventId = laterEventId(state.lastEventId, readCursor);
        }
      };
      const openSubscription = () =>
        new SSEStreamSubscription(streamUrl, {
          headers: {
            // Preview-env sessions are branch-scoped (see appendInputChunk).
            ...(apiClientManager.branchName
              ? { "x-trigger-branch": apiClientManager.branchName }
              : {}),
            ...(options?.peekSettled ? { "X-Peek-Settled": "1" } : {}),
          },
          signal: combinedSignal,
          timeoutInSeconds: this.streamTimeoutSeconds,
          lastEventId: readCursor,
          fetchClient: sseFetchClient,
        });

      try {
        while (true) {
          const subscription = openSubscription();
          const sseStream = await subscription.subscribe();
          const reader = sseStream.getReader();

          try {
            while (true) {
              const next = await reader.read();
              if (next.done) {
                break;
              }

              if (combinedSignal.aborted) {
                internalAbort.abort();
                await reader.cancel();
                closeController();
                return;
              }

              const value = next.value;

              if (value.id) {
                readCursor = value.id;
                // One live stream reads ids in order, so the shared cursor needs no
                // comparison; with several, one may be behind another.
                if (!holdUntilBoundary) {
                  state.lastEventId =
                    this.streamStarts.size === 1
                      ? value.id
                      : laterEventId(state.lastEventId, value.id);
                }
              }
              // Any record re-earns the resubscribe budget: a clean EOF is
              // the normal end of every long-poll window, so a long turn
              // spanning many windows must not exhaust it.
              eofResubscribes = 0;

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

              // A boundary below my send's `.in` seq closed an earlier turn:
              // not mine to close on, and what was held before it is that
              // turn's output. It also is the stale tail the gate below waits
              // for, when a stop left one outstanding. Not when a marker or a
              // join already made this turn mine: its boundary can carry a lower
              // cursor (an input or queued action ahead of mine is still owed),
              // and it is the one to close on.
              if (
                controlValue === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE &&
                ((owner !== "mine" &&
                  owner !== "joining" &&
                  isBoundaryBeforeSend(value.headers, sinceInSeq)) ||
                  // A turn the marker says isn't mine, closing with no cursor (it
                  // answered no `.in` message), is not mine to close on either.
                  (owner === "other" && boundaryInCursor(value.headers) === undefined))
              ) {
                settleHeld(false);
                owner = "unknown";
                if (skipStaleBoundary) {
                  skipStaleBoundary = false;
                  state.skipToTurnComplete = false;
                }
                continue;
              }

              // Stale tail of a turn someone else stopped: swallow it and
              // keep reading to my own turn.
              if (skipStaleBoundary) {
                if (controlValue === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
                  skipStaleBoundary = false;
                  state.skipToTurnComplete = false;
                }
                continue;
              }

              // I am the stopped stream, so this turn is over at its
              // boundary: close rather than resume into windows it will
              // never fill. Keyed on the id alone, so it holds however far
              // the follow-up subscription has got.
              if (this.stoppedStreamId === streamId) {
                if (controlValue === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
                  state.skipToTurnComplete = false;
                  this.stoppedStreamId = undefined;
                  if (state.activeInputSeq === sinceInSeq) state.activeInputSeq = undefined;
                  settleHeld(false);
                  internalAbort.abort();
                  closeController();
                  return;
                }
                continue;
              }

              // The agent says whose turn the records that follow belong to.
              // Nothing held before it can be that turn's (an unmarked turn
              // ends at its boundary), and a reader with no send of its own
              // has no turn to tell apart.
              if (controlValue === TRIGGER_TURN_MARKER_SUBTYPE.TURN_START) {
                if (sinceInSeq !== undefined) {
                  held.length = 0;
                  owner = turnStartInSeq(value.headers) === sinceInSeq ? "mine" : "other";
                  if (owner === "other") droppedFrom = Number(value.id);
                }
                continue;
              }

              // Messages folded into the running turn: what follows answers
              // them. If mine is one, I take the rest of this turn.
              if (controlValue === TRIGGER_TURN_MARKER_SUBTYPE.TURN_JOIN) {
                if (sinceInSeq !== undefined && turnJoinCovers(value.headers, sinceInSeq)) {
                  held.length = 0;
                  owner = "joining";
                  joinInjectionId = turnJoinInjectionId(value.headers);
                }
                continue;
              }

              // Both handover markers mean the turn carries on in a
              // successor run, so they count as a live turn: its chunks
              // may only arrive in a later window.
              if (controlValue === TRIGGER_CONTROL_SUBTYPE.UPGRADE_REQUIRED) {
                // Server has already triggered the new run via
                // `end-and-continue`; v2's chunks arrive on the same
                // S2 stream. Filter the marker for cleanliness and
                // keep reading.
                sawLiveTurn = true;
                continue;
              }

              if (controlValue === TRIGGER_CONTROL_SUBTYPE.PENDING_VERSION) {
                sawLiveTurn = true;
                continue;
              }

              // A standalone session-closed record is written after
              // turn-complete, so only a reconnect ever reads it. The
              // conversation is over: end the stream, no stop, no error.
              if (controlValue === TRIGGER_CONTROL_SUBTYPE.SESSION_CLOSED) {
                internalAbort.abort();
                closeController();
                return;
              }

              if (controlValue === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
                settleHeld(true);
                // The turn I dropped as someone else's closed past my message, so it
                // answered mine (folded in with no marker I could match: a failed
                // marker write, a message the agent read from a recovery). Read its
                // records back, so I end with that turn's output rather than nothing.
                if (
                  owner === "other" &&
                  droppedFrom !== undefined &&
                  Number.isFinite(droppedFrom)
                ) {
                  const end = Number(value.id);
                  for (const chunk of await this.readTurnBack(droppedFrom, end, combinedSignal)) {
                    controller.enqueue(chunk);
                  }
                }
                // Only my own turn's state: a send made since is still pending.
                if (state.activeInputSeq === sinceInSeq) state.activeInputSeq = undefined;
                const settledCursor = boundaryInCursor(value.headers);
                state.boundaryProof =
                  settledCursor !== undefined && value.id
                    ? { eventId: value.id, inCursor: settledCursor }
                    : undefined;
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
                closeController();
                return;
              }

              // Data record — `value.chunk` is the parsed UIMessageChunk
              // (the SSE parser does the JSON envelope unwrap). Drop
              // empty/malformed payloads defensively.
              if (value.chunk == null) continue;
              // Parts and the handover markers above are the only evidence of
              // a live turn. Unknown control records stay neutral: they are no
              // reason for a reconnect to pin another long-poll window.
              sawLiveTurn = true;
              // Another message's turn: not mine, and not worth holding.
              if (owner === "other") continue;
              if (owner === "joining") {
                const joined = value.chunk as { type?: string; id?: string };
                if (joinInjectionId !== undefined) {
                  // The batched tail of the step before the injection can land
                  // after the join record, `start-step` included, so a step
                  // boundary can't tell it from the next step. The injection
                  // chunk is ordered with that tail: the rest of the turn is what
                  // follows it.
                  if (
                    joined.type === PENDING_MESSAGE_INJECTED_TYPE &&
                    joined.id === joinInjectionId
                  )
                    owner = "mine";
                  continue;
                }
                if (joined.type !== "start-step") continue;
                owner = "mine";
              }
              if (holdUntilBoundary && owner === "unknown")
                held.push(value.chunk as UIMessageChunk);
              else {
                controller.enqueue(value.chunk as UIMessageChunk);
                // Delivered live in hold mode (a marker made it mine): nothing
                // held is behind this record, so the saved cursor can pass it and
                // a `reconnect()` doesn't hand it out again.
                if (holdUntilBoundary && readCursor !== undefined) {
                  state.lastEventId = laterEventId(state.lastEventId, readCursor);
                }
              }
            }
          } catch (readError) {
            reader.releaseLock();
            throw readError;
          }
          reader.releaseLock();

          // The body ended without a turn-complete. A turn is in flight
          // either by construction (the send paths) or because records have
          // already flowed on this stream — so unless the server says the
          // session settled we lost the window mid-turn, and resubscribing
          // from the last event id beats truncating the turn. A `reconnect()`
          // that never saw a record can't tell a live turn from a dead
          // session, so it closes rather than pin another long-poll window.
          const turnInFlight = options?.resumeAfterEof || sawLiveTurn;
          if (!turnInFlight || subscription.sessionSettled || combinedSignal.aborted) {
            // No boundary came to say whose they are; a consumer that is still
            // there gets them, as it would have before they were held.
            if (!combinedSignal.aborted) settleHeld(true);
            closeController();
            return;
          }
          if (eofResubscribes >= MAX_EOF_RESUBSCRIBES) {
            // The run is gone mid-turn: what was held back is the partial
            // answer, which a consumer gets ahead of the error as it would
            // had the chunks streamed live.
            if (held.length > 0) {
              settleHeld(true);
              await untilDrained();
              // The caller went away while the chunks were unread: nothing is
              // waiting for an error.
              if (combinedSignal.aborted) {
                closeController();
                return;
              }
            }
            throw new Error(
              "Chat stream ended before the turn completed (reconnect budget exhausted)."
            );
          }
          eofResubscribes++;
          await waitBeforeEofResubscribe(eofResubscribes, combinedSignal);
          if (combinedSignal.aborted) {
            closeController();
            return;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          closeController();
          return;
        }
        controller.error(error);
      } finally {
        abortSignal?.removeEventListener("abort", onExternalAbort);
        this.streamStarts.delete(streamId);
      }
    };

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        void run(controller);
      },
      // A consumer that stops reading must also stop the resubscribe loop —
      // otherwise it keeps reopening a subscription nobody is draining.
      pull: () => {
        notifyDrained?.();
        notifyDrained = undefined;
      },
      cancel: () => {
        // Not still reading from this moment, not when its loop unwinds: a stream
        // opened right after (a `reconnect()`) must start from the shared cursor,
        // not from where this one began.
        this.streamStarts.delete(streamId);
        internalAbort.abort();
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
