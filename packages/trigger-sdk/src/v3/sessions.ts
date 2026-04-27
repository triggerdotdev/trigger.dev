import type {
  ApiPromise,
  ApiRequestOptions,
  AsyncIterableStream,
  CloseSessionRequestBody,
  CreatedSessionResponseBody,
  CreateSessionRequestBody,
  InputStreamOnceOptions,
  InputStreamOnceResult,
  InputStreamWaitOptions,
  InputStreamWaitWithIdleTimeoutOptions,
  ListSessionsOptions,
  ListedSessionItem,
  PipeStreamOptions,
  PipeStreamResult,
  RetrieveSessionResponseBody,
  UpdateSessionRequestBody,
  WriterStreamOptions,
} from "@trigger.dev/core/v3";
import {
  CursorPagePromise,
  InputStreamOncePromise,
  ManualWaitpointPromise,
  SemanticInternalAttributes,
  SessionStreamInstance,
  WaitpointTimeoutError,
  accessoryAttributes,
  apiClientManager,
  ensureReadableStream,
  mergeRequestOptions,
  runtime,
  sessionStreams,
  taskContext,
} from "@trigger.dev/core/v3";
import { conditionallyImportAndParsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { SpanStatusCode } from "@opentelemetry/api";
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
  start: startSession,
  retrieve: retrieveSession,
  update: updateSession,
  close: closeSession,
  list: listSessions,
  open,
};

// Test hook: lets `@trigger.dev/sdk/ai/test` replace `sessions.open()` with
// an in-memory handle so unit tests don't hit the network. Not part of the
// public API — only `mockChatAgent` installs it.
type SessionOpenImpl = (sessionIdOrExternalId: string) => SessionHandle;
let sessionOpenImpl: SessionOpenImpl | undefined;

export function __setSessionOpenImplForTests(impl: SessionOpenImpl | undefined): void {
  sessionOpenImpl = impl;
}

// Test hook for `sessions.start()`. Sessions are task-bound and the
// `start` call atomically creates the row + triggers the first run on
// the server; in unit tests there's no live API to hit, so a fixture
// implementation can be installed via this setter.
type SessionStartImpl = (
  body: CreateSessionRequestBody
) => Promise<CreatedSessionResponseBody> | CreatedSessionResponseBody;
let sessionStartImpl: SessionStartImpl | undefined;

export function __setSessionStartImplForTests(impl: SessionStartImpl | undefined): void {
  sessionStartImpl = impl;
}

/**
 * Start a {@link Session} — a durable, task-bound, bidirectional I/O
 * primitive. The server creates the row (idempotent on `externalId`)
 * and triggers the first run from `triggerConfig` in one round-trip.
 * Returns the new run's id and a session-scoped public access token
 * for browser-side use against `.in/append`, `.out` SSE, and
 * `end-and-continue`.
 *
 * If a session with the same `(env, externalId)` already exists,
 * returns the existing row plus the live (or freshly re-triggered) run.
 * Two browser tabs of the same chat converge to one session.
 */
