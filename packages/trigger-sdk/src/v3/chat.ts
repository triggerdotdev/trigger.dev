/**
 * @module @trigger.dev/sdk/chat
 *
 * Browser-safe module for AI SDK chat transport integration.
 * Use this on the frontend with the AI SDK's `useChat` hook.
 *
 * For backend helpers (`chatAgent`, `pipeChat`), use `@trigger.dev/sdk/ai` instead.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { TriggerChatTransport } from "@trigger.dev/sdk/chat";
 *
 * function Chat() {
 *   const { messages, sendMessage, status } = useChat({
 *     transport: new TriggerChatTransport({
 *       task: "my-chat-task",
 *       accessToken: async ({ chatId }) => fetchSessionToken(chatId),
 *       startSession: async ({ chatId, taskId }) => createChatSession({ chatId, taskId }),
 *     }),
 *   });
 * }
 * ```
 */

import type { ChatTransport, UIMessage, UIMessageChunk, ChatRequestOptions } from "ai";
import {
  ApiClient,
  controlSubtype,
  headerValue,
  PUBLIC_ACCESS_TOKEN_HEADER,
  SSEStreamSubscription,
  TRIGGER_CONTROL_SUBTYPE,
} from "@trigger.dev/core/v3";
import { ChatTabCoordinator } from "./chat-tab-coordinator.js";
import type { ChatInputChunk, ChatTaskWirePayload } from "./ai-shared.js";

const DEFAULT_BASE_URL = "https://api.trigger.dev";
const DEFAULT_STREAM_TIMEOUT_SECONDS = 120;

/**
 * Detect 401/403 from realtime/input-stream calls without relying on `instanceof`
 * (Vitest can load duplicate `@trigger.dev/core` copies, which breaks subclass checks).
 */
function isAuthError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { name?: string; status?: number };
  return e.name === "TriggerApiError" && (e.status === 401 || e.status === 403);
}

/**
 * Parses an SSE byte/text stream of `data: <UIMessageChunk JSON>\n\n`
 * frames back into `UIMessageChunk` objects. Used by the handover
 * first-turn path to convert the customer's route handler response
 * (which is AI-SDK-shaped SSE text) into the chunk form the AI SDK's
 * `useChat` consumes from a transport.
 *
 * Spec-light parser — assumes well-formed `data:` events from our own
 * `chat.handover` SSE writer. Lines starting with `:` (comments) and
 * other event types are ignored.
 */
function parseUIMessageSseTransform(): TransformStream<string, UIMessageChunk> {
  let buffer = "";
  return new TransformStream<string, UIMessageChunk>({
    transform(chunk, controller) {
      buffer += chunk;
      // Frames are separated by blank lines.
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
              controller.enqueue(JSON.parse(data) as UIMessageChunk);
            } catch {
              /* drop malformed chunk; the response source is our own writer */
            }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      // Trailing data without a closing blank line — treat as a final frame.
      if (buffer.trim().length === 0) return;
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            controller.enqueue(JSON.parse(data) as UIMessageChunk);
          } catch {
            /* drop */
          }
        }
      }
      buffer = "";
    },
  });
}

/**
 * Arguments for the `accessToken` callback. The transport invokes this
 * whenever it needs a fresh session-scoped PAT — initial use, and
 * after a 401 from any session-PAT-authed request.
 *
 * The callback's job is to return a token, not to start a run.
 * Customers whose implementation also creates the session (typical for
 * `chat.createStartSessionAction` server actions) own the trigger
 * payload server-side — they know their own user/context and don't
 * need anything from the browser to populate `basePayload.metadata`.
 */
export type AccessTokenParams = {
  /** Conversation id — same value passed to `sendMessage` / `useChat`. */
  chatId: string;
};

/**
 * Arguments for the `startSession` callback. The transport invokes this
 * when it needs a session for a chatId — on `transport.preload(chatId)`,
 * on `transport.start(chatId)`, and lazily on the first `sendMessage`
 * for any chatId without a cached session.
 *
 * The callback typically wraps a server action that calls
 * `chat.createStartSessionAction(taskId)({ chatId, clientData })`. That
 * action is idempotent on `(env, externalId)`, so concurrent / repeat
 * calls converge on the same session.
 *
 * The `clientData` field carries the transport's current `clientData`
 * option — same value the transport merges into per-turn `metadata` on
 * each `.in` chunk. Passing it through `startSession` makes the first
 * run's `payload.metadata` (visible in `onPreload` / `onChatStart`)
 * match what subsequent turns see.
 *
 * @typeParam TClientData – Type of the agent's `clientDataSchema` (when
 * the transport is parameterised with `useTriggerChatTransport<typeof agent>`).
 */
export type StartSessionParams<TClientData = unknown> = {
  /** The Trigger.dev task ID associated with this transport. */
  taskId: string;
  /** Conversation id — same value passed to `sendMessage` / `useChat`. */
  chatId: string;
  /**
   * The transport's current `clientData`. Pass through to the server
   * action's `basePayload.metadata` so the first run's `payload.metadata`
   * matches per-turn `metadata`.
   */
  clientData: TClientData;
};

/**
 * Result returned from the `startSession` callback. Carries the
 * session-scoped PAT the transport caches and uses for every
 * `.in/append`, `.out` SSE, and `end-and-continue` call afterward.
 */
