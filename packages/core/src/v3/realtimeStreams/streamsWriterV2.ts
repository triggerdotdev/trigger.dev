import { S2, AppendRecord, BatchTransform } from "@s2-dev/streamstore";
import { ChatChunkTooLargeError } from "../errors.js";
import { StreamsWriter, StreamWriteResult } from "./types.js";
import { nanoid } from "nanoid";

// S2 caps a single record at 1 MiB of metered bytes (body + headers + 8 byte
// overhead). We give ourselves ~1 KiB of headroom for the JSON envelope and
// metering bytes so the check fires before the SDK's internal `BatchTransform`
// rejects the record with an opaque `S2Error`.
const RECORD_BODY_MAX_BYTES = 1024 * 1024 - 1024;

const utf8Encoder = new TextEncoder();

export type StreamsWriterV2Options<T = any> = {
  basin: string;
  stream: string;
  accessToken: string;
  endpoint?: string; // Custom S2 endpoint (for s2-lite)
  source: ReadableStream<T>;
  signal?: AbortSignal;
  flushIntervalMs?: number; // Used as lingerDuration for BatchTransform (default 200ms)
  maxRetries?: number; // Not used with appendSession, kept for compatibility
  debug?: boolean; // Enable debug logging (default false)
  maxInflightBytes?: number; // Max queued bytes for appendSession (default 10MB)
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
  private readonly maxInflightBytes: number;
  private aborted = false;
  private sessionWritable: WritableStream<any> | null = null;
  private lastSeqNum: number | undefined;

  constructor(private options: StreamsWriterV2Options<T>) {
    this.debug = options.debug ?? false;
    this.s2Client = new S2({
      accessToken: options.accessToken,
      ...(options.endpoint
        ? {
            endpoints: {
              account: options.endpoint,
              basin: options.endpoint,
            },
          }
        : {}),
    });
    this.flushIntervalMs = options.flushIntervalMs ?? 200;
    this.maxInflightBytes = options.maxInflightBytes ?? 1024 * 1024 * 10; // 10MB default

    this.log(
      `[S2MetadataStream] Initializing: basin=${options.basin}, stream=${options.stream}, flushIntervalMs=${this.flushIntervalMs}, maxInflightBytes=${this.maxInflightBytes}`
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

    const [serverStream, consumerStream] = this.options.source.tee();
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
        maxInflightBytes: this.maxInflightBytes,
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
              const encoded = encodeChunkOrError(chunk);
              if (!encoded.ok) {
                controller.error(encoded.error);
                return;
              }
              controller.enqueue(AppendRecord.string({ body: encoded.body }));
            },
          })
        )
        .pipeThrough(
          new BatchTransform({
            lingerDurationMillis: this.flushIntervalMs,
          })
        )
        .pipeTo(session.writable);

      this.log("[S2MetadataStream] Stream pipeline completed successfully");

      // Get final position to verify completion
      const lastAcked = session.lastAckedPosition();

      if (lastAcked?.end) {
        this.lastSeqNum = lastAcked.end.seqNum;
        this.log(
          `[S2MetadataStream] Written ${this.lastSeqNum} records, ending at seqNum=${this.lastSeqNum}`
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

  public async wait(): Promise<StreamWriteResult> {
    await this.streamPromise;
    return { lastEventId: this.lastSeqNum?.toString() };
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

// chat.agent emits two chunk shapes through this writer:
//   - UIMessageChunks + custom data parts: `{ type: "tool-output-available" | "data-..." | ... }`
//   - ChatInputChunks (mostly seen on `.in`, but reused as the discriminant
//     elsewhere): `{ kind: "message" | "stop" | "action" }`
// Surfacing whichever discriminant exists turns "chunk too large" into
// "tool-output-available chunk too large", which is what users actually need.
function extractChunkType(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") return undefined;
  const c = chunk as { type?: unknown; kind?: unknown };
  if (typeof c.type === "string") return c.type;
  if (typeof c.kind === "string") return c.kind;
  return undefined;
}

/**
 * Encode a chunk as a JSON record body for S2, enforcing the per-record
 * size cap. Exported so the size/discriminant logic can be unit-tested
 * directly without spinning up an S2 client or mocking `@s2-dev/streamstore`.
 *
 * Returns `{ ok: true, body }` when the encoded chunk fits within
 * `RECORD_BODY_MAX_BYTES`, or `{ ok: false, error }` carrying a
 * `ChatChunkTooLargeError` annotated with the chunk's discriminant
 * (`type` or `kind`, whichever is present) so the surfaced error is
 * useful — "tool-output-available chunk too large" beats a bare
 * "chunk too large" by a lot.
 */
export function encodeChunkOrError(
  chunk: unknown
): { ok: true; body: string } | { ok: false; error: ChatChunkTooLargeError } {
  const body = JSON.stringify({ data: chunk, id: nanoid(7) });
  const size = utf8Encoder.encode(body).length;
  if (size > RECORD_BODY_MAX_BYTES) {
    return {
      ok: false,
      error: new ChatChunkTooLargeError(size, RECORD_BODY_MAX_BYTES, extractChunkType(chunk)),
    };
  }
  return { ok: true, body };
}
