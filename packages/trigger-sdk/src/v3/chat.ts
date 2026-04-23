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
 * function Chat({ accessToken }: { accessToken: string }) {
 *   const { messages, sendMessage, status } = useChat({
 *     transport: new TriggerChatTransport({
 *       task: "my-chat-task",
 *       accessToken: ({ chatId }) => mintTriggerToken(chatId),
 *     }),
 *   });
 * }
 * ```
 */

import type { ChatTransport, UIMessage, UIMessageChunk, ChatRequestOptions } from "ai";
import { ApiClient, SSEStreamSubscription } from "@trigger.dev/core/v3";
import type { ChatInputChunk } from "./ai.js";

/**
 * Detect 401/403 from realtime/input-stream calls without relying on `instanceof`
 * (Vitest can load duplicate `@trigger.dev/core` copies, which breaks subclass checks).
 */
function isRunPatAuthError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const e = error as { name?: string; status?: number };
  return e.name === "TriggerApiError" && (e.status === 401 || e.status === 403);
}
// Stream-ID constants are no longer used — the transport writes a tagged
// ChatInputChunk to the session's `.in` channel (append route) and reads
// UIMessageChunks from `.out` (SSE subscribe). Kept imported from
// chat-constants.js only for callers that still import them directly; the
// legacy constants will be deleted in a follow-up cleanup.
import { ChatTabCoordinator } from "./chat-tab-coordinator.js";

const DEFAULT_STREAM_KEY = "chat";
const DEFAULT_BASE_URL = "https://api.trigger.dev";
const DEFAULT_STREAM_TIMEOUT_SECONDS = 120;

/**
 * Arguments passed to {@link TriggerChatTransportOptions.renewRunAccessToken}.
 */
export type RenewRunAccessTokenParams = {
  /** Same `chatId` passed to `sendMessages` / `useChat` — your app’s conversation id. */
  chatId: string;
  /** The durable Trigger.dev run backing this chat session. */
  runId: string;
  /**
   * The durable Session friendlyId backing this chat. Present whenever
   * the transport has observed a session for the chat (i.e. after the
   * first trigger). Servers should mint tokens with both `read:runs:{runId}`
   * + `write:inputStreams:{runId}` AND `read:sessions:{sessionId}` +
   * `write:sessions:{sessionId}` so the PAT covers the run's live input
   * stream AND the Session's `.in` / `.out` channels.
   */
  sessionId?: string;
};

/**
 * Arguments passed when resolving {@link TriggerChatTransportOptions.accessToken} as a function.
 */
export type ResolveChatAccessTokenParams = {
  /** Conversation id for this trigger or preload. */
  chatId: string;
  /**
   * `trigger` — token used to call `triggerTask` from `sendMessages` (new run or after session ended).
   * `preload` — same, but from `preload()`.
   */
  purpose: "trigger" | "preload";
};

/**
 * Payload passed to the {@link TriggerChatTransportOptions.triggerTask} callback.
 */
export type TriggerChatTaskParams = {
  /** The full payload to pass to the task. */
  payload: {
    messages: UIMessage[];
    chatId: string;
    trigger: "submit-message" | "regenerate-message" | "preload";
    messageId?: string;
    metadata?: Record<string, unknown>;
    continuation?: boolean;
    previousRunId?: string;
    idleTimeoutInSeconds?: number;
  };
  /** Trigger options (tags, queue, etc.) — pre-merged by the transport. */
  options: {
    tags: string[];
    queue?: string;
    maxAttempts?: number;
    machine?: string;
    priority?: number;
  };
};

/**
 * Return value from the {@link TriggerChatTransportOptions.triggerTask} callback.
 */
export type TriggerChatTaskResult = {
  /** The run ID from the triggered task. */
  runId: string;
  /**
   * Public access token scoped to the run and the backing session. Must
   * include `read:runs:{runId}`, `write:inputStreams:{runId}`,
   * `read:sessions:{sessionId}`, and `write:sessions:{sessionId}` so the
   * transport can both send on `session.in` and subscribe to
   * `session.out`.
   */
  publicAccessToken: string;
  /**
   * Session friendlyId backing this chat. Optional for callers that still
   * create the session from the transport side; when present, the
   * transport skips its own `sessions.create` call and threads the
   * provided id through subsequent sends + subscribes.
   */
  sessionId?: string;
};

/** Common options shared by all TriggerChatTransport configurations. */
type TriggerChatTransportOptionsBase<TClientData = unknown> = {
  /**
   * The Trigger.dev task ID to trigger for chat completions.
   * This task should be defined using `chatAgent()` from `@trigger.dev/sdk/ai`,
   * or a regular `task()` that uses `pipeChat()`.
   */
  task: string;

  /**
   * Base URL for the Trigger.dev API.
   * @default "https://api.trigger.dev"
   */
  baseURL?: string;

  /**
   * The stream key where the task pipes UIMessageChunk data.
   * When using `chatAgent()` or `pipeChat()`, this is handled automatically.
   * Only set this if you're using a custom stream key.
   *
   * @default "chat"
   */
  streamKey?: string;

  /**
   * Additional headers to include in API requests to Trigger.dev.
   */
  headers?: Record<string, string>;

  /**
   * The number of seconds to wait for the realtime stream to produce data
   * before timing out.
   *
   * @default 120
   */
  streamTimeoutSeconds?: number;

  /**
   * Default client data included in every request payload.
   * Merged with per-call `metadata` from `sendMessage()` — per-call values
   * take precedence over transport-level defaults.
   *
   * When the task uses `clientDataSchema`, this is typed to match the schema.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   clientData: { userId: currentUser.id },
   * });
   * ```
   */
  clientData?: TClientData extends Record<string, unknown> ? TClientData : Record<string, unknown>;

  /**
   * Restore active chat sessions from external storage (e.g. localStorage).
   *
   * After a page refresh, pass previously persisted sessions here so the
   * transport can reconnect to existing runs instead of starting new ones.
   * Use `getSession()` to retrieve session state for persistence.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   sessions: {
   *     "chat-abc": { sessionId: "session_abc", runId: "run_123", publicAccessToken: "...", lastEventId: "42" },
   *   },
   * });
   * ```
   */
  sessions?: Record<
    string,
    {
      /**
       * Optional. If omitted, the transport upserts the backing
       * Session on first use via `POST /api/v1/sessions` (keyed on
       * `chatId` as `externalId`). Pre-Sessions persisted state
       * won't have a sessionId — this lets old localStorage records
       * hydrate without migration.
       */
      sessionId?: string;
      runId?: string;
      publicAccessToken: string;
      lastEventId?: string;
      isStreaming?: boolean;
    }
  >;

  /**
   * Called whenever a chat session's state changes.
   *
   * Fires when:
   * - A new session is created (after triggering a task)
   * - A turn completes (lastEventId updated)
   * - A session is removed (run ended or input stream send failed) — `session` will be `null`
   *
   * Use this to persist session state for reconnection after page refreshes,
   * without needing to call `getSession()` manually.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   onSessionChange: (chatId, session) => {
   *     if (session) {
   *       localStorage.setItem(`session:${chatId}`, JSON.stringify(session));
   *     } else {
   *       localStorage.removeItem(`session:${chatId}`);
   *     }
   *   },
   * });
   * ```
   */
  onSessionChange?: (
    chatId: string,
    session:
      | {
          sessionId: string;
          runId?: string;
          publicAccessToken: string;
          lastEventId?: string;
          isStreaming?: boolean;
        }
      | null
  ) => void;

  /**
   * Options forwarded to the Trigger.dev API when starting a new run.
   * Only applies to the first message — subsequent messages reuse the same run.
   *
   * A `chat:{chatId}` tag is automatically added to every run.
   *
   * @example
   * ```ts
   * new TriggerChatTransport({
   *   task: "my-chat",
   *   accessToken,
   *   triggerOptions: {
   *     tags: ["user:123"],
   *     queue: "chat-queue",
   *   },
   * });
   * ```
   */
  triggerOptions?: {
    /** Additional tags for the run. A `chat:{chatId}` tag is always added automatically. */
    tags?: string[];
    /** Queue name for the run. */
    queue?: string;
    /** Maximum retry attempts. */
    maxAttempts?: number;
    /** Machine preset for the run. */
    machine?:
      | "micro"
      | "small-1x"
      | "small-2x"
      | "medium-1x"
      | "medium-2x"
      | "large-1x"
      | "large-2x";
    /** Priority (lower = higher priority). */
    priority?: number;
  };

  /**
   * Mint a fresh run-scoped public access token for an existing run (same shape as `x-trigger-jwt`
   * after trigger). Call from your server with `auth.createPublicToken` using `TRIGGER_ACCESS_KEY`
   * and scopes `read:runs:<runId>` and `write:inputStreams:<runId>`.
   *
   * When the stored PAT expires, the transport invokes this once and retries the failing realtime
   * or input-stream request. If renewal fails or is omitted, auth errors are surfaced to the caller.
   *
   * Receives `chatId` and `runId` so your server action can persist the new PAT keyed by conversation.
   */
  renewRunAccessToken?: (
    params: RenewRunAccessTokenParams
  ) => string | undefined | null | Promise<string | undefined | null>;

  /**
   * Enable multi-tab coordination. When `true`, only one browser tab
   * can send messages to a given chatId at a time. Other tabs enter
   * read-only mode. Uses `BroadcastChannel` for cross-tab communication.
   *
   * Use `transport.isReadOnly(chatId)` or the `useChatTabCoordination` hook
   * to check read-only state and disable the input UI.
   *
   * No-op when `BroadcastChannel` is unavailable (SSR, Node.js).
   *
   * @default false
   */
  multiTab?: boolean;

  /**
   * Read-only "watch" mode for observing an existing chat run from the
   * outside (e.g. a dashboard viewer that wants to show an agent run's
   * conversation as it unfolds).
   *
   * When `true`, the transport no longer terminates its internal
   * `ReadableStream` on the `trigger:turn-complete` control chunk. Instead,
   * it forwards the session update, filters the control chunk, and keeps
   * reading — so `useChat` receives chunks from turn 2, 3, etc. through a
   * single long-lived subscription instead of needing a new `sendMessages`
   * call to open the next turn's stream.
   *
   * You should also seed an existing `sessions` entry for the chat and drive
   * the stream via `reconnectToStream` (or `useChat`'s `resumeStream`/`resume`
   * option), and provide a placeholder `task` — a watch-mode transport never
   * triggers new runs.
   *
   * @default false
   */
  watch?: boolean;
};

