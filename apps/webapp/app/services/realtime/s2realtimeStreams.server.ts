// app/realtime/S2RealtimeStreams.ts
import { StreamIngestor, StreamResponder } from "./types";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import { randomUUID } from "node:crypto";

export type S2RealtimeStreamsOptions = {
  // S2
  basin: string; // e.g., "my-basin"
  accessToken: string; // "Bearer" token issued in S2 console
  streamPrefix?: string; // defaults to ""

  // Read behavior
  s2WaitSeconds?: number; // long poll wait for reads (default 60)
  sseHeartbeatMs?: number; // ping interval to keep h2 alive (default 25000)

  flushIntervalMs?: number; // how often to flush buffered chunks (default 200ms)
  maxRetries?: number; // max number of retries for failed flushes (default 10)

  logger?: Logger;
  logLevel?: LogLevel;
};

type S2Record = {
  headers?: [string, string][];
  body: string;
  seq_num?: number;
  timestamp?: number;
};

type S2ReadResponse = { records: S2Record[] };
type S2IssueAccessTokenResponse = { access_token: string };

export class S2RealtimeStreams implements StreamResponder, StreamIngestor {
  private readonly basin: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly streamPrefix: string;

  private readonly s2WaitSeconds: number;
  private readonly sseHeartbeatMs: number;

  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;

  private readonly logger: Logger;
  private readonly level: LogLevel;

  constructor(opts: S2RealtimeStreamsOptions) {
    this.basin = opts.basin;
    this.baseUrl = `https://${this.basin}.b.aws.s2.dev/v1`;
    this.token = opts.accessToken;
    this.streamPrefix = opts.streamPrefix ?? "";

    this.s2WaitSeconds = opts.s2WaitSeconds ?? 60;
    this.sseHeartbeatMs = opts.sseHeartbeatMs ?? 25_000;

    this.flushIntervalMs = opts.flushIntervalMs ?? 200;
    this.maxRetries = opts.maxRetries ?? 10;

    this.logger = opts.logger ?? new Logger("S2RealtimeStreams", opts.logLevel ?? "info");
    this.level = opts.logLevel ?? "info";
  }

  private toStreamName(runId: string, streamId: string): string {
    return `${this.toStreamPrefix(runId)}${streamId}`;
  }

  private toStreamPrefix(runId: string): string {
    return `${this.streamPrefix}/runs/${runId}/`;
  }

  async initializeStream(
    runId: string,
    streamId: string
  ): Promise<{ responseHeaders?: Record<string, string> }> {
    const id = randomUUID();

    const accessToken = await this.s2IssueAccessToken(id, runId, streamId);

    return {
      responseHeaders: {
        "X-S2-Access-Token": accessToken,
        "X-S2-Basin": this.basin,
        "X-S2-Flush-Interval-Ms": this.flushIntervalMs.toString(),
        "X-S2-Max-Retries": this.maxRetries.toString(),
      },
    };
  }

  ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string,
    clientId: string,
    resumeFromChunk?: number
  ): Promise<Response> {
    throw new Error("S2 streams are written to S2 via the client, not from the server");
  }

  getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number> {
    throw new Error("S2 streams are written to S2 via the client, not from the server");
  }

  // ---------- Serve SSE from S2 ----------

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

  private async s2IssueAccessToken(id: string, runId: string, streamId: string): Promise<string> {
    // POST /v1/access-tokens
    const res = await fetch(`https://aws.s2.dev/v1/access-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id,
        scope: {
          basins: {
            exact: this.basin,
          },
          ops: ["append", "create-stream"],
          streams: {
            prefix: this.toStreamPrefix(runId),
          },
        },
        expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(), // 1 day
        auto_prefix_streams: true,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S2 issue access token failed: ${res.status} ${res.statusText} ${text}`);
    }
    const data = (await res.json()) as S2IssueAccessTokenResponse;
    return data.access_token;
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

  private parseLastEventId(lastEventId?: string): number | undefined {
    if (!lastEventId) return undefined;
    // tolerate formats like "1699999999999-5" (take leading digits)
    const digits = lastEventId.split("-")[0];
    const n = Number(digits);
    return Number.isFinite(n) && n >= 0 ? n + 1 : undefined;
  }
}
