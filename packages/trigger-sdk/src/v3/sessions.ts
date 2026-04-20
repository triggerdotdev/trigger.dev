import type {
  ApiPromise,
  ApiRequestOptions,
  AsyncIterableStream,
  CloseSessionRequestBody,
  CreatedSessionResponseBody,
  CreateSessionRequestBody,
  ListSessionsOptions,
  ListedSessionItem,
  RetrieveSessionResponseBody,
  UpdateSessionRequestBody,
} from "@trigger.dev/core/v3";
import {
  CursorPagePromise,
  accessoryAttributes,
  apiClientManager,
  mergeRequestOptions,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

export type {
  CreatedSessionResponseBody,
  CreateSessionRequestBody,
  CloseSessionRequestBody,
  ListSessionsOptions,
  ListedSessionItem,
  RetrieveSessionResponseBody,
  UpdateSessionRequestBody,
};

export const sessions = {
  create: createSession,
  retrieve: retrieveSession,
  update: updateSession,
  close: closeSession,
  list: listSessions,
  open,
};

/**
 * Create a {@link Session} — a durable, typed, bidirectional I/O primitive
 * that outlives a single run. Idempotent via `externalId`.
 */
function createSession(
  body: CreateSessionRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<CreatedSessionResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "sessions.create()",
      icon: "sessions",
      attributes: sessionAttributes(body.externalId ?? body.type, {
        type: body.type,
        ...(body.externalId ? { externalId: body.externalId } : {}),
      }),
    },
    requestOptions
  );

  return apiClient.createSession(body, $requestOptions);
}

/**
 * Retrieve a Session by `friendlyId` (`session_*`) or user-supplied
 * `externalId`. The server disambiguates via the `session_` prefix.
 */
function retrieveSession(
  sessionIdOrExternalId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveSessionResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "sessions.retrieve()",
      icon: "sessions",
      attributes: sessionAttributes(sessionIdOrExternalId),
    },
    requestOptions
  );

  return apiClient.retrieveSession(sessionIdOrExternalId, $requestOptions);
}

/** Update mutable fields on a Session (tags, metadata, externalId). */
function updateSession(
  sessionIdOrExternalId: string,
  body: UpdateSessionRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveSessionResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "sessions.update()",
      icon: "sessions",
      attributes: sessionAttributes(sessionIdOrExternalId),
    },
    requestOptions
  );

  return apiClient.updateSession(sessionIdOrExternalId, body, $requestOptions);
}

/** Mark a Session as closed (terminal, idempotent). */
function closeSession(
  sessionIdOrExternalId: string,
  body?: CloseSessionRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveSessionResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "sessions.close()",
      icon: "sessions",
      attributes: sessionAttributes(sessionIdOrExternalId, {
        ...(body?.reason ? { reason: body.reason } : {}),
      }),
    },
    requestOptions
  );

  return apiClient.closeSession(sessionIdOrExternalId, body, $requestOptions);
}

/**
 * List Sessions in the current environment with filters + cursor pagination.
 * Returns a {@link CursorPagePromise} so callers can iterate pages with
 * `for await`.
 */
function listSessions(
  options?: ListSessionsOptions,
  requestOptions?: ApiRequestOptions
): CursorPagePromise<typeof ListedSessionItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "sessions.list()",
      icon: "sessions",
      attributes: {
        ...(options?.type ? { type: toAttr(options.type) } : {}),
        ...(options?.tag ? { tag: toAttr(options.tag) } : {}),
        ...(options?.status ? { status: toAttr(options.status) } : {}),
        ...(options?.externalId ? { externalId: options.externalId } : {}),
      },
    },
    requestOptions
  );

  return apiClient.listSessions(options, $requestOptions);
}

/**
 * Open a lightweight handle to a Session's realtime channels. Does not
 * perform a network call on its own — each channel method hits the
 * corresponding realtime endpoint.
 */
function open(sessionIdOrExternalId: string): SessionHandle {
  return new SessionHandle(sessionIdOrExternalId);
}

export class SessionHandle {
  public readonly out: SessionChannel;
  public readonly in: SessionChannel;

  constructor(public readonly id: string) {
    this.out = new SessionChannel(id, "out");
    this.in = new SessionChannel(id, "in");
  }
}

export type SessionChannelCredentials = {
  accessToken: string;
  basin: string;
  streamName: string;
  endpoint?: string;
  flushIntervalMs?: number;
  maxRetries?: number;
};

