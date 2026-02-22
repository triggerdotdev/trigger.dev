import { ApiClient } from "../apiClient/index.js";
import { InputStreamManager } from "./types.js";
import { InputStreamOnceOptions } from "../realtimeStreams/types.js";

type InputStreamHandler = (data: unknown) => void | Promise<void>;

type OnceWaiter = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

/**
 * InputStreamRecord is the shape of records on the multiplexed __input S2 stream.
 */
interface InputStreamRecord {
  stream: string;
  data: unknown;
  ts: number;
  id: string;
}

export class StandardInputStreamManager implements InputStreamManager {
  private handlers = new Map<string, Set<InputStreamHandler>>();
  private onceWaiters = new Map<string, OnceWaiter[]>();
  private buffer = new Map<string, unknown[]>();
  private tailAbortController: AbortController | null = null;
  private tailPromise: Promise<void> | null = null;
  private currentRunId: string | null = null;

  constructor(
    private apiClient: ApiClient,
    private baseUrl: string,
    private debug: boolean = false
  ) {}

  setRunId(runId: string): void {
    this.currentRunId = runId;
  }

  on(streamId: string, handler: InputStreamHandler): { off: () => void } {
    let handlerSet = this.handlers.get(streamId);
    if (!handlerSet) {
      handlerSet = new Set();
      this.handlers.set(streamId, handlerSet);
    }
    handlerSet.add(handler);

    // Lazily connect the tail on first listener registration
    this.#ensureTailConnected();

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

  once(streamId: string, options?: InputStreamOnceOptions): Promise<unknown> {
    // Lazily connect the tail on first listener registration
    this.#ensureTailConnected();

    // Check buffer first
    const buffered = this.buffer.get(streamId);
    if (buffered && buffered.length > 0) {
      const data = buffered.shift()!;
      if (buffered.length === 0) {
        this.buffer.delete(streamId);
      }
      return Promise.resolve(data);
    }

    return new Promise<unknown>((resolve, reject) => {
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
            this.#removeOnceWaiter(streamId, waiter);
            reject(new Error("Aborted"));
          },
          { once: true }
        );
      }

      // Handle timeout
      if (options?.timeoutMs) {
        waiter.timeoutHandle = setTimeout(() => {
          this.#removeOnceWaiter(streamId, waiter);
          reject(new Error(`Timeout waiting for input stream "${streamId}" after ${options.timeoutMs}ms`));
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

  connectTail(runId: string, _fromSeq?: number): void {
    // Don't create duplicate tails
    if (this.tailAbortController) {
      return;
    }

    this.tailAbortController = new AbortController();

    this.tailPromise = this.#runTail(runId, this.tailAbortController.signal).catch((error) => {
      if (this.debug) {
        console.error("[InputStreamManager] Tail error:", error);
      }
    });
  }

  disconnect(): void {
    if (this.tailAbortController) {
      this.tailAbortController.abort();
      this.tailAbortController = null;
    }
    this.tailPromise = null;
  }

  reset(): void {
    this.disconnect();
    this.currentRunId = null;
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

  #ensureTailConnected(): void {
    if (!this.tailAbortController && this.currentRunId) {
      this.connectTail(this.currentRunId);
    }
  }

  async #runTail(runId: string, signal: AbortSignal): Promise<void> {
    try {
      const stream = await this.apiClient.fetchStream<InputStreamRecord>(
        runId,
        "__input",
        {
          signal,
          baseUrl: this.baseUrl,
          // Long timeout — we want to keep tailing for the duration of the run
          timeoutInSeconds: 3600,
          onComplete: () => {
            if (this.debug) {
              console.log("[InputStreamManager] Tail stream completed");
            }
          },
          onError: (error) => {
            if (this.debug) {
              console.error("[InputStreamManager] Tail stream error:", error);
            }
          },
        }
      );

      for await (const record of stream) {
        if (signal.aborted) break;
        this.#dispatchRecord(record);
      }
    } catch (error) {
      // AbortError is expected when disconnecting
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      throw error;
    }
  }

  #dispatchRecord(record: InputStreamRecord): void {
    const streamId = record.stream;
    const data = record.data;

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
      waiter.resolve(data);
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