function startSession(
  body: CreateSessionRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<CreatedSessionResponseBody> {
  if (sessionStartImpl) {
    const result = sessionStartImpl(body);
    return Promise.resolve(result) as ApiPromise<CreatedSessionResponseBody>;
  }

  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "sessions.start()",
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
  if (sessionOpenImpl) return sessionOpenImpl(sessionIdOrExternalId);
  return new SessionHandle(sessionIdOrExternalId);
}

export class SessionHandle {
  /**
   * Producer-to-consumer channel: the task writes records; external
   * clients read them. Mirrors `streams.define` — `append` / `pipe` /
   * `writer` / `read`.
   */
  public readonly out: SessionOutputChannel;

  /**
   * Consumer-to-producer channel: external clients call `.send()`; the
   * task consumes via `.on` / `.once` / `.peek` / `.wait` /
   * `.waitWithIdleTimeout`. Mirrors `streams.input` but keyed on the
   * session so a conversation can survive across run boundaries.
   */
  public readonly in: SessionInputChannel;

  constructor(
    public readonly id: string,
    overrides?: { in?: SessionInputChannel; out?: SessionOutputChannel }
  ) {
    this.out = overrides?.out ?? new SessionOutputChannel(id);
    this.in = overrides?.in ?? new SessionInputChannel(id);
  }
}

/**
 * Options accepted by {@link SessionOutputChannel.pipe}. Session-scoped,
 * so it omits the `target` field (self/parent/root/runId) that run-scoped
 * {@link PipeStreamOptions} uses — the session is the target.
 */
export type SessionPipeStreamOptions = Omit<PipeStreamOptions, "target">;

/**
 * The `.out` side of a Session's bidirectional channel pair. Mirrors the
 * consume-side of {@link streams.define}: `pipe` / `writer` / `append`
 * for the task to produce records, `read` for external clients to
 * consume via SSE. S2 credentials for direct writes are fetched
 * internally by `pipe`/`writer` — there's no public `initialize()`.
 */
export class SessionOutputChannel {
  constructor(public readonly sessionId: string) {}

  /**
   * Append a single record. Routes through {@link writer} internally so
   * subscribers receive the same parsed-object shape as multi-record
   * writes — the server-side append endpoint wraps the body in a string,
   * which would give SSE consumers a JSON-string instead of an object.
   * Mirrors how `streams.define.append` delegates to `streams.writer`.
   */
  async append<T>(value: T, options?: SessionPipeStreamOptions): Promise<void> {
    const { waitUntilComplete } = this.writer<T>({
      ...options,
      spanName: "sessions.append()",
      execute: ({ write }) => {
        write(value);
      },
    });
    await waitUntilComplete();
  }

  /**
   * Pipe an `AsyncIterable` / `ReadableStream` directly to S2. Fetches
   * session S2 credentials internally and streams through
   * {@link SessionStreamInstance}. Parallel to {@link streams.pipe} but
   * session-scoped — no `target` option because the session is the target.
   */
  pipe<T>(
    value: AsyncIterable<T> | ReadableStream<T>,
    options?: SessionPipeStreamOptions
  ): PipeStreamResult<T> {
    return this.#pipeInternal(value, options, "sessions.pipe()");
  }

  /**
   * Mirror of {@link streams.writer}: runs `execute({ write, merge })`
   * against an in-memory queue whose records are piped to S2. Returns
   * `{ stream, waitUntilComplete }` so callers can observe the local
   * stream and await completion. Span is collapsible via `options.spanName`
   * / `options.collapsed`.
   */
  writer<T>(options: WriterStreamOptions<T>): PipeStreamResult<T> {
    let controller!: ReadableStreamDefaultController<T>;
    const ongoingStreamPromises: Promise<void>[] = [];

    const stream = new ReadableStream<T>({
      start(controllerArg) {
        controller = controllerArg;
      },
    });

    const safeEnqueue = (data: T) => {
      try {
        controller.enqueue(data);
      } catch {
        // Suppress errors when the stream has been closed.
      }
    };

    try {
      const result = options.execute({
        write(part) {
          safeEnqueue(part);
        },
        merge(streamArg) {
          ongoingStreamPromises.push(
            (async () => {
              const reader = streamArg.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                safeEnqueue(value);
              }
            })().catch((error) => {
              console.error(error);
            })
          );
        },
      });

      if (result) {
        ongoingStreamPromises.push(
          result.catch((error) => {
            console.error(error);
          })
        );
      }
    } catch (error) {
      console.error(error);
    }

    const waitForStreams: Promise<void> = new Promise((resolve, reject) => {
      (async () => {
        while (ongoingStreamPromises.length > 0) {
          await ongoingStreamPromises.shift();
        }
        resolve();
      })().catch(reject);
    });

    waitForStreams.finally(() => {
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    });

    return this.#pipeInternal(stream, options, options.spanName ?? "sessions.writer()");
  }

  /**
   * Subscribe to SSE records on `.out`. Returns an async-iterable stream —
   * auto-retry, Last-Event-ID resume, and abort propagation come from the
   * shared {@link SSEStreamSubscription} plumbing used by run-scoped
   * realtime streams.
   */
  async read<T = unknown>(
    options?: SessionSubscribeOptions<T>
  ): Promise<AsyncIterableStream<T>> {
    const apiClient = apiClientManager.clientOrThrow();

    return apiClient.subscribeToSessionStream<T>(this.sessionId, "out", {
      signal: options?.signal,
      timeoutInSeconds: options?.timeoutInSeconds,
      lastEventId:
        options?.lastEventId != null ? String(options.lastEventId) : undefined,
      onPart: options?.onPart,
      onComplete: options?.onComplete,
      onError: options?.onError,
    });
  }

  #pipeInternal<T>(
    value: AsyncIterable<T> | ReadableStream<T>,
    options: SessionPipeStreamOptions | undefined,
    spanName: string
  ): PipeStreamResult<T> {
    const apiClient = apiClientManager.clientOrThrow();
    const collapsed = (options as WriterStreamOptions<T> | undefined)?.collapsed;

    const span = tracer.startSpan(spanName, {
      attributes: {
        session: this.sessionId,
        io: "out",
        [SemanticInternalAttributes.ENTITY_TYPE]: "session-stream",
        [SemanticInternalAttributes.ENTITY_ID]: `${this.sessionId}:out`,
        [SemanticInternalAttributes.STYLE_ICON]: "sessions",
        ...(collapsed ? { [SemanticInternalAttributes.COLLAPSED]: true } : {}),
        ...accessoryAttributes({
          items: [{ text: `${this.sessionId}.out`, variant: "normal" }],
          style: "codepath",
        }),
      },
    });

    const readableStreamSource = ensureReadableStream(value);

    const abortController = new AbortController();
    const combinedSignal = options?.signal
      ? AbortSignal.any?.([options.signal, abortController.signal]) ?? abortController.signal
      : abortController.signal;

    try {
      const instance = new SessionStreamInstance<T>({
        apiClient,
        baseUrl: apiClientManager.baseURL ?? "",
        sessionId: this.sessionId,
        io: "out",
        source: readableStreamSource,
        signal: combinedSignal,
        requestOptions: options?.requestOptions,
      });

      instance.wait().finally(() => {
        span.end();
      });

      return {
        stream: instance.stream,
        waitUntilComplete: async () => {
          return instance.wait();
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        span.end();
        throw error;
      }

      if (error instanceof Error || typeof error === "string") {
        span.recordException(error);
      } else {
        span.recordException(String(error));
      }

      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();

      throw error;
    }
  }
}

