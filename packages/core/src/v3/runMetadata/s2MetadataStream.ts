import { S2 } from "@s2-dev/streamstore";
import type { StreamInstance } from "./types.js";

type LimitFunction = {
  readonly activeCount: number;
  readonly pendingCount: number;
  concurrency: number;
  <Arguments extends unknown[], ReturnType>(
    function_: (...arguments_: Arguments) => PromiseLike<ReturnType> | ReturnType,
    ...arguments_: Arguments
  ): Promise<ReturnType>;
};

export type S2MetadataStreamOptions<T = any> = {
  basin: string;
  stream: string;
  accessToken: string;
  limiter: (concurrency: number) => LimitFunction;
  source: AsyncIterable<T>;
  signal?: AbortSignal;
  flushIntervalMs?: number; // How often to flush batched chunks (default 200ms)
  maxRetries?: number; // Max number of retries for failed flushes (default 10)
};

/**
 * S2MetadataStream writes metadata stream data directly to S2 (https://s2.dev).
 *
 * Features:
 * - Batching: Reads chunks as fast as possible and buffers them
 * - Periodic flushing: Flushes buffered chunks every ~200ms (configurable)
 * - Sequential writes: Uses p-limit to ensure writes happen in order
 * - Automatic retries: Retries failed writes with exponential backoff
 *
 * Example usage:
 * ```typescript
 * const stream = new S2MetadataStream({
 *   basin: "my-basin",
 *   stream: "my-stream",
 *   accessToken: "s2-token-here",
 *   source: myAsyncIterable,
 *   flushIntervalMs: 200, // Optional: flush every 200ms
 * });
 *
 * // Wait for streaming to complete
 * await stream.wait();
 *
 * // Or consume the stream
 * for await (const value of stream) {
 *   console.log(value);
 * }
 * ```
 */
export class S2MetadataStream<T = any> implements StreamInstance {
  private s2Client: S2;
  private serverStream: ReadableStream<T>;
  private consumerStream: ReadableStream<T>;
  private streamPromise: Promise<void>;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;

  // Buffering state
  private streamComplete = false;
  private streamReader: ReadableStreamDefaultReader<T> | null = null;
  private bufferReaderTask: Promise<void> | null = null;

  // Flushing state
  private pendingFlushes: Array<T> = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private flushPromises: Promise<void>[] = [];
  private limiter: LimitFunction;
  private retryCount = 0;
  private readonly baseDelayMs = 1000;
  private readonly maxDelayMs = 30000;

  constructor(private options: S2MetadataStreamOptions<T>) {
    this.limiter = options.limiter(1);

    this.s2Client = new S2({ accessToken: options.accessToken });
    this.flushIntervalMs = options.flushIntervalMs ?? 200;
    this.maxRetries = options.maxRetries ?? 10;

    const [serverStream, consumerStream] = this.createTeeStreams();
    this.serverStream = serverStream;
    this.consumerStream = consumerStream;

    // Start background task to continuously read from stream into buffer
    this.startBuffering();

    // Start periodic flushing
    this.startPeriodicFlush();

    this.streamPromise = this.initializeServerStream();
  }

  private createTeeStreams() {
    const readableSource = new ReadableStream<T>({
      start: async (controller) => {
        try {
          let count = 0;

          for await (const value of this.options.source) {
            controller.enqueue(value);
            count++;
          }

          controller.close();
        } catch (error) {
          console.error("[S2MetadataStream] Error reading from source", error);
          controller.error(error);
        }
      },
    });

    return readableSource.tee();
  }

  private startBuffering(): void {
    this.streamReader = this.serverStream.getReader();

    this.bufferReaderTask = (async () => {
      try {
        let chunkCount = 0;

        while (true) {
          const { done, value } = await this.streamReader!.read();

          if (done) {
            this.streamComplete = true;
            break;
          }

          // Add to pending flushes
          this.pendingFlushes.push(value);
          chunkCount++;
        }
      } catch (error) {
        throw error;
      }
    })();
  }

  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flush().catch(() => {
        // Errors are already logged in flush()
      });
    }, this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    if (this.pendingFlushes.length === 0) {
      return;
    }

    // Take all pending chunks
    const chunksToFlush = this.pendingFlushes.splice(0);

    // Add flush to limiter queue to ensure sequential execution
    const flushPromise = this.limiter(async () => {
      const startTime = Date.now();
      try {
        // Convert chunks to S2 record format (body as JSON string)
        const records = chunksToFlush.map((data) => ({
          body: JSON.stringify(data),
        }));

        await this.s2Client.records.append({
          stream: this.options.stream,
          s2Basin: this.options.basin,
          appendInput: { records },
        });

        const duration = Date.now() - startTime;

        // Reset retry count on success
        this.retryCount = 0;
      } catch (error) {
        console.error("[S2MetadataStream] Flush error", {
          error,
          count: chunksToFlush.length,
          retryCount: this.retryCount,
        });

        // Handle retryable errors
        if (this.isRetryableError(error) && this.retryCount < this.maxRetries) {
          this.retryCount++;
          const delayMs = this.calculateBackoffDelay();

          await this.delay(delayMs);

          // Re-add chunks to pending flushes and retry
          this.pendingFlushes.unshift(...chunksToFlush);
          await this.flush();
        } else {
          console.error("[S2MetadataStream] Max retries exceeded or non-retryable error", {
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
          });
          throw error;
        }
      }
    });

    this.flushPromises.push(flushPromise);
  }

  private async initializeServerStream(): Promise<void> {
    // Wait for buffer task and all flushes to complete
    await this.bufferReaderTask;

    // Final flush
    await this.flush();

    // Wait for all pending flushes
    await Promise.all(this.flushPromises);

    // Clean up
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  public async wait(): Promise<void> {
    await this.streamPromise;
  }

  public [Symbol.asyncIterator]() {
    return streamToAsyncIterator(this.consumerStream);
  }

  // Helper methods

  private isRetryableError(error: any): boolean {
    if (!error) return false;

    // Check for network/connection errors
    const retryableErrors = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ];

    if (error.code && retryableErrors.includes(error.code)) {
      return true;
    }

    // Check for retryable HTTP status codes
    if (error.status) {
      const status = Number(error.status);
      if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
        return true;
      }
    }

    return false;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateBackoffDelay(): number {
    // Exponential backoff with jitter
    const exponentialDelay = this.baseDelayMs * Math.pow(2, this.retryCount);
    const jitter = Math.random() * 1000;
    return Math.min(exponentialDelay + jitter, this.maxDelayMs);
  }
}

async function* streamToAsyncIterator<T>(stream: ReadableStream<T>): AsyncIterableIterator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    safeReleaseLock(reader);
  }
}

function safeReleaseLock(reader: ReadableStreamDefaultReader<any>) {
  try {
    reader.releaseLock();
  } catch (error) {}
}
