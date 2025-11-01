import { S2 } from "@s2-dev/streamstore";
import { StreamsWriter } from "./types.js";

type LimitFunction = {
  readonly activeCount: number;
  readonly pendingCount: number;
  concurrency: number;
  <Arguments extends unknown[], ReturnType>(
    function_: (...arguments_: Arguments) => PromiseLike<ReturnType> | ReturnType,
    ...arguments_: Arguments
  ): Promise<ReturnType>;
};

export type StreamsWriterV2Options<T = any> = {
  basin: string;
  stream: string;
  accessToken: string;
  limiter: (concurrency: number) => LimitFunction;
  source: AsyncIterable<T>;
  signal?: AbortSignal;
  flushIntervalMs?: number; // How often to flush batched chunks (default 200ms)
  maxRetries?: number; // Max number of retries for failed flushes (default 10)
  debug?: boolean; // Enable debug logging (default false)
};

/**
 * StreamsWriterV2 writes metadata stream data directly to S2 (https://s2.dev).
 *
 * Features:
 * - Batching: Reads chunks as fast as possible and buffers them
 * - Periodic flushing: Flushes buffered chunks every ~200ms (configurable)
 * - Sequential writes: Uses p-limit to ensure writes happen in order
 * - Automatic retries: Retries failed writes with exponential backoff
 * - Debug logging: Enable with debug: true to see detailed operation logs
 *
 * Example usage:
 * ```typescript
 * const stream = new S2MetadataStream({
 *   basin: "my-basin",
 *   stream: "my-stream",
 *   accessToken: "s2-token-here",
 *   source: myAsyncIterable,
 *   flushIntervalMs: 200, // Optional: flush every 200ms
 *   debug: true, // Optional: enable debug logging
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
export class StreamsWriterV2<T = any> implements StreamsWriter {
  private s2Client: S2;
  private serverStream: ReadableStream<T>;
  private consumerStream: ReadableStream<T>;
  private streamPromise: Promise<void>;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly debug: boolean;

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
  private aborted = false;

  constructor(private options: StreamsWriterV2Options<T>) {
    this.limiter = options.limiter(1);
    this.debug = options.debug ?? false;

    this.s2Client = new S2({ accessToken: options.accessToken });
    this.flushIntervalMs = options.flushIntervalMs ?? 200;
    this.maxRetries = options.maxRetries ?? 10;

    this.log(
      `[S2MetadataStream] Initializing: basin=${options.basin}, stream=${options.stream}, flushIntervalMs=${this.flushIntervalMs}, maxRetries=${this.maxRetries}`
    );

    // Check if already aborted
    if (options.signal?.aborted) {
      this.aborted = true;
      this.log("[S2MetadataStream] Signal already aborted, skipping initialization");
      this.serverStream = new ReadableStream<T>();
      this.consumerStream = new ReadableStream<T>();
      this.streamPromise = Promise.resolve();
      return;
    }

    // Set up abort signal handler
    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        this.log("[S2MetadataStream] Abort signal received");
        this.handleAbort();
      });
    }

    const [serverStream, consumerStream] = this.createTeeStreams();
    this.serverStream = serverStream;
    this.consumerStream = consumerStream;

    // Start background task to continuously read from stream into buffer
    this.startBuffering();

    // Start periodic flushing
    this.startPeriodicFlush();

    this.streamPromise = this.initializeServerStream();
  }

  private handleAbort(): void {
    if (this.aborted) {
      return; // Already aborted
    }

    this.aborted = true;
    this.log("[S2MetadataStream] Handling abort - cleaning up resources");

    // Clear flush interval
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
      this.log("[S2MetadataStream] Cleared flush interval");
    }

    // Cancel stream reader
    if (this.streamReader) {
      this.streamReader
        .cancel("Aborted")
        .catch((error) => {
          this.logError("[S2MetadataStream] Error canceling stream reader:", error);
        })
        .finally(() => {
          this.log("[S2MetadataStream] Stream reader canceled");
        });
    }

    // Clear pending flushes
    const pendingCount = this.pendingFlushes.length;
    this.pendingFlushes = [];
    if (pendingCount > 0) {
      this.log(`[S2MetadataStream] Cleared ${pendingCount} pending flushes`);
    }

    this.log("[S2MetadataStream] Abort cleanup complete");
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
          controller.error(error);
        }
      },
    });

    return readableSource.tee();
  }

  private startBuffering(): void {
    this.log("[S2MetadataStream] Starting buffering task");
    this.streamReader = this.serverStream.getReader();

    this.bufferReaderTask = (async () => {
      try {
        let chunkCount = 0;

        while (true) {
          // Check if aborted
          if (this.aborted) {
            this.log("[S2MetadataStream] Buffering stopped due to abort signal");
            break;
          }

          const { done, value } = await this.streamReader!.read();

          if (done) {
            this.streamComplete = true;
            this.log(`[S2MetadataStream] Stream complete after ${chunkCount} chunks`);
            break;
          }

          // Check again after async read
          if (this.aborted) {
            this.log("[S2MetadataStream] Buffering stopped due to abort signal");
            break;
          }

          // Add to pending flushes
          this.pendingFlushes.push(value);
          chunkCount++;

          if (chunkCount % 100 === 0) {
            this.log(
              `[S2MetadataStream] Buffered ${chunkCount} chunks, pending flushes: ${this.pendingFlushes.length}`
            );
          }
        }
      } catch (error) {
        this.logError("[S2MetadataStream] Error in buffering task:", error);
        throw error;
      }
    })();
  }

  private startPeriodicFlush(): void {
    this.log(`[S2MetadataStream] Starting periodic flush (every ${this.flushIntervalMs}ms)`);
    this.flushInterval = setInterval(() => {
      this.flush().catch(() => {
        // Errors are already logged in flush()
      });
    }, this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    // Don't flush if aborted
    if (this.aborted) {
      this.log("[S2MetadataStream] Flush skipped due to abort signal");
      return;
    }

    if (this.pendingFlushes.length === 0) {
      return;
    }

    // Take all pending chunks
    const chunksToFlush = this.pendingFlushes.splice(0);
    this.log(`[S2MetadataStream] Flushing ${chunksToFlush.length} chunks to S2`);

    // Add flush to limiter queue to ensure sequential execution
    const flushPromise = this.limiter(async () => {
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

        this.log(`[S2MetadataStream] Successfully flushed ${chunksToFlush.length} chunks`);

        // Reset retry count on success
        this.retryCount = 0;
      } catch (error) {
        // Handle retryable errors
        if (this.isRetryableError(error) && this.retryCount < this.maxRetries) {
          this.retryCount++;
          const delayMs = this.calculateBackoffDelay();

          this.logError(
            `[S2MetadataStream] Flush failed (attempt ${this.retryCount}/${this.maxRetries}), retrying in ${delayMs}ms:`,
            error
          );

          await this.delay(delayMs);

          // Re-add chunks to pending flushes and retry
          this.pendingFlushes.unshift(...chunksToFlush);
          await this.flush();
        } else {
          this.logError(
            `[S2MetadataStream] Flush failed permanently after ${this.retryCount} retries:`,
            error
          );
          throw error;
        }
      }
    });

    this.flushPromises.push(flushPromise);
  }

  private async initializeServerStream(): Promise<void> {
    try {
      this.log("[S2MetadataStream] Waiting for buffer task to complete");
      // Wait for buffer task and all flushes to complete
      await this.bufferReaderTask;

      // Skip final flush if aborted
      if (this.aborted) {
        this.log("[S2MetadataStream] Stream initialization aborted");
        return;
      }

      this.log(
        `[S2MetadataStream] Buffer task complete, performing final flush (${this.pendingFlushes.length} pending chunks)`
      );
      // Final flush
      await this.flush();

      this.log(`[S2MetadataStream] Waiting for ${this.flushPromises.length} flush promises`);
      // Wait for all pending flushes
      await Promise.all(this.flushPromises);

      this.log("[S2MetadataStream] Stream completed successfully");
    } finally {
      // Clean up interval to prevent timer leak
      this.log("[S2MetadataStream] Cleaning up flush interval");
      if (this.flushInterval) {
        clearInterval(this.flushInterval);
        this.flushInterval = null;
      }
    }
  }

  public async wait(): Promise<void> {
    await this.streamPromise;
  }

  public [Symbol.asyncIterator]() {
    return streamToAsyncIterator(this.consumerStream);
  }

  // Helper methods

  private log(message: string): void {
    if (this.debug) {
      console.log(message);
    }
  }

  private logError(message: string, error?: any): void {
    if (this.debug) {
      console.error(message, error);
    }
  }

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