export type StartSessionResult = {
  /** Session-scoped PAT — `read:sessions:{chatId} + write:sessions:{chatId}`. */
  publicAccessToken: string;
};

/**
 * Public surface of {@link TriggerChatTransport}'s session state. Everything
 * the customer should persist for resumption across page reloads. The
 * transport addresses by `chatId` everywhere, so this is light: just a PAT,
 * the last SSE event id, and a couple of UX-state flags.
 */
export type ChatSessionPersistedState = {
  publicAccessToken: string;
  lastEventId?: string;
  isStreaming?: boolean;
};

/**
 * Common options for the {@link TriggerChatTransport}.
 *
 * @typeParam TClientData – Type of the per-call client data merged into
 * the wire payload via `metadata`. When the task uses `clientDataSchema`,
 * pin this to the schema's input type for end-to-end type safety.
 */
export type TriggerChatTransportOptions<TClientData = unknown> = {
  /**
   * The Trigger.dev task ID this transport drives. Sessions created by
   * `transport.start(chatId)` are bound to this task — every run the
   * Session schedules invokes it. Threaded into `startSession` so the
   * customer's server action knows which task to bind.
   */
  task: string;

  /**
   * Returns a fresh session-scoped PAT for an existing chat session.
   * The transport invokes this on a 401/403 from any session-PAT-authed
   * request — pure refresh, never creates a session.
   *
   * Customer implementation typically does
   * `auth.createPublicToken({ scopes: { read: { sessions: chatId },
   * write: { sessions: chatId } } })` server-side and returns the token.
   *
   * Required so the transport can recover from PAT expiry — never
   * leaves the consumer in an unrecoverable state.
   */
  accessToken: (params: AccessTokenParams) => string | Promise<string>;

  /**
   * Creates (or no-ops on existing) a session for the given chatId, and
   * returns the session-scoped PAT the transport will use afterward.
   *
   * Wraps a server action that calls
   * `chat.createStartSessionAction(taskId)({ chatId, clientData })`.
   * Customer's server controls authorization, the rest of the
   * triggerConfig, and any atomic DB writes paired with session creation.
   *
   * The transport invokes this:
   *   - when `transport.start(chatId)` / `transport.preload(chatId)` is called
   *   - lazily on the first `sendMessage` for a chatId with no cached PAT
   *
   * Concurrent and repeat calls dedupe via an in-flight promise + the
   * customer-side idempotency on `(env, externalId)`.
   *
   * Optional only when the customer fully manages session lifecycle
   * externally (hydrating `sessions: { ... }` and never calling
   * `start` / `preload`). Most customers should provide it.
   */
  startSession?: (
    params: StartSessionParams<
      TClientData extends Record<string, unknown> ? TClientData : Record<string, unknown>
    >
  ) => Promise<StartSessionResult>;

  /** Base URL for the Trigger.dev API. @default "https://api.trigger.dev" */
  baseURL?: string;

  /** Additional headers included in every API request. */
  headers?: Record<string, string>;

  /**
   * Seconds to wait for the realtime stream to produce data before timing
   * out. @default 120
   */
  streamTimeoutSeconds?: number;

  /**
   * Default client data merged into every wire `metadata`. Per-call
   * `metadata` overrides transport-level defaults.
   */
  clientData?: TClientData extends Record<string, unknown> ? TClientData : Record<string, unknown>;

  /**
   * Restore active session state from external storage (e.g. localStorage)
   * after a page refresh. Hydrated entries skip the start round-trip and
   * use their `publicAccessToken` directly. On 401, the transport
   * invokes `accessToken` to refresh.
   */
  sessions?: Record<string, ChatSessionPersistedState>;

  /**
   * Called whenever a chat session's state changes. Use this to persist
   * state for reconnection after a page refresh — `null` is passed when
   * the session is removed.
   */
  onSessionChange?: (chatId: string, session: ChatSessionPersistedState | null) => void;

  /**
   * Enable multi-tab coordination. When `true`, only one tab at a time
   * can send messages to a given chatId; other tabs go read-only.
   *
   * No-op when `BroadcastChannel` is unavailable. @default false
   */
  multiTab?: boolean;

  /**
   * Read-only "watch" mode for observing an existing chat run from the
   * outside (e.g. a dashboard viewer). When `true`, the SSE subscription
   * stays open across `trigger:turn-complete` so consumers see turn 2,
   * 3, … through one long-lived stream. Pair with `sessions` hydration
   * and `reconnectToStream` for the typical viewer flow. @default false
   */
  watch?: boolean;

  /**
   * Opt-in URL that gives a brand-new chat a head start: instead of
   * waiting for the trigger.dev agent run to dequeue + boot before
   * the first LLM call, the transport POSTs the first user message
   * to a route handler in your warm process (Next.js, etc.) that
   * exports `chat.handover({ agentId, run })` from
   * `@trigger.dev/sdk/chat-server`. That handler runs `streamText`
   * step 1 right away while the agent boots in parallel, then hands
   * off mid-turn for tool execution (or exits clean for pure-text
   * turns).
   *
   * First turn only. Subsequent turns on the same chat bypass this
   * URL and write directly to `session.in` — the same direct-trigger
   * path used when `headStart` is unset. Customers using `headStart`
   * still need `accessToken` and (optionally) `startSession` for
   * those subsequent turns.
   *
   * NOT a stock `useChat` "endpoint" — this is not the canonical
   * request URL for every turn, just the warm first-turn shortcut.
   *
   * In benchmarks, head-starting drops first-turn TTFC roughly in
   * half versus the direct-trigger flow (cold-start agent boot +
   * onTurnStart hook overlap with the LLM TTFB instead of stacking
   * before it).
   *
   * @default undefined (direct-trigger flow on every turn)
   */
  headStart?: string;
};

