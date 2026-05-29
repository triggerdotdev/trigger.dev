import type {
  AsyncIterableStream,
  PipeStreamResult,
  StreamWriteResult,
  WriterStreamOptions,
} from "@trigger.dev/core/v3";
import { ensureReadableStream, ManualWaitpointPromise } from "@trigger.dev/core/v3";
import {
  SessionHandle,
  SessionInputChannel,
  SessionOutputChannel,
  SessionPipeStreamOptions,
  SessionSubscribeOptions,
} from "../sessions.js";

/**
 * Stub for `SessionInputChannel.wait` that skips the apiClient round-trip
 * the production path makes via `createSessionStreamWaitpoint`. Without
 * this override, every test that exercises the suspend fallback (e.g.
 * the `chat.handover` idle-timeout case) throws `ApiClientMissingError`
 * because `apiClientManager.clientOrThrow()` runs in a test process that
 * has no `TRIGGER_SECRET_KEY`.
 *
 * The promise resolves with `{ ok: false, error }` when the harness
 * aborts its run signal — that mimics production semantics (suspended
 * until something happens, returns cleanly on abort) without making a
 * network call.
 */
class TestSessionInputChannel extends SessionInputChannel {
  constructor(sessionId: string, private readonly getAbortSignal: () => AbortSignal | undefined) {
    super(sessionId);
  }