/** Access token used for frontend-triggered runs. */
type AccessTokenOption =
  | string
  | ((params: ResolveChatAccessTokenParams) => string | Promise<string>);

/**
 * Options for creating a TriggerChatTransport.
 *
 * Provide either `accessToken` (frontend triggering) or `triggerTask` (server-side triggering).
 * When `triggerTask` is provided, `accessToken` is optional.
 */
export type TriggerChatTransportOptions<TClientData = unknown> =
  | (TriggerChatTransportOptionsBase<TClientData> & {
      /** Access token for frontend-triggered runs. Required when `triggerTask` is not set. */
      accessToken: AccessTokenOption;
      triggerTask?: undefined;
    })
  | (TriggerChatTransportOptionsBase<TClientData> & {
      /**
       * Delegate run triggering to a server-side callback (e.g. a Next.js server action).
       *
       * When provided, the transport calls this function instead of triggering the task directly
       * from the browser. The callback should trigger the task using the secret key and return
       * both the `runId` and a run-scoped `publicAccessToken` for stream subscription.
       *
       * Use `chat.createTriggerAction(taskId)` to create the callback body.
       *
       * @example
       * ```ts
       * // actions.ts ("use server")
       * import { chat } from "@trigger.dev/sdk/ai";
       * export const triggerChat = chat.createTriggerAction("my-chat");
       *
       * // component.tsx
       * const transport = useTriggerChatTransport({
       *   task: "my-chat",
       *   triggerTask: triggerChat,
       * });
       * ```
       */
      triggerTask: (params: TriggerChatTaskParams) => Promise<TriggerChatTaskResult>;
      /** Optional when `triggerTask` is set. Only needed if the transport needs to resolve tokens for other purposes. */
      accessToken?: AccessTokenOption;
    });

