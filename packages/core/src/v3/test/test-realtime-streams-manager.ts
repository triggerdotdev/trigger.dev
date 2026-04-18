import {
  AsyncIterableStream,
  createAsyncIterableStreamFromAsyncIterable,
} from "../streams/asyncIterableStream.js";
import type {
  RealtimeStreamInstance,
  RealtimeStreamOperationOptions,
  RealtimeStreamsManager,
} from "../realtimeStreams/types.js";

/**
 * In-memory implementation of `RealtimeStreamsManager` for unit tests.
 * Collects every chunk that tasks write via `pipe()` or `append()` into
 * per-stream buffers that tests can inspect.
 *
 * Use this alongside {@link runInMockTaskContext} — not directly.
 */
type WriteListener = (key: string, chunk: unknown) => void;

export class TestRealtimeStreamsManager implements RealtimeStreamsManager {
  private buffers = new Map<string, unknown[]>();
  private pipeWaits = new Map<string, Promise<void>[]>();
  private writeListeners = new Set<WriteListener>();

  pipe<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    _options?: RealtimeStreamOperationOptions
  ): RealtimeStreamInstance<T> {
    const buffer = this.getBuffer(key);
    const self = this;

    // Eagerly drain the source in the background so chunks land in the
    // buffer + notify listeners even when the caller never consumes the
    // returned stream. This mirrors the real SDK behavior: `streams.writer`
    // awaits `instance.wait()`, it doesn't read the returned stream.
    //
    // The source is read ONCE (into a chunks array) and replayed into a
    // ReadableStream so the caller can still consume it if they want.
    const readChunks: T[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    (async () => {
      try {
        const iter =
          source instanceof ReadableStream
            ? (async function* () {
                const reader = source.getReader();
                try {
                  while (true) {
                    const { done: d, value } = await reader.read();
                    if (d) return;
                    yield value as T;
                  }
                } finally {
                  reader.releaseLock();
                }
              })()
            : source;

        for await (const chunk of iter) {
          readChunks.push(chunk);
          buffer.push(chunk);
          self.notify(key, chunk);
        }
      } catch {
        // Swallow — tests can inspect what made it into the buffer
      } finally {
        resolveDone();
      }
    })();

    const replayStream = (async function* () {
      // Wait for all chunks to be drained, then replay from our snapshot
      await done;
      for (const chunk of readChunks) yield chunk;
    })();
    const wrappedStream = createAsyncIterableStreamFromAsyncIterable(replayStream);

    if (!this.pipeWaits.has(key)) this.pipeWaits.set(key, []);
    this.pipeWaits.get(key)!.push(done);

    return {
      wait: () => done.then(() => ({})),
      get stream(): AsyncIterableStream<T> {
        return wrappedStream;
      },
    };
  }

  async append<TPart extends BodyInit>(
    key: string,
    part: TPart,
    _options?: RealtimeStreamOperationOptions
  ): Promise<void> {
    this.getBuffer(key).push(part);
    this.notify(key, part);
  }

  /**
   * Register a listener fired for every chunk written to any stream.
   * Returns an unsubscribe function.
   *
   * Intended for test harnesses that need to react to writes synchronously
   * (e.g. resolving a "turn complete" latch).
   */
  onWrite(listener: WriteListener): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  private notify(key: string, chunk: unknown): void {
    for (const listener of this.writeListeners) {
      try {
        listener(key, chunk);
      } catch {
        // Never let a listener error break stream writes
      }
    }
  }

  // ── Test driver API (not part of RealtimeStreamsManager interface) ──────

  /**
   * Return all chunks written to the given stream key in order of write.
   */
  __chunksFromTest<T = unknown>(key: string): T[] {
    return (this.buffers.get(key) ?? []).slice() as T[];
  }

  /**
   * Return all chunks across every stream, keyed by stream id.
   */
  __allChunksFromTest(): Record<string, unknown[]> {
    const result: Record<string, unknown[]> = {};
    for (const [key, chunks] of this.buffers.entries()) {
      result[key] = chunks.slice();
    }
    return result;
  }

  /**
   * Clear the buffer for a specific stream or all streams.
   */
  __clearFromTest(key?: string): void {
    if (key === undefined) {
      this.buffers.clear();
    } else {
      this.buffers.delete(key);
    }
  }

  reset(): void {
    this.buffers.clear();
    this.pipeWaits.clear();
  }

  private getBuffer(key: string): unknown[] {
    if (!this.buffers.has(key)) {
      this.buffers.set(key, []);
    }
    return this.buffers.get(key)!;
  }
}