/**
 * The `.in` side of a Session's bidirectional channel pair. Mirrors
 * {@link streams.input} — consumer-side primitives for the task
 * (`on`/`once`/`peek`/`wait`/`waitWithIdleTimeout`) plus `send` for
 * external clients. Keyed on the session rather than the run so a
 * conversation can survive across run boundaries.
 */
export class SessionInputChannel {
  constructor(public readonly sessionId: string) {}

  /**
   * Send a single record to the channel. Called by external clients
   * (browser, server action, another task) producing input for the run.
   * Matches {@link streams.input.send} but session-scoped — the session
   * is the address, no `runId` required.
   */
  async send(value: unknown, requestOptions?: ApiRequestOptions): Promise<void> {
    const apiClient = apiClientManager.clientOrThrow();
    const body = typeof value === "string" ? value : JSON.stringify(value);

    const $requestOptions = mergeRequestOptions(
      {
        tracer,
        name: `sessions.open(${this.sessionId}).in.send()`,
        icon: "sessions",
        attributes: sessionAttributes(this.sessionId, { io: "in" }),
      },
      requestOptions
    );

    await apiClient.appendToSessionStream(this.sessionId, "in", body, $requestOptions);
  }

  /**
   * Register a handler that fires for every record landing on `.in`.
   * Handlers are flushed with any buffered records on attach and cleaned
   * up automatically when the task run completes. Returns `{ off }` to
   * unsubscribe early.
   */
  on<T = unknown>(handler: (data: T) => void | Promise<void>): { off: () => void } {
    return sessionStreams.on(
      this.sessionId,
      "in",
      handler as (data: unknown) => void | Promise<void>
    );
  }

  /**
   * Wait for the next record on `.in` without suspending the run.
   * Returns `{ ok: true, output }` on arrival or `{ ok: false, error }`
   * when the timeout fires. Chain `.unwrap()` to get the data directly.
   */
  once<T = unknown>(options?: InputStreamOnceOptions): InputStreamOncePromise<T> {
    const ctx = taskContext.ctx;
    const runId = ctx?.run.id;

    const innerPromise = sessionStreams.once(this.sessionId, "in", options);

    return new InputStreamOncePromise<T>((resolve, reject) => {
      tracer
        .startActiveSpan(
          options?.spanName ?? `sessions.open(${this.sessionId}).in.once()`,
          async () => {
            const result = await innerPromise;
            resolve(result as InputStreamOnceResult<T>);
          },
          {
            attributes: {
              [SemanticInternalAttributes.STYLE_ICON]: "sessions",
              [SemanticInternalAttributes.ENTITY_TYPE]: "session-stream",
              ...(runId
                ? { [SemanticInternalAttributes.ENTITY_ID]: `${runId}:${this.sessionId}:in` }
                : {}),
              session: this.sessionId,
              io: "in",
              ...accessoryAttributes({
                items: [{ text: `${this.sessionId}.in`, variant: "normal" }],
                style: "codepath",
              }),
            },
          }
        )
        .catch(reject);
    });
  }

  /** Non-blocking peek at the head of the `.in` buffer. */
  peek<T = unknown>(): T | undefined {
    return sessionStreams.peek(this.sessionId, "in") as T | undefined;
  }