/**
 * Internal state for tracking active chat sessions.
 *
 * After the Sessions migration, the durable identity of a chat is the
 * Session primitive (keyed on `sessionId`, externalId `chatId`). The
 * transport produces messages by appending to `.in` on that session and
 * consumes responses by subscribing to `.out`. The `runId` is kept only
 * as a hint for "is there a live run right now?" — e.g. to decide
 * whether the next message needs to trigger a fresh run.
 * @internal
 */
type ChatSessionState = {
  /** Session friendlyId (`session_*`). Durable across runs. */
  sessionId: string;
  /**
   * The live run's friendlyId, if any. Cleared on turn-complete /
   * run-end signals. Used to know whether the next sendMessages should
   * trigger a new run or rely on the existing run reading from
   * `session.in`.
   */
  runId?: string;
  /**
   * Public access token. Scoped to both the session and (for legacy
   * run-scoped endpoints still in the transition) the active run.
   */
  publicAccessToken: string;
  /** Last SSE event ID — used to resume the stream without replaying old events. */
  lastEventId?: string;
  /** Set when the stream was aborted mid-turn (stop). On reconnect, skip chunks until trigger:turn-complete. */
  skipToTurnComplete?: boolean;
  /** Whether the agent is currently streaming a response. Set on first chunk, cleared on turn-complete. */
  isStreaming?: boolean;
};

/**
 * A custom AI SDK `ChatTransport` that runs chat completions as durable Trigger.dev tasks.
 *
 * When `sendMessages` is called, the transport:
 * 1. Triggers a Trigger.dev task (or sends to an existing run via input streams)
 * 2. Subscribes to the task's realtime stream to receive `UIMessageChunk` data
 * 3. Returns a `ReadableStream<UIMessageChunk>` that the AI SDK processes natively
 *
 * Calling `stop()` from `useChat` sends a stop signal via input streams, which
 * aborts the current `streamText` call in the task without ending the run.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { TriggerChatTransport } from "@trigger.dev/sdk/chat";
 *
 * function Chat() {
 *   const { messages, sendMessage, stop, status } = useChat({
 *     transport: new TriggerChatTransport({
 *       task: "my-chat-task",
 *       accessToken: ({ chatId }) => fetchTriggerToken(chatId),
 *     }),
 *   });
 *
 *   // stop() sends a stop signal — the task aborts streamText but keeps the run alive
 * }
 * ```
 */
export class TriggerChatTransport implements ChatTransport<UIMessage> {
  private readonly taskId: string;
  private readonly staticAccessToken: string | undefined;
  private readonly resolveAccessTokenFn:
    | ((params: ResolveChatAccessTokenParams) => string | Promise<string>)
    | undefined;
  private triggerTaskFn:
    | ((params: TriggerChatTaskParams) => Promise<TriggerChatTaskResult>)
    | undefined;
  private readonly baseURL: string;
  private readonly streamKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly streamTimeoutSeconds: number;
  private readonly defaultMetadata: Record<string, unknown> | undefined;
  private readonly triggerOptions: TriggerChatTransportOptions["triggerOptions"];
  private readonly watchMode: boolean;
  private coordinator: ChatTabCoordinator | null = null;
  private _onSessionChange:
    | ((
        chatId: string,
        session:
          | {
              sessionId: string;
              runId?: string;
              publicAccessToken: string;
              lastEventId?: string;
              isStreaming?: boolean;
            }
          | null
      ) => void)
    | undefined;

  private renewRunAccessToken: TriggerChatTransportOptions["renewRunAccessToken"] | undefined;

  private sessions: Map<string, ChatSessionState> = new Map();
  private activeStreams: Map<string, AbortController> = new Map();
  private pendingPreloads: Map<string, Promise<void>> = new Map();

  constructor(options: TriggerChatTransportOptions) {
    this.taskId = options.task;
    this.triggerTaskFn = options.triggerTask;
    if (options.accessToken) {
      if (typeof options.accessToken === "function") {
        this.staticAccessToken = undefined;
        this.resolveAccessTokenFn = options.accessToken;
      } else {
        this.staticAccessToken = options.accessToken;
        this.resolveAccessTokenFn = undefined;
      }
    } else if (!options.triggerTask) {
      throw new Error(
        "TriggerChatTransport: either `accessToken` or `triggerTask` must be provided."
      );
    }
    this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    this.streamKey = options.streamKey ?? DEFAULT_STREAM_KEY;
    this.extraHeaders = options.headers ?? {};
    this.streamTimeoutSeconds = options.streamTimeoutSeconds ?? DEFAULT_STREAM_TIMEOUT_SECONDS;
    this.defaultMetadata = options.clientData;
    this.triggerOptions = options.triggerOptions;
    this._onSessionChange = options.onSessionChange;
    this.renewRunAccessToken = options.renewRunAccessToken;
    this.watchMode = options.watch ?? false;

    if (options.multiTab && !this.watchMode) {
      this.coordinator = new ChatTabCoordinator();

      // Sync session state (lastEventId) from other tabs so this tab
      // doesn't replay old SSE events when it takes over sending.
      this.coordinator.addSessionListener((chatId, sessionUpdate) => {
        const session = this.sessions.get(chatId);
        if (session && sessionUpdate.lastEventId) {
          session.lastEventId = sessionUpdate.lastEventId;
        }
      });
    }

    // Restore sessions from external storage
    if (options.sessions) {
      for (const [chatId, session] of Object.entries(options.sessions)) {
        // Accept either the new `sessionId` field or the legacy
        // shape (runId only). If only runId is present there's no way
        // to recover the sessionId synchronously — we leave it missing
        // and `ensureSession` will upsert on next send (externalId =
        // chatId, so the server returns the existing friendlyId).
        const sessionId = (session as { sessionId?: string }).sessionId;
        if (!sessionId) continue;
        this.sessions.set(chatId, {
          sessionId,
          runId: session.runId,
          publicAccessToken: session.publicAccessToken,
          lastEventId: session.lastEventId,
          isStreaming: session.isStreaming,
        });
      }
    }
  }