/**
 * Internal state for tracking active chat sessions. Sessions are
 * task-bound and the server is the run manager — the transport only
 * needs to know the session-scoped PAT to address `.in/append`, `.out`,
 * `end-and-continue`, etc.
 * @internal
 */
type ChatSessionState = {
  /** Session-scoped PAT — `read:sessions:{chatId} + write:sessions:{chatId}`. */
  publicAccessToken: string;
  /** Last SSE event ID — used to resume the stream without replaying old events. */
  lastEventId?: string;
  /** Set when the stream was aborted mid-turn (stop). On reconnect, skip chunks until trigger:turn-complete. */
  skipToTurnComplete?: boolean;
  /** Whether the agent is currently streaming a response. Set on first chunk, cleared on turn-complete. */
  isStreaming?: boolean;
};

/**
 * A custom AI SDK `ChatTransport` that runs chat completions as durable
 * Trigger.dev tasks via the Sessions primitive.
 *
 * Lifecycle:
 *   1. Customer pre-creates the session server-side OR calls
 *      `transport.start(chatId)` to mint a one-shot start token and
 *      `POST /api/v1/sessions` from the browser.
 *   2. The server triggers the first run as part of session create and
 *      returns a session-scoped PAT.
 *   3. `sendMessages` appends to `.in` and subscribes to `.out`. When a
 *      run dies (idle, cancel, end-and-continue), the server's
 *      append-time probe triggers a fresh run for the same session —
 *      transport keeps streaming.
 *   4. `stop()` posts a `{kind:"stop"}` chunk; the agent's turn aborts
 *      but the run keeps reading `.in` for the next message.
 *   5. PAT expiry: transport invokes `accessToken` to refresh and
 *      retries the failing request once.
 */
export class TriggerChatTransport implements ChatTransport<UIMessage> {
  private readonly taskId: string;
  private readonly resolveAccessToken: (params: AccessTokenParams) => string | Promise<string>;
  private readonly resolveStartSession:
    | ((params: StartSessionParams<Record<string, unknown>>) => Promise<StartSessionResult>)
    | undefined;
  private readonly baseURL: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly streamTimeoutSeconds: number;
  private defaultMetadata: Record<string, unknown> | undefined;
  private readonly watchMode: boolean;
  private readonly headStart: string | undefined;
  private coordinator: ChatTabCoordinator | null = null;
  private _onSessionChange:
    | ((chatId: string, session: ChatSessionPersistedState | null) => void)
    | undefined;

  private sessions: Map<string, ChatSessionState> = new Map();
  private activeStreams: Map<string, AbortController> = new Map();
  private pendingStarts: Map<string, Promise<ChatSessionState>> = new Map();

