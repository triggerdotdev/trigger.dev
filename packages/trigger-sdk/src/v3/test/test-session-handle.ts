import type {
  AsyncIterableStream,
  PipeStreamResult,
  StreamWriteResult,
  WriterStreamOptions,
} from "@trigger.dev/core/v3";
import { ensureReadableStream } from "@trigger.dev/core/v3";
import {
  SessionHandle,
  SessionInputChannel,
  SessionOutputChannel,
  SessionPipeStreamOptions,
  SessionSubscribeOptions,
} from "../sessions.js";

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
}

/**
 * Construct a {@link SessionHandle} whose `.out` channel captures writes in
 * memory while `.in` reuses the real {@link SessionInputChannel} (which
 * routes through the `sessionStreams` global — the mock task context
 * installs a `TestSessionStreamManager` there).
 */
export function createTestSessionHandle(
  sessionId: string,
  state: TestSessionOutState
): SessionHandle {
  return new SessionHandle(sessionId, {
    in: new SessionInputChannel(sessionId),
    out: new TestSessionOutputChannel(sessionId, state),
  });
}