  /**
   * Resolve the Session backing this chat, creating it on the server
   * if the transport doesn't already have a `sessionId` cached. The
   * create call is idempotent — it upserts on `externalId = chatId`,
   * so two tabs of the same chat converge to one row.
   */
  private async ensureSession(chatId: string): Promise<ChatSessionState> {
    const existing = this.sessions.get(chatId);
    if (existing?.sessionId) return existing;

    const token = await this.resolveAccessToken({ chatId, purpose: "trigger" });
    const apiClient = new ApiClient(this.baseURL, token);
    const created = await apiClient.createSession({
      type: "chat.agent",
      externalId: chatId,
    });

    const state: ChatSessionState = {
      sessionId: created.id,
      runId: existing?.runId,
      publicAccessToken: existing?.publicAccessToken ?? token,
      lastEventId: existing?.lastEventId,
      isStreaming: existing?.isStreaming,
      skipToTurnComplete: existing?.skipToTurnComplete,
    };
    this.sessions.set(chatId, state);
    this.notifySessionChange(chatId, state);
    return state;
  }

  /**
   * Serialize a ChatInputChunk body for `POST …/sessions/:session/:io/append`.
   * Session channel records are raw JSON strings — the server wraps them
   * in `{ data: <body>, id }` for S2 storage and the subscribe side
   * parses the string back for consumers.
   */
  private serializeInputChunk(chunk: ChatInputChunk): string {
    return JSON.stringify(chunk);
  }

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

    // Multi-tab coordination: prevent sending from a read-only tab
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

    const payload = {
      ...(body ?? {}),
      messages,
      chatId,
      trigger,
      messageId,
      metadata: mergedMetadata,
    };

    // Resolve (or lazily create) the backing Session. For the
    // `triggerTask` callback path we defer session creation to the
    // server action (see `createChatTriggerAction`) — it has the secret
    // key and returns the sessionId in its result. For the direct
    // `accessToken` path we create the session from here (requires the
    // token to have `write:sessions` scope).
    let state: ChatSessionState | undefined = this.sessions.get(chatId);
    if (!state?.sessionId) {
      if (this.triggerTaskFn) {
        // Leave state as-is (undefined or runless); first-message path
        // below triggers and adopts the sessionId from the result.
        state = state;
      } else {
        state = await this.ensureSession(chatId);
      }
    }
    let isContinuation = false;
    let previousRunId: string | undefined;

    // If a run is already live for this chat, deliver the new message
    // via `session.in.send({kind: "message", payload})`. The agent's
    // `chat.messages.waitWithIdleTimeout` (now backed by session.in)
    // picks it up without tearing down the run.
    if (state?.runId) {
      const slicedMessages = trigger === "submit-message" ? messages.slice(-1) : messages;
      const minimalPayload = {
        ...payload,
        messages: slicedMessages,
      };

      const sendChatMessages = async (token: string) => {
        const apiClient = new ApiClient(this.baseURL, token);
        await apiClient.appendToSessionStream(
          state.sessionId,
          "in",
          this.serializeInputChunk({ kind: "message", payload: minimalPayload })
        );
      };

      let inputSendOk = false;

      try {
        await sendChatMessages(state.publicAccessToken);
        inputSendOk = true;
      } catch (err) {
        if (isRunPatAuthError(err) && this.renewRunAccessToken) {
          const newToken = await this.renewRunPatForSession(chatId, state.runId);
          if (newToken) {
            try {
              await sendChatMessages(newToken);
              inputSendOk = true;
            } catch (err2) {
              throw err2;
            }
          } else {
            throw err;
          }
        } else if (isRunPatAuthError(err)) {
          throw err;
        } else {
          // Unknown non-auth error: assume the run has ended and fall
          // back to triggering a new one on the same session.
          previousRunId = state.runId;
          state.runId = undefined;
          this.coordinator?.release(chatId);
          this.notifySessionChange(chatId, state);
          isContinuation = true;
        }
      }

      if (inputSendOk) {
        const activeStream = this.activeStreams.get(chatId);
        if (activeStream) {
          activeStream.abort();
          this.activeStreams.delete(chatId);
        }

        state.isStreaming = true;
        this.notifySessionChange(chatId, state);

        return this.subscribeToSessionStream(
          state,
          abortSignal,
          chatId,
          { upgradeRetry: { payload, messages } }
        );
      }
    }

    // First message or previous run ended — trigger a new run on the
    // same session. The sessionId is threaded through the payload so
    // the agent's runtime can `sessions.open(sessionId)` and attach to
    // `.in` / `.out`. For the `triggerTask` callback path the server
    // action creates the session and returns its id back to us.
    const triggerPayload: Record<string, unknown> = {
      ...payload,
      continuation: isContinuation,
      ...(previousRunId ? { previousRunId } : {}),
    };
    if (state?.sessionId) {
      triggerPayload.sessionId = state.sessionId;
    }

    const {
      runId,
      publicAccessToken,
      sessionId: triggeredSessionId,
    } = await this.triggerNewRun(chatId, triggerPayload, "trigger");

    const resolvedSessionId = state?.sessionId ?? triggeredSessionId;
    if (!resolvedSessionId) {
      throw new Error(
        "TriggerChatTransport: triggerTask did not return a sessionId. Use chat.createTriggerAction on the server to ensure the Session is created before the run is triggered."
      );
    }