  /**
   * Suspend the current run until the next record arrives on `.in`.
   * Unlike {@link once}, `wait()` frees compute while blocked — the
   * run-engine waitpoint holds the run until the session append handler
   * fires it. Only callable from inside `task.run()`.
   */
  wait<T = unknown>(options?: InputStreamWaitOptions): ManualWaitpointPromise<T> {
    return new ManualWaitpointPromise<T>(async (resolve, reject) => {
      try {
        const ctx = taskContext.ctx;

        if (!ctx) {
          throw new Error("session.in.wait() can only be used from inside a task.run()");
        }

        const apiClient = apiClientManager.clientOrThrow();

        const response = await apiClient.createSessionStreamWaitpoint(ctx.run.id, {
          session: this.sessionId,
          io: "in",
          timeout: options?.timeout,
          idempotencyKey: options?.idempotencyKey,
          idempotencyKeyTTL: options?.idempotencyKeyTTL,
          tags: options?.tags,
          lastSeqNum: sessionStreams.lastSeqNum(this.sessionId, "in"),
        });

        const result = await tracer.startActiveSpan(
          options?.spanName ?? `sessions.open(${this.sessionId}).in.wait()`,
          async (span) => {
            const waitResponse = await apiClient.waitForWaitpointToken({
              runFriendlyId: ctx.run.id,
              waitpointFriendlyId: response.waitpointId,
            });

            if (!waitResponse.success) {
              throw new Error("Failed to block on session stream waitpoint");
            }

            // Drop the SSE tail + buffer before suspending so the record
            // delivered via the waitpoint path isn't re-buffered on resume.
            sessionStreams.disconnectStream(this.sessionId, "in");

            const waitResult = await runtime.waitUntil(response.waitpointId);

            const data =
              waitResult.output !== undefined
                ? await conditionallyImportAndParsePacket(
                    {
                      data: waitResult.output,
                      dataType: waitResult.outputType ?? "application/json",
                    },
                    apiClient
                  )
                : undefined;

            if (waitResult.ok) {
              // Advance the seq counter so the SSE tail doesn't replay the
              // record that was consumed via the waitpoint.
              const prevSeq = sessionStreams.lastSeqNum(this.sessionId, "in");
              sessionStreams.setLastSeqNum(this.sessionId, "in", (prevSeq ?? -1) + 1);

              return { ok: true as const, output: data as T };
            } else {
              const error = new WaitpointTimeoutError(data?.message ?? "Timed out");
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              return { ok: false as const, error };
            }
          },
          {
            attributes: {
              [SemanticInternalAttributes.STYLE_ICON]: "wait",
              [SemanticInternalAttributes.ENTITY_TYPE]: "waitpoint",
              [SemanticInternalAttributes.ENTITY_ID]: response.waitpointId,
              session: this.sessionId,
              io: "in",
              ...accessoryAttributes({
                items: [{ text: `${this.sessionId}.in`, variant: "normal" }],
                style: "codepath",
              }),
            },
          }
        );

        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Wait for a record with an idle-then-suspend strategy. Keeps the run
   * active (using compute) for `idleTimeoutInSeconds`, then suspends via
   * {@link wait} if nothing arrives. If a record arrives during the idle
   * phase the run responds without suspending.
   */
  async waitWithIdleTimeout<T = unknown>(
    options: InputStreamWaitWithIdleTimeoutOptions
  ): Promise<{ ok: true; output: T } | { ok: false; error?: Error }> {
    const self = this;
    const spanName =
      options.spanName ?? `sessions.open(${this.sessionId}).in.waitWithIdleTimeout()`;

    return tracer.startActiveSpan(
      spanName,
      async (span) => {
        if (options.idleTimeoutInSeconds > 0) {
          const warm = await sessionStreams.once(self.sessionId, "in", {
            timeoutMs: options.idleTimeoutInSeconds * 1000,
          });
          if (warm.ok) {
            span.setAttribute("wait.resolved", "idle");
            return { ok: true as const, output: warm.output as T };
          }
        }

        if (options.skipSuspend) {
          span.setAttribute("wait.resolved", "skipped");
          return { ok: false as const, error: undefined };
        }

        if (options.onSuspend) {
          await options.onSuspend();
        }

        span.setAttribute("wait.resolved", "suspended");
        const waitResult = await self.wait<T>({
          timeout: options.timeout,
          spanName: "suspended",
        });

        if (waitResult.ok && options.onResume) {
          await options.onResume();
        }

        return waitResult;
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "sessions",
          session: self.sessionId,
          io: "in",
          ...accessoryAttributes({
            items: [{ text: `${self.sessionId}.in`, variant: "normal" }],
            style: "codepath",
          }),
        },
      }
    );
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
