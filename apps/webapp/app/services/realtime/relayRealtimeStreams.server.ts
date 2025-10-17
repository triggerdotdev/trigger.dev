import { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger.server";
import { signalsEmitter } from "../signals.server";
import { StreamIngestor, StreamResponder } from "./types";
import { LineTransformStream } from "./utils.server";
import { v1RealtimeStreams } from "./v1StreamsGlobal.server";
import { singleton } from "~/utils/singleton";

export type RelayRealtimeStreamsOptions = {
  ttl: number;
  cleanupInterval: number;
  fallbackIngestor: StreamIngestor;
  fallbackResponder: StreamResponder;
  waitForBufferTimeout?: number; // Time to wait for buffer in ms (default: 500ms)
  waitForBufferInterval?: number; // Polling interval in ms (default: 50ms)
};

interface RelayedStreamRecord {
  stream: ReadableStream<Uint8Array>;
  createdAt: number;
  lastAccessed: number;
  locked: boolean;
  finalized: boolean;
}

export class RelayRealtimeStreams implements StreamIngestor, StreamResponder {
  private _buffers: Map<string, RelayedStreamRecord> = new Map();
  private cleanupInterval: NodeJS.Timeout;
  private waitForBufferTimeout: number;
  private waitForBufferInterval: number;

  constructor(private options: RelayRealtimeStreamsOptions) {
    this.waitForBufferTimeout = options.waitForBufferTimeout ?? 1200;
    this.waitForBufferInterval = options.waitForBufferInterval ?? 50;

    // Periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.options.cleanupInterval).unref();
  }

  async streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    signal: AbortSignal
  ): Promise<Response> {
    let record = this._buffers.get(`${runId}:${streamId}`);

    if (!record) {
      logger.debug(
        "[RelayRealtimeStreams][streamResponse] No ephemeral record found, waiting to see if one becomes available",
        {
          streamId,
          runId,
        }
      );

      record = await this.waitForBuffer(`${runId}:${streamId}`);

      if (!record) {
        logger.debug(
          "[RelayRealtimeStreams][streamResponse] No ephemeral record found, using fallback",
          {
            streamId,
            runId,
          }
        );

        // No ephemeral record, use fallback
        return this.options.fallbackResponder.streamResponse(request, runId, streamId, signal);
      }
    }

    // Only 1 reader of the stream can use the relayed stream, the rest should use the fallback
    if (record.locked) {
      logger.debug("[RelayRealtimeStreams][streamResponse] Stream already locked, using fallback", {
        streamId,
        runId,
      });

      return this.options.fallbackResponder.streamResponse(request, runId, streamId, signal);
    }

    record.locked = true;
    record.lastAccessed = Date.now();

    logger.debug("[RelayRealtimeStreams][streamResponse] Streaming from ephemeral record", {
      streamId,
      runId,
    });

    // Create a streaming response from the buffered data
    const stream = record.stream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new LineTransformStream())
      .pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            for (const line of chunk) {
              controller.enqueue(`data: ${line}\n\n`);
            }
          },
        })
      )
      .pipeThrough(new TextEncoderStream());

    // Once we start streaming, consider deleting the buffer when done.
    // For a simple approach, we can rely on finalized and no more reads.
    // Or we can let TTL cleanup handle it if multiple readers might come in.
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-trigger-relay-realtime-streams": "true",
      },
    });
  }

  async ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string,
    clientId: string,
    resumeFromChunk?: number
  ): Promise<Response> {
    const [localStream, fallbackStream] = stream.tee();

    logger.debug("[RelayRealtimeStreams][ingestData] Ingesting data", {
      runId,
      streamId,
      clientId,
      resumeFromChunk,
    });

    // Handle local buffering asynchronously and catch errors
    this.handleLocalIngestion(localStream, runId, streamId).catch((err) => {
      logger.error("[RelayRealtimeStreams][ingestData] Error in local ingestion:", { err });
    });

    // Forward to the fallback ingestor asynchronously and catch errors
    return this.options.fallbackIngestor.ingestData(
      fallbackStream,
      runId,
      streamId,
      clientId,
      resumeFromChunk
    );
  }

  /**
   * Handles local buffering of the stream data.
   * @param stream The readable stream to buffer.
   * @param streamId The unique identifier for the stream.
   */
  private async handleLocalIngestion(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string
  ) {
    this.createOrUpdateRelayedStream(`${runId}:${streamId}`, stream);
  }

  /**
   * Retrieves an existing buffer or creates a new one for the given streamId.
   * @param streamId The unique identifier for the stream.
   */
  private createOrUpdateRelayedStream(
    bufferKey: string,
    stream: ReadableStream<Uint8Array>
  ): RelayedStreamRecord {
    let record = this._buffers.get(bufferKey);
    if (!record) {
      record = {
        stream,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        finalized: false,
        locked: false,
      };
      this._buffers.set(bufferKey, record);
    } else {
      record.lastAccessed = Date.now();
    }
    return record;
  }

  private cleanup() {
    const now = Date.now();

    logger.debug("[RelayRealtimeStreams][cleanup] Cleaning up old buffers", {
      bufferCount: this._buffers.size,
    });

    for (const [key, record] of this._buffers.entries()) {
      // If last accessed is older than ttl, clean up
      if (now - record.lastAccessed > this.options.ttl) {
        this.deleteBuffer(key);
      }
    }

    logger.debug("[RelayRealtimeStreams][cleanup] Cleaned up old buffers", {
      bufferCount: this._buffers.size,
    });
  }

  private deleteBuffer(bufferKey: string) {
    this._buffers.delete(bufferKey);
  }

  /**
   * Waits for a buffer to be created within a specified timeout.
   * @param streamId The unique identifier for the stream.
   * @returns A promise that resolves to true if the buffer was created, false otherwise.
   */
  private async waitForBuffer(bufferKey: string): Promise<RelayedStreamRecord | undefined> {
    const timeout = this.waitForBufferTimeout;
    const interval = this.waitForBufferInterval;
    const maxAttempts = Math.ceil(timeout / interval);
    let attempts = 0;

    return new Promise<RelayedStreamRecord | undefined>((resolve) => {
      const checkBuffer = () => {
        attempts++;
        if (this._buffers.has(bufferKey)) {
          resolve(this._buffers.get(bufferKey));
          return;
        }
        if (attempts >= maxAttempts) {
          resolve(undefined);
          return;
        }
        setTimeout(checkBuffer, interval);
      };
      checkBuffer();
    });
  }

  async getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number> {
    // Relay doesn't store chunks, forward to fallback
    return this.options.fallbackIngestor.getLastChunkIndex(runId, streamId, clientId);
  }

  // Don't forget to clear interval on shutdown if needed
  close() {
    clearInterval(this.cleanupInterval);
  }
}

function initializeRelayRealtimeStreams() {
  const service = new RelayRealtimeStreams({
    ttl: 1000 * 60 * 5, // 5 minutes
    cleanupInterval: 1000 * 60, // 1 minute
    fallbackIngestor: v1RealtimeStreams,
    fallbackResponder: v1RealtimeStreams,
  });

  signalsEmitter.on("SIGTERM", service.close.bind(service));
  signalsEmitter.on("SIGINT", service.close.bind(service));

  return service;
}

export const relayRealtimeStreams = singleton(
  "relayRealtimeStreams",
  initializeRelayRealtimeStreams
);