    const nextState: ChatSessionState = {
      sessionId: resolvedSessionId,
      runId,
      publicAccessToken,
      lastEventId: state?.lastEventId,
      isStreaming: true,
      skipToTurnComplete: state?.skipToTurnComplete,
    };
    this.sessions.set(chatId, nextState);
    this.notifySessionChange(chatId, nextState);
    return this.subscribeToSessionStream(nextState, abortSignal, chatId, {
      upgradeRetry: { payload, messages },
    });
  };

  /**
   * Send a message to the running task via input stream without disrupting
   * the current streaming response. Use this to send steering/pending messages
   * while the agent is actively streaming.
   *
   * Unlike `sendMessage()` from useChat, this does NOT:
   * - Add the message to useChat's local message state
   * - Cancel the active stream subscription
   * - Start a new response stream
   *
   * The message is delivered to the task's `messagesInput.on()` listener
   * and can be injected between tool-call steps via the `pendingMessages`
   * configuration.
   *
   * @returns `true` if the message was sent, `false` if there's no active session.
   */
  sendPendingMessage = async (
    chatId: string,
    message: UIMessage,
    metadata?: Record<string, unknown>
  ): Promise<boolean> => {
    const state = this.sessions.get(chatId);
    if (!state?.runId) return false;

    const mergedMetadata =
      this.defaultMetadata || metadata
        ? { ...(this.defaultMetadata ?? {}), ...(metadata ?? {}) }
        : undefined;

    const payload = {
      messages: [message],
      chatId,
      trigger: "submit-message" as const,
      metadata: mergedMetadata,
    };

    const sendPending = async (token: string) => {
      const apiClient = new ApiClient(this.baseURL, token);
      await apiClient.appendToSessionStream(
        state.sessionId,
        "in",
        this.serializeInputChunk({ kind: "message", payload })
      );
    };

    try {
      await sendPending(state.publicAccessToken);
      return true;
    } catch (err) {
      if (isRunPatAuthError(err) && this.renewRunAccessToken) {
        const newToken = await this.renewRunPatForSession(chatId, state.runId);
        if (newToken) {
          try {
            await sendPending(newToken);
            return true;
          } catch (err2) {
            throw err2;
          }
        }
        throw err;
      }
      if (isRunPatAuthError(err)) {
        throw err;
      }
      return false;
    }
  };

  reconnectToStream = async (
    options: {
      chatId: string;
      abortSignal?: AbortSignal | undefined;
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk> | null> => {
    const state = this.sessions.get(options.chatId);
    if (!state) return null;

    // No active stream — the last turn completed before the page refreshed.
    // Return null so useChat settles into "ready" state instead of hanging.
    if (!state.isStreaming) return null;

    // Deduplicate: if there's already an active stream for this chatId,
    // return null so the second caller no-ops.
    if (this.activeStreams.has(options.chatId)) return null;

    const abortController = new AbortController();
    this.activeStreams.set(options.chatId, abortController);

    // When the AI SDK (or caller) provides an abortSignal (e.g. from
    // useChat's stop()), use it as the stream signal so stop sends a
    // `{kind: "stop"}` chunk to the session. Fall back to the internal
    // controller for stream lifecycle management.
    const abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, abortController.signal])
      : abortController.signal;

    return this.subscribeToSessionStream(
      state,
      abortSignal,
      options.chatId,
      { sendStopOnAbort: !!options.abortSignal }
    );
  };

  /**
   * Stop the current generation for a chat session.
   *
   * Sends a stop signal to the backend task via input streams and closes
   * the active SSE connection. Use this as your stop button handler —
   * it works for both initial connections and reconnected streams
   * (after page refresh).
   *
   * When the upstream AI SDK fix lands (passing `abortSignal` through
   * `reconnectToStream`), `useChat`'s built-in `stop()` will also work.
   * Until then, use this method for reliable stop behavior.
   *
   * @returns `true` if the stop signal was sent, `false` if there's no active session.
   *
   * @example
   * ```tsx
   * const transport = useTriggerChatTransport({ task: "my-chat", ... });
   * const { messages, sendMessage } = useChat({ transport });
   *
   * <button onClick={() => transport.stopGeneration(chatId)}>Stop</button>
   * ```
   */
  stopGeneration = async (chatId: string): Promise<boolean> => {
    const state = this.sessions.get(chatId);
    if (!state?.sessionId) return false;

    const sendStop = async (token: string) => {
      const api = new ApiClient(this.baseURL, token);
      await api.appendToSessionStream(
        state.sessionId,
        "in",
        this.serializeInputChunk({ kind: "stop" })
      );
    };

    try {
      await sendStop(state.publicAccessToken);
    } catch (err) {
      if (isRunPatAuthError(err) && this.renewRunAccessToken && state.runId) {
        const newToken = await this.renewRunPatForSession(chatId, state.runId);
        if (newToken) {
          try {
            await sendStop(newToken);
          } catch {
            return false;
          }
        } else {
          return false;
        }
      } else {
        return false;
      }
    }

    state.skipToTurnComplete = true;

    // Abort the active stream (if any) to close the SSE connection
    // and end the ReadableStream, causing useChat to finalize.
    const activeStream = this.activeStreams.get(chatId);
    if (activeStream) {
      activeStream.abort();
      this.activeStreams.delete(chatId);
    }

    return true;
  };

  /**
   * Send a custom action to the agent. The action payload is validated
   * against the agent's `actionSchema` on the backend.
   *
   * Actions wake the agent from suspension, fire `onAction`, then trigger
   * a normal `run()` turn so the LLM can respond to the modified state.
   *
   * Returns a `ReadableStream<UIMessageChunk>` for the agent's response,
   * just like `sendMessages`.
   *
   * @example
   * ```ts
   * const stream = await transport.sendAction(chatId, { type: "undo" });
   * ```
   */
  sendAction = async (
    chatId: string,
    action: unknown
  ): Promise<ReadableStream<UIMessageChunk>> => {
    // Multi-tab coordination: prevent sending from a read-only tab
    if (this.coordinator) {
      if (this.coordinator.isReadOnly(chatId)) {
        throw new Error("This chat is active in another tab");
      }
      this.coordinator.claim(chatId);
    }

    const state = this.sessions.get(chatId);

    if (state?.runId) {
      const mergedMetadata = this.defaultMetadata ?? undefined;

      const payload = {
        messages: [] as never[],
        chatId,
        trigger: "action" as const,
        action,
        metadata: mergedMetadata,
      };

      const apiClient = new ApiClient(this.baseURL, state.publicAccessToken);

      const body = this.serializeInputChunk({ kind: "message", payload });

      try {
        await apiClient.appendToSessionStream(state.sessionId, "in", body);
      } catch (err) {
        if (isRunPatAuthError(err) && this.renewRunAccessToken) {
          const newToken = await this.renewRunPatForSession(chatId, state.runId);
          if (newToken) {
            const renewedClient = new ApiClient(this.baseURL, newToken);
            await renewedClient.appendToSessionStream(state.sessionId, "in", body);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      return this.subscribeToSessionStream(state, undefined, chatId);
    }

    throw new Error(`No active session for chatId "${chatId}". Cannot send action.`);
  };

  /**
   * Get the current session state for a chat, suitable for external persistence.
   *
   * Returns `undefined` if no active session exists for this chatId.
   * Persist the returned value to localStorage so it can be restored
   * after a page refresh via `restoreSession()`.
   *
   * @example
   * ```ts
   * const session = transport.getSession(chatId);
   * if (session) {
   *   localStorage.setItem(`session:${chatId}`, JSON.stringify(session));
   * }
   * ```
   */
  getSession = (
    chatId: string
  ):
    | {
        sessionId: string;
        runId?: string;
        publicAccessToken: string;
        lastEventId?: string;
        isStreaming?: boolean;
      }
    | undefined => {
    const state = this.sessions.get(chatId);
    if (!state) return undefined;
    return {
      sessionId: state.sessionId,
      runId: state.runId,
      publicAccessToken: state.publicAccessToken,
      lastEventId: state.lastEventId,
      isStreaming: state.isStreaming,
    };
  };

  /**
   * Update the `onSessionChange` callback.
   * Useful for React hooks that need to update the callback without recreating the transport.
   */
  setOnSessionChange(
    callback:
      | ((
          chatId: string,
          session:
            | {
                sessionId: string;
                runId?: string;
                publicAccessToken: string;
                lastEventId?: string;
                isStreaming?: boolean;
              }
            | null
        ) => void)
      | undefined
  ): void {
    this._onSessionChange = callback;
  }

  /**
   * Update the run PAT renewal callback without recreating the transport.
   */
  setRenewRunAccessToken(fn: TriggerChatTransportOptions["renewRunAccessToken"] | undefined): void {
    this.renewRunAccessToken = fn;
  }

  /**
   * Update the server-side trigger callback without recreating the transport.
   */
  setTriggerTask(
    fn: ((params: TriggerChatTaskParams) => Promise<TriggerChatTaskResult>) | undefined
  ): void {
    this.triggerTaskFn = fn;
  }

  /**
   * Check if a chatId is read-only (another tab is actively sending).
   * Always returns `false` when `multiTab` is not enabled.
   */
  isReadOnly(chatId: string): boolean {
    return this.coordinator?.isReadOnly(chatId) ?? false;
  }

  /**
   * Check if THIS tab currently holds a claim for the chatId
   * (i.e. this tab called sendMessages and the turn is in-flight).
   */
  hasClaim(chatId: string): boolean {
    return this.coordinator?.hasClaim(chatId) ?? false;
  }

  /**
   * Listen for read-only state changes across tabs.
   * The listener receives `(chatId, isReadOnly)`.
   */
  addReadOnlyListener(fn: (chatId: string, isReadOnly: boolean) => void): void {
    this.coordinator?.addListener(fn);
  }

  /** Remove a previously added read-only listener. */
  removeReadOnlyListener(fn: (chatId: string, isReadOnly: boolean) => void): void {
    this.coordinator?.removeListener(fn);
  }

  /** Broadcast messages to other tabs for real-time sync. */
  broadcastMessages(chatId: string, messages: unknown[]): void {
    this.coordinator?.broadcastMessages(chatId, messages);
  }

  /** Listen for message updates from other tabs. */
  addMessagesListener(fn: (chatId: string, messages: unknown[]) => void): void {
    this.coordinator?.addMessagesListener(fn);
  }

  /** Remove a previously added messages listener. */
  removeMessagesListener(fn: (chatId: string, messages: unknown[]) => void): void {
    this.coordinator?.removeMessagesListener(fn);
  }

  /**
   * Clean up resources (BroadcastChannel, heartbeat timers).
   * Call on component unmount when using `multiTab`.
   */
  dispose(): void {
    this.coordinator?.dispose();
    this.coordinator = null;
  }

  /**
   * Inject or update a session for a chat. Useful for resuming conversations
   * from persisted state without recreating the transport.
   */
  setSession(
    chatId: string,
    session: {
      sessionId: string;
      runId?: string;
      publicAccessToken: string;
      lastEventId?: string;
    }
  ): void {
    this.sessions.set(chatId, {
      sessionId: session.sessionId,
      runId: session.runId,
      publicAccessToken: session.publicAccessToken,
      lastEventId: session.lastEventId,
    });
    this.notifySessionChange(chatId, this.sessions.get(chatId)!);
  }

  /**
   * Eagerly trigger a run for a chat before the first message is sent.
   * This allows initialization (DB setup, context loading) to happen
   * while the user is still typing, reducing first-response latency.
   *
   * The task's `onPreload` hook fires immediately. The run then waits
   * for the first message via input stream. When `sendMessages` is called
   * later, it detects the existing session and sends via input stream
   * instead of triggering a new run.
   *
   * No-op if a session already exists for this chatId.
   */
  async preload(
    chatId: string,
    options?: { idleTimeoutInSeconds?: number; metadata?: Record<string, unknown> }
  ): Promise<void> {
    // Don't preload if a run is already live for this chat.
    if (this.sessions.get(chatId)?.runId) return;

    // Deduplicate concurrent preload calls (e.g. React strict mode double-firing effects)
    const pending = this.pendingPreloads.get(chatId);
    if (pending) return pending;

    const doPreload = async () => {
      // Matches sendMessages: on the `triggerTask` callback path, the
      // server action (e.g. `chat.createTriggerAction`) creates the
      // Session with its secret key and returns `sessionId` alongside
      // the run PAT — the browser never needs `write:sessions` itself.
      // On the direct `accessToken` path, do the lazy upsert here so
      // `payload.sessionId` is populated before the run starts.
      let state: ChatSessionState | undefined = this.sessions.get(chatId);
      if (!state?.sessionId && !this.triggerTaskFn) {
        state = await this.ensureSession(chatId);
      }

      const mergedMetadata =
        this.defaultMetadata || options?.metadata
          ? { ...(this.defaultMetadata ?? {}), ...(options?.metadata ?? {}) }
          : undefined;

      const payload = {
        messages: [] as never[],
        chatId,
        ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
        trigger: "preload" as const,
        metadata: mergedMetadata,
        ...(options?.idleTimeoutInSeconds !== undefined
          ? { idleTimeoutInSeconds: options.idleTimeoutInSeconds }
          : {}),
      };

      const result = await this.triggerNewRun(chatId, payload, "preload");

      // The server action's result carries the `sessionId` it created
      // for the triggerTask callback path; adopt it here.
      const adoptedSessionId = result.sessionId ?? state?.sessionId;
      if (!adoptedSessionId) {
        // Neither path surfaced a sessionId — the server action is
        // misconfigured. Keep the preload run but don't notify; the
        // first sendMessage will recover via its own ensureSession.
        return;
      }

      const nextState: ChatSessionState = {
        sessionId: adoptedSessionId,
        runId: result.runId,
        publicAccessToken: result.publicAccessToken,
        lastEventId: state?.lastEventId,
        isStreaming: state?.isStreaming,
        skipToTurnComplete: state?.skipToTurnComplete,
      };
      this.sessions.set(chatId, nextState);
      this.notifySessionChange(chatId, nextState);
    };

    const promise = doPreload().finally(() => {
      this.pendingPreloads.delete(chatId);
    });
    this.pendingPreloads.set(chatId, promise);
    return promise;
  }

  private async resolveAccessToken(params: ResolveChatAccessTokenParams): Promise<string> {
    if (this.staticAccessToken !== undefined) {
      return this.staticAccessToken;
    }
    if (this.resolveAccessTokenFn) {
      return await this.resolveAccessTokenFn(params);
    }
    throw new Error(
      "TriggerChatTransport: accessToken is required for this operation but was not provided."
    );
  }

  private async triggerNewRun(
    chatId: string,
    payload: Record<string, unknown>,
    purpose: "trigger" | "preload"
  ): Promise<{ runId: string; publicAccessToken: string; sessionId?: string }> {
    const autoTags =
      purpose === "preload" ? [`chat:${chatId}`, "preload:true"] : [`chat:${chatId}`];
    const userTags = this.triggerOptions?.tags ?? [];
    const tags = [...autoTags, ...userTags].slice(0, 5);

    if (this.triggerTaskFn) {
      // The server-side callback is expected to (a) create the Session
      // if needed and (b) mint a token scoped to both the run and the
      // session. It returns `sessionId` in its result when it created
      // the session itself.
      return await this.triggerTaskFn({
        payload: payload as TriggerChatTaskParams["payload"],
        options: {
          tags,
          queue: this.triggerOptions?.queue,
          maxAttempts: this.triggerOptions?.maxAttempts,
          machine: this.triggerOptions?.machine,
          priority: this.triggerOptions?.priority,
        },
      });
    }

    const currentToken = await this.resolveAccessToken({ chatId, purpose });
    const apiClient = new ApiClient(this.baseURL, currentToken);

    const triggerResponse = await apiClient.triggerTask(this.taskId, {
      payload,
      options: {
        payloadType: "application/json",
        tags,
        queue: this.triggerOptions?.queue ? { name: this.triggerOptions.queue } : undefined,
        maxAttempts: this.triggerOptions?.maxAttempts,
        machine: this.triggerOptions?.machine,
        priority: this.triggerOptions?.priority,
      },
    });

    const runId = triggerResponse.id;
    const publicAccessToken =
      "publicAccessToken" in triggerResponse
        ? (triggerResponse as { publicAccessToken?: string }).publicAccessToken
        : undefined;

    // In the direct `accessToken` path the session was created by
    // `ensureSession` before this call, so the caller already has the
    // sessionId — no need to surface it back.
    return { runId, publicAccessToken: publicAccessToken ?? currentToken };
  }

  private notifySessionChange(chatId: string, session: ChatSessionState | null): void {
    if (!this._onSessionChange) return;
    if (session) {
      this._onSessionChange(chatId, {
        sessionId: session.sessionId,
        runId: session.runId,
        publicAccessToken: session.publicAccessToken,
        lastEventId: session.lastEventId,
        isStreaming: session.isStreaming,
      });
    } else {
      this._onSessionChange(chatId, null);
    }
  }

  private async renewRunPatForSession(chatId: string, runId: string): Promise<string | undefined> {
    const renew = this.renewRunAccessToken;
    if (!renew) {
      return undefined;
    }

    try {
      const sessionId = this.sessions.get(chatId)?.sessionId;
      const token = await renew({ chatId, runId, sessionId });
      if (typeof token !== "string" || token.length === 0) {
        return undefined;
      }

      const session = this.sessions.get(chatId);
      if (!session || session.runId !== runId) {
        return undefined;
      }

      session.publicAccessToken = token;
      this.notifySessionChange(chatId, session);
      return token;
    } catch {
      return undefined;
    }
  }

  private subscribeToSessionStream(
    state: ChatSessionState,
    abortSignal: AbortSignal | undefined,
    chatId?: string,
    options?: {
      sendStopOnAbort?: boolean;
      /** Payload + messages for re-triggering on trigger:upgrade-required. */
      upgradeRetry?: {
        payload: Record<string, unknown>;
        messages: UIMessage[];
      };
    }
  ): ReadableStream<UIMessageChunk> {
    const sessionId = state.sessionId;
    const accessToken = state.publicAccessToken;

    // Create an internal AbortController so we can terminate the underlying
    // fetch connection when we're done reading (e.g. after intercepting the
    // control chunk). Without this, the SSE connection stays open and leaks.
    const internalAbort = new AbortController();
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, internalAbort.signal])
      : internalAbort.signal;

    // When the caller aborts (user calls stop()), close the SSE connection.
    // Only send a stop chunk to the session if this is a user-initiated
    // stop (sendStopOnAbort), not an internal stream management abort.
    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          if (options?.sendStopOnAbort !== false) {
            state.skipToTurnComplete = true;
            const api = new ApiClient(this.baseURL, state.publicAccessToken);
            api
              .appendToSessionStream(
                sessionId,
                "in",
                this.serializeInputChunk({ kind: "stop" })
              )
              .catch(() => {}); // Best-effort
          }
          internalAbort.abort();
        },
        { once: true }
      );
    }

    const streamUrl = `${this.baseURL}/realtime/v1/sessions/${encodeURIComponent(sessionId)}/out`;

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        const connectSseOnce = async (token: string) => {
          const subscription = new SSEStreamSubscription(streamUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              ...this.extraHeaders,
            },
            signal: combinedSignal,
            timeoutInSeconds: this.streamTimeoutSeconds,
            lastEventId: state.lastEventId,
          });
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
            const opened = await connectSseOnce(accessToken);
            if (opened === null) {
              controller.close();
              return;
            }
            reader = opened.reader;
            primed = opened.primed;
          } catch (e) {
            if (
              isRunPatAuthError(e) &&
              chatId &&
              this.renewRunAccessToken &&
              state.runId
            ) {
              const newToken = await this.renewRunPatForSession(chatId, state.runId);
              if (newToken) {
                const opened = await connectSseOnce(newToken);
                if (opened === null) {
                  controller.close();
                  return;
                }
                reader = opened.reader;
                primed = opened.primed;
              } else {
                controller.error(e instanceof Error ? e : new Error(String(e)));
                return;
              }
            } else if (isRunPatAuthError(e)) {
              controller.error(e instanceof Error ? e : new Error(String(e)));
              return;
            } else {
              throw e;
            }
          }

          let chunkCount = 0;

          try {
            while (true) {
              let value: { id: string; chunk: unknown; timestamp: number };
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

              // Track the last event ID so we can resume from here
              if (value.id) {
                state.lastEventId = value.id;
              }

              // Session SSE subscribers receive the raw record body as a
              // string (the server wraps `{data, id}` for S2). Parse here
              // so the rest of this loop can treat chunks as objects like
              // the old run-scoped stream did.
              let chunkObj: Record<string, unknown> | null = null;
              if (value.chunk != null) {
                if (typeof value.chunk === "string") {
                  try {
                    chunkObj = JSON.parse(value.chunk) as Record<string, unknown>;
                  } catch {
                    chunkObj = null;
                  }
                } else if (typeof value.chunk === "object") {
                  chunkObj = value.chunk as Record<string, unknown>;
                }
              }
              if (!chunkObj) continue;

              const chunk = chunkObj;

              // After a stop, skip leftover chunks from the stopped turn
              // until we see the trigger:turn-complete marker.
              if (state.skipToTurnComplete) {
                if (chunk.type === "trigger:turn-complete") {
                  state.skipToTurnComplete = false;
                  chunkCount = 0;
                }
                continue;
              }

              if (chunk.type === "trigger:upgrade-required" && chatId && options?.upgradeRetry) {
                // Agent requested a version upgrade — re-trigger with the same
                // message on the latest version and pipe the new stream through.
                internalAbort.abort();
                const retryInfo = options.upgradeRetry;
                const previousRunId = state.runId;

                // Keep the sessionId (sessions outlive runs) but clear the
                // runId so triggerNewRun kicks a fresh run on the same session.
                state.runId = undefined;
                this.coordinator?.release(chatId);
                this.notifySessionChange(chatId, state);

                try {
                  const triggerPayload = {
                    ...retryInfo.payload,
                    messages: retryInfo.messages,
                    sessionId,
                    continuation: true,
                    ...(previousRunId ? { previousRunId } : {}),
                  };

                  const { runId: newRunId, publicAccessToken: newToken } =
                    await this.triggerNewRun(chatId, triggerPayload, "trigger");

                  state.runId = newRunId;
                  state.publicAccessToken = newToken;
                  this.sessions.set(chatId, state);
                  this.notifySessionChange(chatId, state);

                  // Subscribe to the new run's session stream and pipe through
                  const newStream = this.subscribeToSessionStream(
                    state,
                    abortSignal,
                    chatId
                  );
                  const newReader = newStream.getReader();
                  try {
                    while (true) {
                      const next = await newReader.read();
                      if (next.done) break;
                      controller.enqueue(next.value);
                    }
                  } finally {
                    newReader.releaseLock();
                  }
                } catch (retryError) {
                  controller.error(retryError);
                  return;
                }
                try {
                  controller.close();
                } catch {
                  // Controller may already be closed
                }
                return;
              }

              if (chunk.type === "trigger:turn-complete" && chatId) {
                // Update token if a refreshed one was provided in the chunk
                if (typeof chunk.publicAccessToken === "string") {
                  state.publicAccessToken = chunk.publicAccessToken;
                }
                // Mark streaming as complete so reconnectToStream doesn't
                // hang on page refresh when no turn is in-flight.
                state.isStreaming = false;
                this.notifySessionChange(chatId, state);

                // Release multi-tab claim so other tabs can send
                this.coordinator?.release(chatId);

                // Broadcast session to other tabs so they have the latest
                // lastEventId (prevents replaying old SSE events on next send)
                this.coordinator?.broadcastSession(chatId, {
                  lastEventId: state.lastEventId,
                });

                // Watch mode: keep the subscription open across turn
                // boundaries so the consumer sees turn 2, 3, etc. through
                // a single long-lived ReadableStream. Filter the control
                // chunk and continue the read loop instead of closing.
                if (this.watchMode) {
                  continue;
                }

                internalAbort.abort();
                try {
                  controller.close();
                } catch {
                  // Controller may already be closed
                }
                return;
              }

              chunkCount++;
              controller.enqueue(chunk as unknown as UIMessageChunk);
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
        } finally {
          // Release multi-tab claim when the stream closes for any reason
          // (turn-complete, error, abort, stream end)
          if (chatId) {
            this.coordinator?.release(chatId);
          }
        }
      },
    });
  }
}

/**
 * Creates a new `TriggerChatTransport` instance.
 *
 * @example
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * import { createChatTransport } from "@trigger.dev/sdk/chat";
 *
 * const transport = createChatTransport({
 *   task: "my-chat-task",
 *   accessToken: publicAccessToken,
 * });
 *
 * function Chat() {
 *   const { messages, sendMessage } = useChat({ transport });
 * }
 * ```
 */
export function createChatTransport(options: TriggerChatTransportOptions): TriggerChatTransport {
  return new TriggerChatTransport(options);
}

// Server-side agent chat
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