  constructor(options: TriggerChatTransportOptions) {
    this.taskId = options.task;
    this.resolveAccessToken = options.accessToken;
    this.resolveStartSession = options.startSession as
      | ((params: StartSessionParams<Record<string, unknown>>) => Promise<StartSessionResult>)
      | undefined;
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    this.extraHeaders = options.headers ?? {};
    this.streamTimeoutSeconds = options.streamTimeoutSeconds ?? DEFAULT_STREAM_TIMEOUT_SECONDS;
    this.defaultMetadata = options.clientData;
    this._onSessionChange = options.onSessionChange;
    this.watchMode = options.watch ?? false;
    this.headStart = options.headStart;

    if (options.multiTab && !this.watchMode) {
      this.coordinator = new ChatTabCoordinator();
      this.coordinator.addSessionListener((chatId, sessionUpdate) => {
        const session = this.sessions.get(chatId);
        if (session && sessionUpdate.lastEventId) {
          session.lastEventId = sessionUpdate.lastEventId;
        }
      });
    }

    if (options.sessions) {
      for (const [chatId, session] of Object.entries(options.sessions)) {
        this.sessions.set(chatId, {
          publicAccessToken: session.publicAccessToken,
          lastEventId: session.lastEventId,
          isStreaming: session.isStreaming,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------

  /**
   * Eagerly create a Session and trigger its first run. Useful as a
   * "the user might be about to send a message — boot the agent now"
   * preload, or to take ownership of the session before any sendMessage.
   *
   * Idempotent: calling `start(chatId)` twice converges to the same
   * session via the `(env, externalId)` upsert. Concurrent calls
   * deduplicate via an in-flight promise.
   *
   * Requires `getStartToken` to be configured. Customers who pre-create
   * sessions server-side don't need to call this.
   */
  async start(chatId: string): Promise<ChatSessionPersistedState> {
    const existing = this.sessions.get(chatId);
    if (existing?.publicAccessToken) {
      return this.toPersisted(existing);
    }

    const inflight = this.pendingStarts.get(chatId);
    if (inflight) return inflight.then(this.toPersisted);

    const promise = this.doStart(chatId).finally(() => {
      this.pendingStarts.delete(chatId);
    });
    this.pendingStarts.set(chatId, promise);
    return promise.then(this.toPersisted);
  }

  /**
   * Eagerly create the session before the user types. Same semantics as
   * {@link start} — kept as a separate name for the AI SDK Chat hook,
   * which calls `preload` rather than `start`.
   */
  async preload(chatId: string): Promise<void> {
    await this.start(chatId);
  }

  /**
   * Send a user message via the session's `.in` channel. The server
   * probes `currentRunId`; if terminal/null it triggers a fresh run on
   * the same session before the append lands. The returned
   * `ReadableStream` carries the agent's response chunks via `.out` SSE.
   */
  sendMessages = async (
    options: {
      trigger: "submit-message" | "regenerate-message";
      chatId: string;
      messageId: string | undefined;
      messages: UIMessage[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk>> => {
    const { trigger, chatId, messageId, messages, abortSignal, body, metadata } = options;

    if (this.coordinator) {
      if (this.coordinator.isReadOnly(chatId)) {
        throw new Error("This chat is active in another tab");
      }
      this.coordinator.claim(chatId);
    }

    const mergedMetadata =
      this.defaultMetadata || metadata
        ? { ...(this.defaultMetadata ?? {}), ...((metadata as Record<string, unknown>) ?? {}) }
        : undefined;

    // First-turn handover routing — when `headStart` is set AND no
    // session state exists yet for this chatId, POST the wire payload
    // to the customer's `chat.handover` route handler. The handler
    // creates the session, triggers the agent run with
    // `handover-prepare`, runs `streamText` step 1 in its warm
    // process, and tees the output back as the SSE response. We
    // hydrate session state from the response headers so subsequent
    // turns bypass the handler and use direct `session.in` writes.
    if (this.headStart && !this.sessions.has(chatId)) {
      return this.sendMessagesViaHandover({
        trigger,
        chatId,
        messageId,
        messages,
        abortSignal,
        body,
        metadata: mergedMetadata,
      });
    }

    // Slim wire — at most ONE message per record. The agent rebuilds prior
    // history from its durable S3 snapshot + session.out replay at run boot
    // (or `hydrateMessages`, if registered). See plan vivid-humming-bonbon.
    //
    //   - "submit-message": ship the latest message (new user message OR a
    //     tool-approval-responded assistant message). Throw if absent.
    //   - "regenerate-message": omit `message`; the agent slices its own
    //     history (drops the trailing assistant) and re-runs.
    if (trigger === "submit-message" && messages.length === 0) {
      throw new Error(
        "TriggerChatTransport.sendMessages: 'submit-message' trigger requires at least one message"
      );
    }
    const wirePayload: ChatTaskWirePayload = {
      ...((body as Record<string, unknown>) ?? {}),
      ...(trigger === "submit-message" ? { message: messages.at(-1) } : {}),
      chatId,
      trigger,
      messageId,
      metadata: mergedMetadata,
    };

    const state = await this.ensureSessionState(chatId);

    const sendChatMessage = async (token: string) => {
      const apiClient = new ApiClient(this.baseURL, token);
      await apiClient.appendToSessionStream(
        chatId,
        "in",
        this.serializeInputChunk({ kind: "message", payload: wirePayload })
      );
    };

    await this.callWithAuthRetry(chatId, state, sendChatMessage);

    // Cancel any in-flight stream for this chat — the new turn supersedes it.
    const activeStream = this.activeStreams.get(chatId);
    if (activeStream) {
      activeStream.abort();
      this.activeStreams.delete(chatId);
    }

    state.isStreaming = true;
    this.notifySessionChange(chatId, state);

    return this.subscribeToSessionStream(state, abortSignal, chatId);
  };

  /**
   * First-turn-only path used when `headStart` is configured. POSTs the
   * wire payload to the customer's `chat.handover` route handler and
   * pipes its SSE response back as a UIMessageChunk stream. Hydrates
   * session state from response headers so subsequent turns bypass
   * the endpoint and use the direct `session.in` path.
   */
  private async sendMessagesViaHandover(args: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
    body: ChatRequestOptions["body"];
    metadata: Record<string, unknown> | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    if (!this.headStart) {
      throw new Error("sendMessagesViaHandover called without headStart configured");
    }

    // Head-start ships full UIMessage history via `headStartMessages`. The
    // route handler runs on the customer's own HTTP endpoint (NOT
    // `/realtime/v1/sessions/{id}/in/append`), so the 512 KiB body cap
    // doesn't apply. The agent's run boot consumes `headStartMessages` ONLY
    // when no snapshot exists yet (very first turn) — see plan section B.3.
    const wirePayload: ChatTaskWirePayload = {
      ...((args.body as Record<string, unknown>) ?? {}),
      headStartMessages: args.messages,
      chatId: args.chatId,
      trigger: args.trigger,
      messageId: args.messageId,
      metadata: args.metadata,
    };

    const response = await fetch(this.headStart, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify(wirePayload),
      signal: args.abortSignal,
    });

    if (!response.ok) {
      throw new Error(
        `chat.handover endpoint returned ${response.status} ${response.statusText}`
      );
    }
    if (!response.body) {
      throw new Error("chat.handover endpoint returned no response body");
    }

    // Hydrate session state from response headers so subsequent turns
    // skip the endpoint and write directly to session.in.
    const accessToken = response.headers.get("X-Trigger-Chat-Access-Token");
    const chatId = args.chatId;
    if (accessToken) {
      const state: ChatSessionState = {
        publicAccessToken: accessToken,
        isStreaming: true,
      };
      this.sessions.set(chatId, state);
      this.notifySessionChange(chatId, state);
    }

    // Filter the parsed UIMessage stream:
    //   - Drop control chunks (`trigger:turn-complete`,
    //     `trigger:session-state`) before they reach AI SDK — they
    //     aren't valid UIMessageChunks and the AI SDK chunk parser
    //     would reject them.
    //   - On `trigger:turn-complete`, clear `isStreaming` so the
    //     useChat resume / reconnectToStream path doesn't open a
    //     second `session.out` subscription on top of our stitched
    //     response.
    //   - On `trigger:session-state`, hydrate `state.lastEventId`
    //     with the agent's final S2 event id. Without this, turn 2's
    //     `session.out` subscribe reads from the start and replays
    //     turn 1's chunks back into the UI.
    //   - On stream end (handover-skip case — no
    //     `trigger:turn-complete` arrives, customer's stream just
    //     ends), also clear `isStreaming` for the same reason.
    const sessions = this.sessions;
    const notifyChange = (id: string, state: ChatSessionState) =>
      this.notifySessionChange(id, state);
    const TRIGGER_TURN_COMPLETE = "trigger:turn-complete";
    const TRIGGER_SESSION_STATE = "trigger:session-state";
    const clearStreaming = () => {
      const state = sessions.get(chatId);
      if (state && state.isStreaming) {
        state.isStreaming = false;
        notifyChange(chatId, state);
      }
    };
    const setLastEventId = (lastEventId: string) => {
      const state = sessions.get(chatId);
      if (state) {
        state.lastEventId = lastEventId;
        notifyChange(chatId, state);
      }
    };

    return response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(parseUIMessageSseTransform())
      .pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, controller) {
            if (chunk && typeof chunk === "object") {
              const type = (chunk as { type?: unknown }).type;
              if (type === TRIGGER_TURN_COMPLETE) {
                clearStreaming();
                return; // drop — not a real UIMessageChunk
              }
              if (type === TRIGGER_SESSION_STATE) {
                const lastEventId = (chunk as { lastEventId?: unknown }).lastEventId;
                if (typeof lastEventId === "string") {
                  setLastEventId(lastEventId);
                }
                return; // drop
              }
            }
            controller.enqueue(chunk);
          },
          flush() {
            clearStreaming();
          },
        })
      );
  }

  /**
   * Send a steering message during an active stream without disrupting
   * it. The agent's `pendingMessages` config decides whether to inject
   * between tool-call steps or buffer for the next turn.
   */
  sendPendingMessage = async (
    chatId: string,
    message: UIMessage,
    metadata?: Record<string, unknown>
  ): Promise<boolean> => {
    const state = this.sessions.get(chatId);
    if (!state) return false;

    const mergedMetadata =
      this.defaultMetadata || metadata
        ? { ...(this.defaultMetadata ?? {}), ...(metadata ?? {}) }
        : undefined;

    const wirePayload: ChatTaskWirePayload = {
      message,
      chatId,
      trigger: "submit-message" as const,
      metadata: mergedMetadata,
    };

    const send = async (token: string) => {
      const apiClient = new ApiClient(this.baseURL, token);
      await apiClient.appendToSessionStream(
        chatId,
        "in",
        this.serializeInputChunk({ kind: "message", payload: wirePayload })
      );
    };

    try {
      await this.callWithAuthRetry(chatId, state, send);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Re-establish an SSE subscription to a known session. Used after a
   * page refresh: the customer hydrates `sessions` in the constructor,
   * the AI SDK calls `reconnectToStream` to resume the stream.
   */
  reconnectToStream = async (
    options: {
      chatId: string;
      abortSignal?: AbortSignal | undefined;
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk> | null> => {
    const state = this.sessions.get(options.chatId);
    if (!state) return null;

    if (state.isStreaming === false) return null;
    if (this.activeStreams.has(options.chatId)) return null;

    const abortController = new AbortController();
    this.activeStreams.set(options.chatId, abortController);

    const abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, abortController.signal])
      : abortController.signal;

    return this.subscribeToSessionStream(state, abortSignal, options.chatId, {
      sendStopOnAbort: !!options.abortSignal,
      // Reconnect-on-reload opts into the server's settled-peek shortcut
      // so the SSE doesn't hang for 60s when no turn is in flight. Active
      // send-a-message paths must keep wait=60 to avoid racing the
      // freshly-triggered turn's first chunk.
      peekSettled: true,
    });
  };

  /**
   * Stop the current generation. Sends `{kind:"stop"}` on `.in`; the
   * agent aborts its `streamText` call but stays alive for the next
   * message.
   */
  stopGeneration = async (chatId: string): Promise<boolean> => {
    const state = this.sessions.get(chatId);
    if (!state) return false;

    const send = async (token: string) => {
      const api = new ApiClient(this.baseURL, token);
      await api.appendToSessionStream(
        chatId,
        "in",
        this.serializeInputChunk({ kind: "stop" })
      );
    };

    try {
      await this.callWithAuthRetry(chatId, state, send);
    } catch {
      return false;
    }

    state.skipToTurnComplete = true;

    const activeStream = this.activeStreams.get(chatId);
    if (activeStream) {
      activeStream.abort();
      this.activeStreams.delete(chatId);
    }
    return true;
  };

  /**
   * Send a custom action chunk (for `chat.agent`'s `actionSchema` /
   * `onAction` hook). Actions are not turns — only `hydrateMessages`
   * and `onAction` fire on the agent side. The returned stream
   * carries any model response `onAction` produced (when it returns a
   * `StreamTextResult`); for `void`-returning side-effect-only actions
   * the stream completes immediately with `trigger:turn-complete`.
   */
  sendAction = async (
    chatId: string,
    action: unknown
  ): Promise<ReadableStream<UIMessageChunk>> => {
    if (this.coordinator) {
      if (this.coordinator.isReadOnly(chatId)) {
        throw new Error("This chat is active in another tab");
      }
      this.coordinator.claim(chatId);
    }

    const state = await this.ensureSessionState(chatId);

    const wirePayload: ChatTaskWirePayload = {
      chatId,
      trigger: "action" as const,
      action,
      metadata: this.defaultMetadata ?? undefined,
    };

    const body = this.serializeInputChunk({ kind: "message", payload: wirePayload });
    const send = async (token: string) => {
      const apiClient = new ApiClient(this.baseURL, token);
      await apiClient.appendToSessionStream(chatId, "in", body);
    };

    await this.callWithAuthRetry(chatId, state, send);

    return this.subscribeToSessionStream(state, undefined, chatId);
  };

  // -------------------------------------------------------------------------
  // External-state surface
  // -------------------------------------------------------------------------

  getSession = (chatId: string): ChatSessionPersistedState | undefined => {
    const state = this.sessions.get(chatId);
    if (!state) return undefined;
    return this.toPersisted(state);
  };

  setSession(chatId: string, session: ChatSessionPersistedState): void {
    this.sessions.set(chatId, {
      publicAccessToken: session.publicAccessToken,
      lastEventId: session.lastEventId,
      isStreaming: session.isStreaming,
    });
    this.notifySessionChange(chatId, this.toPersisted(this.sessions.get(chatId)!));
  }

  setOnSessionChange(
    callback: ((chatId: string, session: ChatSessionPersistedState | null) => void) | undefined
  ): void {
    this._onSessionChange = callback;
  }

  /**
   * Update the transport's `clientData`. Used by `useTriggerChatTransport`
   * to keep the latest value reachable from inside `startSession` and
   * the per-turn `metadata` merge without recreating the transport.
   *
   * Reads always go through the live field — closures around the
   * transport see the latest value the next time they fire.
   */
  setClientData(clientData: Record<string, unknown> | undefined): void {
    this.defaultMetadata = clientData;
  }

  // -------------------------------------------------------------------------
  // Multi-tab coordination passthrough
  // -------------------------------------------------------------------------

  isReadOnly(chatId: string): boolean {
    return this.coordinator?.isReadOnly(chatId) ?? false;
  }
  hasClaim(chatId: string): boolean {
    return this.coordinator?.hasClaim(chatId) ?? false;
  }
  addReadOnlyListener(fn: (chatId: string, isReadOnly: boolean) => void): void {
    this.coordinator?.addListener(fn);
  }
  removeReadOnlyListener(fn: (chatId: string, isReadOnly: boolean) => void): void {
    this.coordinator?.removeListener(fn);
  }
  broadcastMessages(chatId: string, messages: unknown[]): void {
    this.coordinator?.broadcastMessages(chatId, messages);
  }
  addMessagesListener(fn: (chatId: string, messages: unknown[]) => void): void {
    this.coordinator?.addMessagesListener(fn);
  }
  removeMessagesListener(fn: (chatId: string, messages: unknown[]) => void): void {
    this.coordinator?.removeMessagesListener(fn);
  }
  dispose(): void {
    this.coordinator?.dispose();
    this.coordinator = null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private serializeInputChunk(chunk: ChatInputChunk): string {
    return JSON.stringify(chunk);
  }

  private toPersisted = (state: ChatSessionState): ChatSessionPersistedState => ({
    publicAccessToken: state.publicAccessToken,
    lastEventId: state.lastEventId,
    isStreaming: state.isStreaming,
  });

  private notifySessionChange(chatId: string, session: ChatSessionState | null): void {
    if (!this._onSessionChange) return;
    this._onSessionChange(chatId, session ? this.toPersisted(session) : null);
  }

  /**
   * Resolves the session state for a chatId, starting the session if
   * needed (and `getStartToken` is configured). Customers who provide
   * `accessToken` but no `getStartToken` are expected to have created
   * the session server-side; in that case the first `accessToken` call
   * returns a fresh session PAT.
   */
  private async ensureSessionState(chatId: string): Promise<ChatSessionState> {
    const existing = this.sessions.get(chatId);
    if (existing?.publicAccessToken) return existing;

    if (this.resolveStartSession) {
      // Lazily start: customer's server action creates the session and
      // returns a PAT. Idempotent on `(env, externalId)` so concurrent
      // tabs / repeat calls converge to the same session.
      const inflight = this.pendingStarts.get(chatId);
      if (inflight) return inflight;
      const promise = this.doStart(chatId).finally(() => {
        this.pendingStarts.delete(chatId);
      });
      this.pendingStarts.set(chatId, promise);
      return promise;
    }

    // No `startSession` configured. Customer fully manages session
    // lifecycle externally — they're expected to have hydrated
    // `sessions: { ... }` already, or the very first `accessToken` call
    // returns a PAT for an out-of-band-created session.
    const token = await this.resolveAccessToken({ chatId });
    const state: ChatSessionState = { publicAccessToken: token };
    this.sessions.set(chatId, state);
    this.notifySessionChange(chatId, state);
    return state;
  }

  private async doStart(chatId: string): Promise<ChatSessionState> {
    if (!this.resolveStartSession) {
      throw new Error(
        "TriggerChatTransport: `startSession` is required to call `start()` / `preload()`. Either provide it or pre-hydrate the session via `sessions: { ... }`."
      );
    }

    const { publicAccessToken } = await this.resolveStartSession({
      taskId: this.taskId,
      chatId,
      clientData: (this.defaultMetadata ?? {}) as Record<string, unknown>,
    });

    const state: ChatSessionState = {
      publicAccessToken,
      isStreaming: false,
    };
    this.sessions.set(chatId, state);
    this.notifySessionChange(chatId, state);
    return state;
  }

  /**
   * Run `op` with the session's stored PAT. On 401/403, refresh the PAT
   * via `accessToken` and retry once. Surfaces non-auth errors as-is.
   */
  private async callWithAuthRetry(
    chatId: string,
    state: ChatSessionState,
    op: (token: string) => Promise<void>
  ): Promise<void> {
    try {
      await op(state.publicAccessToken);
      return;
    } catch (err) {
      if (!isAuthError(err)) throw err;
    }

    const fresh = await this.resolveAccessToken({ chatId });
    state.publicAccessToken = fresh;
    this.notifySessionChange(chatId, state);
    await op(fresh);
  }

  /**
   * Open an SSE subscription to the session's `.out` stream and pipe
   * UIMessageChunks through to the AI SDK. Trigger control records
   * (`turn-complete`, `upgrade-required` — see `trigger-control` header
   * on `client-protocol.mdx#records-on-session-out`) are routed by
   * header and never reach the consumer. `upgrade-required` is purely
   * telemetry now since the server handles the run swap inline (see
   * `end-and-continue`).
   */
  private subscribeToSessionStream(
    state: ChatSessionState,
    abortSignal: AbortSignal | undefined,
    chatId: string,
    options?: {
      sendStopOnAbort?: boolean;
      peekSettled?: boolean;
    }
  ): ReadableStream<UIMessageChunk> {
    const internalAbort = new AbortController();
    this.activeStreams.set(chatId, internalAbort);
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, internalAbort.signal])
      : internalAbort.signal;

    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          if (options?.sendStopOnAbort !== false) {
            state.skipToTurnComplete = true;
            const api = new ApiClient(this.baseURL, state.publicAccessToken);
            api
              .appendToSessionStream(
                chatId,
                "in",
                this.serializeInputChunk({ kind: "stop" })
              )
              .catch(() => {});
          }
          internalAbort.abort();
        },
        { once: true }
      );
    }

    const streamUrl = `${this.baseURL}/realtime/v1/sessions/${encodeURIComponent(chatId)}/out`;

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        // Track the live subscription so browser wake events can act
        // on it. Three classes of wake:
        //   - `online`: network came back. Existing connection might
        //     be silently dead; force a fresh one.
        //   - `visibilitychange` → visible after long hidden: tab
        //     was backgrounded long enough that the OS likely killed
        //     the TCP socket. Force reconnect.
        //   - `visibilitychange` → visible after short hidden: cheap
        //     wake of any in-flight backoff.
        //   - `pageshow` with `event.persisted`: bfcache restore
        //     (mobile Safari back/forward, app-switcher resume). The
        //     socket is definitely dead. Force reconnect.
        let currentSubscription: SSEStreamSubscription | null = null;
        let hiddenSince: number | null = null;
        const FORCE_RECONNECT_AFTER_HIDDEN_MS = 30_000;

        const onVisibilityChange = () => {
          if (typeof document === "undefined") return;
          if (document.visibilityState === "hidden") {
            hiddenSince = Date.now();
            return;
          }
          const wasHiddenForMs = hiddenSince ? Date.now() - hiddenSince : 0;
          hiddenSince = null;
          if (wasHiddenForMs >= FORCE_RECONNECT_AFTER_HIDDEN_MS) {
            currentSubscription?.forceReconnect();
          } else {
            currentSubscription?.retryNow();
          }
        };

        const onPageShow = (event: Event) => {
          // PageTransitionEvent in browsers; type guard via `persisted`.
          if ((event as PageTransitionEvent).persisted) {
            currentSubscription?.forceReconnect();
          }
        };

        const onOnline = () => currentSubscription?.forceReconnect();

        const teardownWakeListeners =
          typeof document !== "undefined" && typeof window !== "undefined"
            ? (() => {
                document.addEventListener("visibilitychange", onVisibilityChange);
                window.addEventListener("online", onOnline);
                window.addEventListener("pageshow", onPageShow);
                return () => {
                  document.removeEventListener("visibilitychange", onVisibilityChange);
                  window.removeEventListener("online", onOnline);
                  window.removeEventListener("pageshow", onPageShow);
                };
              })()
            : () => {};

        const connectSseOnce = async (token: string) => {
          const subscription = new SSEStreamSubscription(streamUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              ...this.extraHeaders,
              ...(options?.peekSettled ? { "X-Peek-Settled": "1" } : {}),
            },
            signal: combinedSignal,
            timeoutInSeconds: this.streamTimeoutSeconds,
            lastEventId: state.lastEventId,
            // Catch silent-dead-socket: if no chunk (or server
            // keepalive) arrives in 60s, force reconnect. Sized
            // generously over typical agent thinking pauses.
            stallTimeoutMs: 60_000,
          });
          currentSubscription = subscription;
          const sseStream = await subscription.subscribe();
          const reader = sseStream.getReader();
          try {
            const first = await reader.read();
            if (first.done) {
              reader.releaseLock();
              return null;
            }
            return { reader, primed: first.value };
          } catch (readErr) {
            reader.releaseLock();
            throw readErr;
          }
        };

