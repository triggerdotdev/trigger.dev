import { ApiClient } from "../apiClient/index.js";
import {
  InputStreamManager,
  InputStreamOncePromise,
  InputStreamOnceResult,
  InputStreamTimeoutError,
} from "./types.js";
import { InputStreamOnceOptions } from "../realtimeStreams/types.js";

type InputStreamHandler = (data: unknown) => void | Promise<void>;

type OnceWaiter = {
  resolve: (result: InputStreamOnceResult<unknown>) => void;
  reject: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};


type TailState = {
  abortController: AbortController;
  promise: Promise<void>;
};

export class StandardInputStreamManager implements InputStreamManager {
  private handlers = new Map<string, Set<InputStreamHandler>>();
  private onceWaiters = new Map<string, OnceWaiter[]>();
  private buffer = new Map<string, unknown[]>();
  private tails = new Map<string, TailState>();
  private seqNums = new Map<string, number>();
  private currentRunId: string | null = null;
  private streamsVersion: string | undefined;

  constructor(
    private apiClient: ApiClient,
    private baseUrl: string,
    private debug: boolean = false
  ) {}

  lastSeqNum(streamId: string): number | undefined {
    return this.seqNums.get(streamId);
  }

  setRunId(runId: string, streamsVersion?: string): void {
    this.currentRunId = runId;
    this.streamsVersion = streamsVersion;
  }

  on(streamId: string, handler: InputStreamHandler): { off: () => void } {
    this.#requireV2Streams();

    let handlerSet = this.handlers.get(streamId);
    if (!handlerSet) {
      handlerSet = new Set();
      this.handlers.set(streamId, handlerSet);
    }
    handlerSet.add(handler);

    // Lazily connect a tail for this stream
    this.#ensureStreamTailConnected(streamId);

    // Flush any buffered data for this stream
    const buffered = this.buffer.get(streamId);
    if (buffered && buffered.length > 0) {
      for (const data of buffered) {
        this.#invokeHandler(handler, data);
      }
      this.buffer.delete(streamId);
    }

    return {
      off: () => {
        handlerSet?.delete(handler);
        if (handlerSet?.size === 0) {
          this.handlers.delete(streamId);
        }
      },
    };
  }