/** One direction of a Session's bidirectional channel pair. */
export class SessionChannel {
  constructor(
    public readonly sessionId: string,
    public readonly io: "out" | "in"
  ) {}

  /**
   * Append a single record to this channel via the server-side append
   * endpoint. For high-throughput writes use {@link initialize} to get S2
   * credentials and write directly to S2.
   */
  async append(part: string | unknown, requestOptions?: ApiRequestOptions): Promise<void> {
    const apiClient = apiClientManager.clientOrThrow();
    const body = typeof part === "string" ? part : JSON.stringify(part);

    const $requestOptions = mergeRequestOptions(
      {
        tracer,
        name: `sessions.open(${this.sessionId}).${this.io}.append()`,
        icon: "sessions",
        attributes: sessionAttributes(this.sessionId, { io: this.io }),
      },
      requestOptions
    );

    await apiClient.appendToSessionStream(this.sessionId, this.io, body, $requestOptions);
  }

  /**
   * Friendly alias for `channel.append(value)` used on the `.in` channel by
   * clients producing messages for the task runtime.
   */
  send(value: unknown, requestOptions?: ApiRequestOptions): Promise<void> {
    return this.append(value, requestOptions);
  }

  /**
   * Subscribe to SSE records on this channel. Delegates to the shared
   * {@link SSEStreamSubscription} plumbing (auto-retry, Last-Event-ID
   * resume, abort propagation) used by run-scoped realtime streams —
   * session subscribers get the same guarantees.
   */
  async subscribe<T = unknown>(
    options?: SessionSubscribeOptions<T>
  ): Promise<AsyncIterableStream<T>> {
    const apiClient = apiClientManager.clientOrThrow();

    return apiClient.subscribeToSessionStream<T>(this.sessionId, this.io, {
      signal: options?.signal,
      timeoutInSeconds: options?.timeoutInSeconds,
      lastEventId:
        options?.lastEventId != null ? String(options.lastEventId) : undefined,
      onPart: options?.onPart,
      onComplete: options?.onComplete,
      onError: options?.onError,
    });
  }

  /**
   * Fetch S2 credentials for direct-to-S2 writes. Returns the same header
   * bag the server hands to {@link StreamsWriterV2}.
   */
  async initialize(requestOptions?: ApiRequestOptions): Promise<SessionChannelCredentials> {
    const apiClient = apiClientManager.clientOrThrow();

    const $requestOptions = mergeRequestOptions(
      {
        tracer,
        name: `sessions.open(${this.sessionId}).${this.io}.initialize()`,
        icon: "sessions",
        attributes: sessionAttributes(this.sessionId, { io: this.io }),
      },
      requestOptions
    );

    const response = await apiClient.initializeSessionStream(
      this.sessionId,
      this.io,
      $requestOptions
    );

    return {
      accessToken: response.headers["x-s2-access-token"] ?? "",
      basin: response.headers["x-s2-basin"] ?? "",
      streamName: response.headers["x-s2-stream-name"] ?? "",
      endpoint: response.headers["x-s2-endpoint"],
      flushIntervalMs: numHeader(response.headers, "x-s2-flush-interval-ms"),
      maxRetries: numHeader(response.headers, "x-s2-max-retries"),
    };
  }
}

export type SessionSubscribeOptions<T = unknown> = {
  signal?: AbortSignal;
  lastEventId?: string | number;
  /** Timeout in seconds for the underlying long-poll (max 600). */
  timeoutInSeconds?: number;
  /** Called for each SSE event with the full event metadata (id, timestamp). */
  onPart?: (part: { id: string; chunk: T; timestamp: number }) => void;
  /** Called when the server signals end-of-stream. */
  onComplete?: () => void;
  /** Called on unrecoverable errors after the retry budget is exhausted. */
  onError?: (error: Error) => void;
};

// ─── helpers ────────────────────────────────────────────────────────

function sessionAttributes(id: string, extra?: Record<string, string | number | boolean>) {
  return {
    session: id,
    ...(extra ?? {}),
    ...accessoryAttributes({
      items: [{ text: id, variant: "normal" }],
      style: "codepath",
    }),
  };
}

function toAttr(value: string | string[]): string {
  return Array.isArray(value) ? value.join(",") : value;
}

function numHeader(headers: Record<string, string | undefined>, name: string): number | undefined {
  const raw = headers[name];
  if (raw == null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