        try {
          let reader: ReadableStreamDefaultReader<{
            id: string;
            chunk: unknown;
            timestamp: number;
          }>;
          let primed: { id: string; chunk: unknown; timestamp: number } | undefined;

          try {
            const opened = await connectSseOnce(state.publicAccessToken);
            if (opened === null) {
              controller.close();
              return;
            }
            reader = opened.reader;
            primed = opened.primed;
          } catch (e) {
            if (isAuthError(e)) {
              const fresh = await this.resolveAccessToken({ chatId });
              state.publicAccessToken = fresh;
              this.notifySessionChange(chatId, state);
              const opened = await connectSseOnce(fresh);
              if (opened === null) {
                controller.close();
                return;
              }
              reader = opened.reader;
              primed = opened.primed;
            } else {
              throw e;
            }
          }

          while (true) {
            let value: {
              id: string;
              chunk: unknown;
              timestamp: number;
              headers?: ReadonlyArray<readonly [string, string]>;
            };
            if (primed !== undefined) {
              value = primed;
              primed = undefined;
            } else {
              const next = await reader.read();
              if (next.done) {
                controller.close();
                return;
              }
              value = next.value;
            }

            if (combinedSignal.aborted) {
              internalAbort.abort();
              await reader.cancel();
              controller.close();
              return;
            }

            if (value.id) state.lastEventId = value.id;

            // Trigger control record (turn-complete, upgrade-required) —
            // routed by header, body is empty. Detect via the
            // `trigger-control` header on the SSE record. Data records
            // (UIMessageChunks) fall through to the chunk path below.
            //
            // Cross-version bridge: a customer who redeploys their
            // Next.js app (new browser SDK) before their next
            // `trigger deploy` (old agent SDK still writing turn-complete
            // / upgrade-required as `chunk.type` data records) would
            // otherwise hang. Fall back to the legacy chunk-type form
            // when no header is present so the deploy-skew window
            // closes turns correctly.
            let controlValue = controlSubtype(value.headers);
            let legacyChunk:
              | { type?: string; publicAccessToken?: string }
              | undefined;
            if (!controlValue && value.chunk && typeof value.chunk === "object") {
              const chunk = value.chunk as { type?: unknown; publicAccessToken?: unknown };
              if (chunk.type === "trigger:turn-complete") {
                controlValue = TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE;
                legacyChunk = chunk as { type?: string; publicAccessToken?: string };
              } else if (chunk.type === "trigger:upgrade-required") {
                controlValue = TRIGGER_CONTROL_SUBTYPE.UPGRADE_REQUIRED;
              } else if (typeof chunk.type === "string" && chunk.type.startsWith("trigger:")) {
                // Future / unknown `trigger:*` legacy control type from
                // a pre-upgrade agent — drop so it doesn't reach the AI
                // SDK as an unrecognised UIMessageChunk.
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
              // `end-and-continue`; the next chunks on this same `.out`
              // stream come from v2. Filter the marker for cleanliness
              // and keep reading.
              continue;
            }

            if (controlValue === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
              const refreshedToken =
                headerValue(value.headers, PUBLIC_ACCESS_TOKEN_HEADER) ??
                legacyChunk?.publicAccessToken;
              if (refreshedToken) {
                state.publicAccessToken = refreshedToken;
              }
              state.isStreaming = false;
              this.notifySessionChange(chatId, state);
              this.coordinator?.release(chatId);
              this.coordinator?.broadcastSession(chatId, {
                lastEventId: state.lastEventId,
              });

              if (this.watchMode) continue;

              internalAbort.abort();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }

            // Data record — `value.chunk` is the parsed UIMessageChunk
            // unwrapped from the S2 record envelope (the parser does the
            // JSON unwrap). Drop empty/malformed payloads defensively.
            if (value.chunk == null) continue;
            controller.enqueue(value.chunk as UIMessageChunk);
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          controller.error(error);
        } finally {
          teardownWakeListeners();
          this.activeStreams.delete(chatId);
          this.coordinator?.release(chatId);
        }
      },
    });
  }
}

/**
 * Convenience constructor matching {@link TriggerChatTransport}.
 */
export function createChatTransport(options: TriggerChatTransportOptions): TriggerChatTransport {
  return new TriggerChatTransport(options);
}

// Server-side agent chat re-exports.
export {
  AgentChat,
  ChatStream,
  type AgentChatOptions,
  type ChatSession,
  type ChatStreamResult,
  type ChatToolCall,
  type ChatToolResult,
  type InferChatClientData,
  type InferChatUIMessage,
} from "./chat-client.js";
