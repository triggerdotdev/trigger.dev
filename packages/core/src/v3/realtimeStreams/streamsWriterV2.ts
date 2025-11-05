import { S2, AppendRecord, BatchTransform } from "@s2-dev/streamstore";
import { StreamsWriter } from "./types.js";

export type StreamsWriterV2Options<T = any> = {
  basin: string;
  stream: string;
  accessToken: string;
  source: AsyncIterable<T>;
  signal?: AbortSignal;
  flushIntervalMs?: number; // Used as lingerDuration for BatchTransform (default 200ms)
  maxRetries?: number; // Not used with appendSession, kept for compatibility
  debug?: boolean; // Enable debug logging (default false)
  maxQueuedBytes?: number; // Max queued bytes for appendSession (default 10MB)
};

/**
 * StreamsWriterV2 writes metadata stream data directly to S2 (https://s2.dev).
 *
 * Features:
 * - Direct streaming: Uses S2's appendSession for efficient streaming
 * - Automatic batching: Uses BatchTransform to batch records
 * - No manual buffering: S2 handles buffering internally
 * - Debug logging: Enable with debug: true to see detailed operation logs
 *
 * Example usage:
 * ```typescript
 * const stream = new StreamsWriterV2({
 *   basin: "my-basin",
 *   stream: "my-stream",
 *   accessToken: "s2-token-here",
 *   source: myAsyncIterable,
 *   flushIntervalMs: 200, // Optional: batch linger duration in ms
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
  private readonly debug: boolean;
  private readonly maxQueuedBytes: number;
  private aborted = false;
  private sessionWritable: WritableStream<any> | null = null;

  constructor(private options: StreamsWriterV2Options<T>) {
    this.debug = options.debug ?? false;
    this.s2Client = new S2({ accessToken: options.accessToken });
    this.flushIntervalMs = options.flushIntervalMs ?? 200;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024 * 10; // 10MB default

    this.log(
      `[S2MetadataStream] Initializing: basin=${options.basin}, stream=${options.stream}, flushIntervalMs=${this.flushIntervalMs}, maxQueuedBytes=${this.maxQueuedBytes}`
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

    this.streamPromise = this.initializeServerStream();
  }

  private handleAbort(): void {
    if (this.aborted) {
      return; // Already aborted
    }

    this.aborted = true;
    this.log("[S2MetadataStream] Handling abort - cleaning up resources");

    // Abort the writable stream if it exists
    if (this.sessionWritable) {
      this.sessionWritable
        .abort("Aborted")
        .catch((error) => {
          this.logError("[S2MetadataStream] Error aborting writable stream:", error);
        })
        .finally(() => {
          this.log("[S2MetadataStream] Writable stream aborted");
        });
    }

    this.log("[S2MetadataStream] Abort cleanup complete");
  }

  private createTeeStreams() {
    const readableSource = new ReadableStream<T>({
      start: async (controller) => {
        try {
          let count = 0;

          for await (const value of this.options.source) {
            if (this.aborted) {
              controller.error(new Error("Stream aborted"));
              return;
            }
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

  private async initializeServerStream(): Promise<void> {
    try {
      if (this.aborted) {
        this.log("[S2MetadataStream] Stream initialization aborted");
        return;
      }

      this.log("[S2MetadataStream] Getting S2 basin and stream");
      const basin = this.s2Client.basin(this.options.basin);
      const stream = basin.stream(this.options.stream);

      const session = await stream.appendSession({
        maxQueuedBytes: this.maxQueuedBytes,
      });

      this.sessionWritable = session.writable;

      this.log(`[S2MetadataStream] Starting stream pipeline`);

      // Convert source stream to AppendRecord format and pipe to S2
      await this.serverStream
        .pipeThrough(
          new TransformStream<T, AppendRecord>({
            transform: (chunk, controller) => {
              if (this.aborted) {
                controller.error(new Error("Stream aborted"));
                return;
              }
              // Convert each chunk to JSON string and wrap in AppendRecord
              controller.enqueue(AppendRecord.make(JSON.stringify(chunk)));
            },
          })
        )
        .pipeThrough(
          new BatchTransform({
            lingerDuration: this.flushIntervalMs,
          })
        )
        .pipeTo(session.writable);

      this.log("[S2MetadataStream] Stream pipeline completed successfully");

      // Get final position to verify completion
      const lastAcked = session.lastAckedPosition();

      if (lastAcked?.end) {
        const recordsWritten = lastAcked.end.seq_num;
        this.log(
          `[S2MetadataStream] Written ${recordsWritten} records, ending at seq_num=${lastAcked.end.seq_num}`
        );
      }
    } catch (error) {
      if (this.aborted) {
        this.log("[S2MetadataStream] Stream error occurred but stream was aborted");
        return;
      }
      this.logError("[S2MetadataStream] Error in stream pipeline:", error);
      throw error;
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
