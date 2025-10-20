// app/realtime/S2RealtimeStreams.ts
import Redis, { RedisOptions } from "ioredis";
import pLimit from "p-limit";
import { StreamIngestor, StreamResponder } from "./types";
import { Logger, LogLevel } from "@trigger.dev/core/logger";

export type S2RealtimeStreamsOptions = {
  // S2
  basin: string; // e.g., "my-basin"
  accessToken: string; // "Bearer" token issued in S2 console
  streamPrefix?: string; // defaults to ""
  streamName?: (runId: string, streamId: string) => string; // defaults to runs/{runId}/{streamId}

  // Redis (only for resume state)
  redis: RedisOptions | undefined;
  resumeTtlSeconds?: number; // default 86400 (1 day)

  // Batch / read behavior
  maxBatchRecords?: number; // safety cap per append (<=1000 typical)
  maxBatchBytes?: number; // ~1MiB minus headroom (JSON)
  s2WaitSeconds?: number; // long poll wait for reads (default 60)
  sseHeartbeatMs?: number; // : ping interval to keep h2 alive (default 25000)
  flushIntervalMs?: number; // interval for flushing ingested chunks (default 100ms)

  logger?: Logger;
  logLevel?: LogLevel;
};

type S2Record = {
  headers?: [string, string][];
  body: string;
  seq_num?: number;
  timestamp?: number;
};

type S2AppendInput = { records: { body: string }[] };
type S2AppendAck = {
  start: { seq_num: number; timestamp: number };
  end: { seq_num: number; timestamp: number };
  tail: { seq_num: number; timestamp: number };
};
type S2ReadResponse = { records: S2Record[] };

export class S2RealtimeStreams implements StreamIngestor, StreamResponder {
  private readonly basin: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly toStreamName: (runId: string, streamId: string) => string;

  private readonly redisOpts?: RedisOptions;
  private readonly resumeTtlSeconds: number;

  private readonly maxBatchRecords: number;
  private readonly maxBatchBytes: number;
  private readonly s2WaitSeconds: number;
  private readonly sseHeartbeatMs: number;
  private readonly flushIntervalMs: number;

  private readonly logger: Logger;
  private readonly level: LogLevel;

  constructor(opts: S2RealtimeStreamsOptions) {
    this.basin = opts.basin;
    this.baseUrl = `https://${this.basin}.b.aws.s2.dev/v1`;
    this.token = opts.accessToken;

    this.toStreamName =
      opts.streamName ??
      ((runId, streamId) =>
        `${opts.streamPrefix ? `${opts.streamPrefix}/runs/` : "runs/"}${runId}/${streamId}`);

    this.redisOpts = opts.redis;
    this.resumeTtlSeconds = opts.resumeTtlSeconds ?? 86400;

    this.maxBatchRecords = opts.maxBatchRecords ?? 1000;
    this.maxBatchBytes = opts.maxBatchBytes ?? 950_000; // leave headroom
    this.s2WaitSeconds = opts.s2WaitSeconds ?? 60;
    this.sseHeartbeatMs = opts.sseHeartbeatMs ?? 25_000;
    this.flushIntervalMs = opts.flushIntervalMs ?? 100;

    this.logger = opts.logger ?? new Logger("S2RealtimeStreams", opts.logLevel ?? "info");
    this.level = opts.logLevel ?? "info";
  }

  // ---------- Ingest (client -> our API -> S2). Resume state lives in Redis only. ----------