  once(streamId: string, options?: InputStreamOnceOptions): InputStreamOncePromise<unknown> {
    this.#requireV2Streams();

    // Lazily connect a tail for this stream
    this.#ensureStreamTailConnected(streamId);

    // Check buffer first
    const buffered = this.buffer.get(streamId);
    if (buffered && buffered.length > 0) {
      const data = buffered.shift()!;
      if (buffered.length === 0) {
        this.buffer.delete(streamId);
      }
      return new InputStreamOncePromise((resolve) => {
        resolve({ ok: true, output: data });
      });
    }

    return new InputStreamOncePromise<unknown>((resolve, reject) => {
      const waiter: OnceWaiter = { resolve, reject };

      // Handle abort signal
      if (options?.signal) {
        if (options.signal.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            if (waiter.timeoutHandle) {
              clearTimeout(waiter.timeoutHandle);
            }
            this.#removeOnceWaiter(streamId, waiter);
            reject(new Error("Aborted"));
          },
          { once: true }
        );
      }

      // Handle timeout — resolve with error result instead of rejecting
      if (options?.timeoutMs) {
        waiter.timeoutHandle = setTimeout(() => {
          this.#removeOnceWaiter(streamId, waiter);
          resolve({
            ok: false,
            error: new InputStreamTimeoutError(streamId, options.timeoutMs!),
          });
        }, options.timeoutMs);
      }

      let waiters = this.onceWaiters.get(streamId);
      if (!waiters) {
        waiters = [];
        this.onceWaiters.set(streamId, waiters);
      }
      waiters.push(waiter);
    });
  }

  peek(streamId: string): unknown | undefined {
    const buffered = this.buffer.get(streamId);
    if (buffered && buffered.length > 0) {
      return buffered[0];
    }
    return undefined;
  }

  clearHandlers(): void {
    this.handlers.clear();

    // Abort tails that no longer have any once waiters either
    for (const [streamId, tail] of this.tails) {
      const hasWaiters = this.onceWaiters.has(streamId) && this.onceWaiters.get(streamId)!.length > 0;
      if (!hasWaiters) {
        tail.abortController.abort();
        this.tails.delete(streamId);
      }
    }
  }

  connectTail(runId: string, _fromSeq?: number): void {
    // No-op: tails are now created per-stream lazily
  }

  disconnect(): void {
    for (const [, tail] of this.tails) {
      tail.abortController.abort();
    }
    this.tails.clear();
  }

  reset(): void {
    this.disconnect();
    this.currentRunId = null;
    this.streamsVersion = undefined;
    this.seqNums.clear();
    this.handlers.clear();

    // Reject all pending once waiters
    for (const [, waiters] of this.onceWaiters) {
      for (const waiter of waiters) {
        if (waiter.timeoutHandle) {
          clearTimeout(waiter.timeoutHandle);
        }
        waiter.reject(new Error("Input stream manager reset"));
      }
    }
    this.onceWaiters.clear();
    this.buffer.clear();
  }

  #requireV2Streams(): void {
    if (this.currentRunId && this.streamsVersion !== "v2") {
      throw new Error(
        "Input streams require v2 realtime streams. Enable them with: { future: { v2RealtimeStreams: true } }"
      );
    }
  }

  #ensureStreamTailConnected(streamId: string): void {
    if (!this.tails.has(streamId) && this.currentRunId) {
      const abortController = new AbortController();
      const promise = this.#runTail(this.currentRunId, streamId, abortController.signal)
        .catch((error) => {
          if (this.debug) {
            console.error(`[InputStreamManager] Tail error for "${streamId}":`, error);
          }
        })
        .finally(() => {
          this.tails.delete(streamId);

          // Auto-reconnect if there are still active handlers or waiters
          const hasHandlers =
            this.handlers.has(streamId) && this.handlers.get(streamId)!.size > 0;
          const hasWaiters =
            this.onceWaiters.has(streamId) && this.onceWaiters.get(streamId)!.length > 0;
          if (hasHandlers || hasWaiters) {
            this.#ensureStreamTailConnected(streamId);
          }
        });
      this.tails.set(streamId, { abortController, promise });
    }
  }

  async #runTail(runId: string, streamId: string, signal: AbortSignal): Promise<void> {
    try {
      const stream = await this.apiClient.fetchStream<unknown>(
        runId,
        `input/${streamId}`,
        {
          signal,
          baseUrl: this.baseUrl,
          // Max allowed by the SSE endpoint is 600s; the tail will reconnect on close
          timeoutInSeconds: 600,
          onPart: (part) => {
            const seqNum = parseInt(part.id, 10);
            if (Number.isFinite(seqNum)) {
              this.seqNums.set(streamId, seqNum);
            }
          },
          onComplete: () => {
            if (this.debug) {
              console.log(`[InputStreamManager] Tail stream completed for "${streamId}"`);
            }
          },
          onError: (error) => {
            if (this.debug) {
              console.error(`[InputStreamManager] Tail stream error for "${streamId}":`, error);
            }
          },
        }
      );

      for await (const record of stream) {
        if (signal.aborted) break;

        // S2 SSE returns record bodies as JSON strings; parse if needed
        let data: unknown;
        if (typeof record === "string") {
          try {
            data = JSON.parse(record);
          } catch {
            data = record;
          }
        } else {
          data = record;
        }

        this.#dispatch(streamId, data);
      }
    } catch (error) {
      // AbortError is expected when disconnecting
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      throw error;
    }
  }

  #dispatch(streamId: string, data: unknown): void {
    // First try to resolve a once waiter
    const waiters = this.onceWaiters.get(streamId);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiters.length === 0) {
        this.onceWaiters.delete(streamId);
      }
      if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle);
      }
      waiter.resolve({ ok: true, output: data });
      // Also invoke persistent handlers
      this.#invokeHandlers(streamId, data);
      return;
    }

    // Invoke persistent handlers
    const handlers = this.handlers.get(streamId);
    if (handlers && handlers.size > 0) {
      this.#invokeHandlers(streamId, data);
      return;
    }

    // No handlers, buffer the data
    let buffered = this.buffer.get(streamId);
    if (!buffered) {
      buffered = [];
      this.buffer.set(streamId, buffered);
    }
    buffered.push(data);
  }

  #invokeHandlers(streamId: string, data: unknown): void {
    const handlers = this.handlers.get(streamId);
    if (!handlers) return;
    for (const handler of handlers) {
      this.#invokeHandler(handler, data);
    }
  }

  #invokeHandler(handler: InputStreamHandler, data: unknown): void {
    try {
      const result = handler(data);
      // If the handler returns a promise, catch errors silently
      if (result && typeof result === "object" && "catch" in result) {
        (result as Promise<void>).catch((error) => {
          if (this.debug) {
            console.error("[InputStreamManager] Handler error:", error);
          }
        });
      }
    } catch (error) {
      if (this.debug) {
        console.error("[InputStreamManager] Handler error:", error);
      }
    }
  }

  #removeOnceWaiter(streamId: string, waiter: OnceWaiter): void {
    const waiters = this.onceWaiters.get(streamId);
    if (!waiters) return;
    const index = waiters.indexOf(waiter);
    if (index !== -1) {
      waiters.splice(index, 1);
    }
    if (waiters.length === 0) {
      this.onceWaiters.delete(streamId);
    }
  }
}