  // Override only the `wait` path. `on` / `once` / `peek` / `send`
  // continue to flow through the real `sessionStreams` global, which
  // the mock task context installs as a `TestSessionStreamManager`.
  wait<T = unknown>(): ManualWaitpointPromise<T> {
    return new ManualWaitpointPromise<T>((resolve: (value: { ok: false; error: Error }) => void) => {
      const signal = this.getAbortSignal();
      if (!signal) {
        // Harness hasn't wired up its run signal yet — nothing to abort
        // on. Stay pending; the run loop should never reach this state
        // in practice but we don't want to throw here either.
        return;
      }
      const onAbort = () => {
        resolve({
          ok: false,
          error: new Error("session.in.wait() aborted by test harness"),
        });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * Per-session in-memory state collected from `.out` writes during a test.
 * Owned by the mock-chat-agent harness; updated by {@link TestSessionOutputChannel}.
 */
export type TestSessionOutState = {
  /** Every chunk written to `.out`, in order of write. */
  chunks: unknown[];
  /** Registered write listeners (fired for each chunk). */
  listeners: Set<(chunk: unknown) => void>;
};

function notify(state: TestSessionOutState, chunk: unknown): void {
  state.chunks.push(chunk);
  for (const listener of state.listeners) {
    try {
      listener(chunk);
    } catch {
      // Never let a listener error break stream writes
    }
  }
}

async function drainInto<T>(
  source: AsyncIterable<T> | ReadableStream<T>,
  state: TestSessionOutState
): Promise<void> {
  const readable = ensureReadableStream(source);
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      notify(state, value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * `.out` channel that captures writes in memory instead of piping to S2.
 * Mirrors {@link SessionOutputChannel}'s public shape — `pipe` / `writer`
 * / `append` / `read` — so the agent's existing code paths work unchanged.
 */
export class TestSessionOutputChannel extends SessionOutputChannel {
  constructor(
    sessionId: string,
    private readonly state: TestSessionOutState
  ) {
    super(sessionId);
  }

  async append<T>(value: T, _options?: SessionPipeStreamOptions): Promise<void> {
    notify(this.state, value);
  }

  pipe<T>(
    value: AsyncIterable<T> | ReadableStream<T>,
    _options?: SessionPipeStreamOptions
  ): PipeStreamResult<T> {
    const state = this.state;
    const readChunks: T[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    (async () => {
      const readable = ensureReadableStream(value);
      const reader = readable.getReader();
      try {
        while (true) {
          const { done: d, value: v } = await reader.read();
          if (d) return;
          readChunks.push(v as T);
          notify(state, v);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        resolveDone();
      }
    })().catch(() => {
      resolveDone();
    });

    const replayStream = new ReadableStream<T>({
      async start(controller) {
        await done;
        for (const chunk of readChunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const emptyResult: StreamWriteResult = {};

    return {
      get stream(): AsyncIterableStream<T> {
        return replayStream as AsyncIterableStream<T>;
      },
      waitUntilComplete: async () => {
        await done;
        return emptyResult;
      },
    };
  }

  writer<T>(options: WriterStreamOptions<T>): PipeStreamResult<T> {
    let controller!: ReadableStreamDefaultController<T>;
    const ongoing: Promise<void>[] = [];
    const state = this.state;

    const stream = new ReadableStream<T>({
      start(c) {
        controller = c;
      },
    });

    const safeEnqueue = (data: T) => {
      try {
        controller.enqueue(data);
      } catch {
        // Stream already closed
      }
    };

    try {
      const result = options.execute({
        write(part) {
          safeEnqueue(part);
          notify(state, part);
        },
        merge(streamArg) {
          ongoing.push(
            drainInto(streamArg, state).catch(() => {})
          );
        },
      });

      if (result) {
        ongoing.push(result.catch(() => {}));
      }
    } catch {
      // Swallow — tests can inspect state.chunks
    }

    const done: Promise<void> = (async () => {
      while (ongoing.length > 0) {
        await ongoing.shift();
      }
    })().finally(() => {
      try {
        controller.close();
      } catch {
        // Already closed
      }
    });

    const emptyResult: StreamWriteResult = {};

    return {
      get stream(): AsyncIterableStream<T> {
        return stream as AsyncIterableStream<T>;
      },
      waitUntilComplete: async () => {
        await done;
        return emptyResult;
      },
    };
  }

  async read<T>(_options?: SessionSubscribeOptions<T>): Promise<AsyncIterableStream<T>> {
    throw new Error(
      "TestSessionOutputChannel.read() is not supported in the mock-chat-agent harness — " +
        "inspect `harness.allChunks` / `harness.allRawChunks` instead."
    );
  }

  /**
   * Override the one-shot control-record path. In production this goes
   * direct to S2 with header-form records; in tests we project it back
   * into the chunk-shape the harness already understands (the listener
   * watches for `{type: "trigger:turn-complete"}` to drive turn-complete
   * latches). Returns an empty `StreamWriteResult` — tests don't observe
   * the seq_num, and trim seeding only matters in production.
   */
  async writeControl(
    subtype: string,
    extraHeaders?: ReadonlyArray<readonly [string, string]>
  ): Promise<StreamWriteResult> {
    const synthetic: Record<string, unknown> = { type: `trigger:${subtype}` };
    if (extraHeaders) {
      for (const [name, value] of extraHeaders) {
        if (name === "public-access-token") {
          synthetic.publicAccessToken = value;
        }
      }
    }
    notify(this.state, synthetic);
    return {};
  }

  /**
   * No-op in the mock harness. Production trims keep `session.out` bounded;
   * the in-memory `state.chunks` array doesn't need trimming and tests
   * that care about trim behaviour exercise it via the real S2 code path.
   */
  async trimTo(_earliestSeqNum: number): Promise<void> {
    // Intentionally a no-op for the mock harness.
  }
}

/**
 * Construct a {@link SessionHandle} whose `.out` channel captures writes in
 * memory and whose `.in` channel routes through the `sessionStreams`
 * global for record subscriptions (`on` / `once` / `peek`) but stubs
 * `wait()` to skip the apiClient round-trip — see
 * {@link TestSessionInputChannel}.
 *
 * `getAbortSignal` lets the channel observe the harness's run signal so
 * `wait()` resolves cleanly on close. Pass a getter (not the signal
 * directly) so the channel reads it lazily — the harness creates its
 * `AbortController` after the override is installed.
 */
export function createTestSessionHandle(
  sessionId: string,
  state: TestSessionOutState,
  getAbortSignal: () => AbortSignal | undefined = () => undefined
): SessionHandle {
  return new SessionHandle(sessionId, {
    in: new TestSessionInputChannel(sessionId, getAbortSignal),
    out: new TestSessionOutputChannel(sessionId, state),
  });
}