  async ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string,
    clientId: string,
    resumeFromChunk?: number
  ): Promise<Response> {
    const s2Stream = this.toStreamName(runId, streamId);
    const redis = new Redis(this.redisOpts ?? {});
    const progressKey = this.resumeKey(runId, streamId, clientId);

    // Create a limiter to ensure sequential s2Append calls
    const limit = pLimit(1);

    // Buffer for accumulating chunks
    const buffer: Array<{ body: string; chunkIndex: number }> = [];
    let currentChunkIndex = resumeFromChunk ?? 0;

    // Start the periodic flush process
    const flushPromises: Promise<void>[] = [];

    const flush = async () => {
      if (buffer.length === 0) {
        return;
      }

      // Take all chunks from buffer
      const chunksToFlush = buffer.splice(0);
      const lastChunkIndex = chunksToFlush[chunksToFlush.length - 1].chunkIndex;

      // Add flush to limiter queue to ensure sequential execution
      const flushPromise = limit(async () => {
        try {
          this.logger.debug("[S2RealtimeStreams][ingestData] Flushing chunks", {
            s2Stream,
            runId,
            streamId,
            clientId,
            count: chunksToFlush.length,
            lastChunkIndex,
          });

          // Batch append all chunks at once
          await this.s2Append(s2Stream, {
            records: chunksToFlush.map((c) => ({ body: c.body })),
          });

          // Update progress state after successful flush
          await redis.set(progressKey, String(lastChunkIndex), "EX", this.resumeTtlSeconds);

          this.logger.debug("[S2RealtimeStreams][ingestData] Flush successful", {
            s2Stream,
            runId,
            streamId,
            clientId,
            count: chunksToFlush.length,
            lastChunkIndex,
          });
        } catch (error) {
          this.logger.error("[S2RealtimeStreams][ingestData] Flush error", {
            error,
            s2Stream,
            runId,
            streamId,
            clientId,
            count: chunksToFlush.length,
          });
          throw error;
        }
      });

      this.logger.debug("[S2RealtimeStreams][ingestData] Flush promise added", {
        pendingConcurrency: limit.pendingCount,
      });

      flushPromises.push(flushPromise);
    };

    // Start periodic flush interval
    const flushInterval = setInterval(() => {
      flush().catch(() => {
        // Errors are already logged in flush()
      });
    }, this.flushIntervalMs);

    try {
      const textStream = stream.pipeThrough(new TextDecoderStream());
      const reader = textStream.getReader();

      // Read as fast as possible and buffer chunks
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (!value) {
          break;
        }

        // Add chunk to buffer
        buffer.push({
          body: value,
          chunkIndex: currentChunkIndex,
        });

        currentChunkIndex++;
      }

      // Final flush to ensure all buffered chunks are written
      await flush();

      // Wait for all pending flush operations to complete
      await Promise.all(flushPromises);

      return new Response(null, { status: 200 });
    } catch (error) {
      this.logger.error("[S2RealtimeStreams][ingestData] error", {
        error,
        runId,
        streamId,
        clientId,
      });

      // Try to flush any remaining buffered chunks before erroring
      try {
        await flush();
        await Promise.all(flushPromises);
      } catch (flushError) {
        this.logger.error("[S2RealtimeStreams][ingestData] Final flush error", {
          error: flushError,
          runId,
          streamId,
          clientId,
        });
      }

      return new Response(null, { status: 500 });
    } finally {
      clearInterval(flushInterval);
      await redis.quit().catch(() => {});
    }
  }

  async getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number> {
    const redis = new Redis(this.redisOpts ?? {});
    try {
      const raw = await redis.get(this.resumeKey(runId, streamId, clientId));
      if (!raw) return -1;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : -1;
    } finally {
      await redis.quit().catch(() => {});
    }
  }

  // ---------- Serve SSE from S2 (optionally compact historical prefix) ----------

  async streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    signal: AbortSignal,
    lastEventId?: string
  ): Promise<Response> {
    const s2Stream = this.toStreamName(runId, streamId);
    const encoder = new TextEncoder();

    const startSeq = this.parseLastEventId(lastEventId); // if undefined => from beginning
    const readable = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let aborted = false;
        const onAbort = () => (aborted = true);
        signal.addEventListener("abort", onAbort);

        const hb = setInterval(() => {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        }, this.sseHeartbeatMs);

        try {
          let nextSeq = startSeq ?? 0;

          // Live follow via long-poll read (wait=)
          // clamp=true ensures starting past-tail doesn't 416; it clamps to tail and waits.
          while (!aborted) {
            const resp = await this.s2ReadOnce(s2Stream, {
              seq_num: nextSeq,
              clamp: true,
              count: 1000,
              wait: this.s2WaitSeconds, // long polling for new data. :contentReference[oaicite:6]{index=6}
            });

            if (resp.records?.length) {
              for (const rec of resp.records) {
                const seq = rec.seq_num!;
                controller.enqueue(encoder.encode(`id: ${seq}\n`));
                const body = rec.body ?? "";
                const lines = body.split("\n").filter((l) => l.length > 0);
                for (const line of lines) {
                  controller.enqueue(encoder.encode(`data: ${line}\n`));
                }
                controller.enqueue(encoder.encode(`\n`));
                nextSeq = seq + 1;
              }
            }
            // If no records within wait, loop; heartbeat keeps connection alive.
          }
        } catch (error) {
          this.logger.error("[S2RealtimeStreams][streamResponse] fatal", {
            error,
            runId,
            streamId,
          });
          controller.error(error);
        } finally {
          signal.removeEventListener("abort", onAbort);
          clearInterval(hb);
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // ---------- Internals: S2 REST ----------

  private async s2Append(stream: string, body: S2AppendInput): Promise<S2AppendAck> {
    // POST /v1/streams/{stream}/records (JSON). :contentReference[oaicite:7]{index=7}
    const res = await fetch(`${this.baseUrl}/streams/${encodeURIComponent(stream)}/records`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "S2-Format": "raw", // UTF-8 JSON encoding (no base64 overhead) when your data is text. :contentReference[oaicite:8]{index=8}
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S2 append failed: ${res.status} ${res.statusText} ${text}`);
    }
    return (await res.json()) as S2AppendAck;
  }

  private async s2ReadOnce(
    stream: string,
    opts: {
      seq_num?: number;
      timestamp?: number;
      tail_offset?: number;
      clamp?: boolean;
      count?: number;
      bytes?: number;
      until?: number;
      wait?: number;
    }
  ): Promise<S2ReadResponse> {
    // GET /v1/streams/{stream}/records?... (supports wait= for long-poll; linearizable reads). :contentReference[oaicite:9]{index=9}
    const qs = new URLSearchParams();
    if (opts.seq_num != null) qs.set("seq_num", String(opts.seq_num));
    if (opts.timestamp != null) qs.set("timestamp", String(opts.timestamp));
    if (opts.tail_offset != null) qs.set("tail_offset", String(opts.tail_offset));
    if (opts.clamp != null) qs.set("clamp", String(opts.clamp));
    if (opts.count != null) qs.set("count", String(opts.count));
    if (opts.bytes != null) qs.set("bytes", String(opts.bytes));
    if (opts.until != null) qs.set("until", String(opts.until));
    if (opts.wait != null) qs.set("wait", String(opts.wait));

    const res = await fetch(`${this.baseUrl}/streams/${encodeURIComponent(stream)}/records?${qs}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "S2-Format": "raw",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S2 read failed: ${res.status} ${res.statusText} ${text}`);
    }
    return (await res.json()) as S2ReadResponse;
  }

  // ---------- Utils ----------

  private resumeKey(runId: string, streamId: string, clientId: string) {
    return `s2:resume:${runId}:${streamId}:${clientId}`;
  }

  private parseLastEventId(lastEventId?: string): number | undefined {
    if (!lastEventId) return undefined;
    // tolerate formats like "1699999999999-5" (take leading digits)
    const digits = lastEventId.split("-")[0];
    const n = Number(digits);
    return Number.isFinite(n) && n >= 0 ? n + 1 : undefined;
  }
}
