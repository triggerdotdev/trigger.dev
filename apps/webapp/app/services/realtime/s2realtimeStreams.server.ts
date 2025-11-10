// app/realtime/S2RealtimeStreams.ts
import { StreamIngestor, StreamResponder, StreamResponseOptions } from "./types";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import { randomUUID } from "node:crypto";

export type S2RealtimeStreamsOptions = {
  // S2
  basin: string; // e.g., "my-basin"
  accessToken: string; // "Bearer" token issued in S2 console
  streamPrefix?: string; // defaults to ""

  // Read behavior
  s2WaitSeconds?: number;

  flushIntervalMs?: number; // how often to flush buffered chunks (default 200ms)
  maxRetries?: number; // max number of retries for failed flushes (default 10)

  logger?: Logger;
  logLevel?: LogLevel;
};

type S2IssueAccessTokenResponse = { access_token: string };
type S2AppendInput = { records: { body: string }[] };
type S2AppendAck = {
  start: { seq_num: number; timestamp: number };
  end: { seq_num: number; timestamp: number };
  tail: { seq_num: number; timestamp: number };
};

export class S2RealtimeStreams implements StreamResponder, StreamIngestor {
  private readonly basin: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly streamPrefix: string;

  private readonly s2WaitSeconds: number;

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

  async appendPart(part: string, partId: string, runId: string, streamId: string): Promise<void> {
    const s2Stream = this.toStreamName(runId, streamId);

    this.logger.info(`S2 appending to stream`, { part, stream: s2Stream });

    const result = await this.s2Append(s2Stream, {
      records: [{ body: JSON.stringify({ data: part, id: partId }) }],
    });

    this.logger.info(`S2 append result`, { result });
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
    options?: StreamResponseOptions
  ): Promise<Response> {
    const s2Stream = this.toStreamName(runId, streamId);
    const startSeq = this.parseLastEventId(options?.lastEventId);

    this.logger.info(`S2 streaming records from stream`, { stream: s2Stream, startSeq });

    // Request SSE stream from S2 and return it directly
    const s2Response = await this.s2StreamRecords(s2Stream, {
      seq_num: startSeq ?? 0,
      clamp: true,
      wait: options?.timeoutInSeconds ?? this.s2WaitSeconds, // S2 will keep the connection open and stream new records
      signal, // Pass abort signal so S2 connection is cleaned up when client disconnects
    });

    // Return S2's SSE response directly to the client
    return s2Response;
  }

  // ---------- Internals: S2 REST ----------
  private async s2Append(stream: string, body: S2AppendInput): Promise<S2AppendAck> {
    // POST /v1/streams/{stream}/records (JSON)
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

  private async s2StreamRecords(
    stream: string,
    opts: {
      seq_num?: number;
      clamp?: boolean;
      wait?: number;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
    // GET /v1/streams/{stream}/records with Accept: text/event-stream for SSE streaming
    const qs = new URLSearchParams();
    if (opts.seq_num != null) qs.set("seq_num", String(opts.seq_num));
    if (opts.clamp != null) qs.set("clamp", String(opts.clamp));
    if (opts.wait != null) qs.set("wait", String(opts.wait));

    const res = await fetch(`${this.baseUrl}/streams/${encodeURIComponent(stream)}/records?${qs}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "text/event-stream",
        "S2-Format": "raw",
      },
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S2 stream failed: ${res.status} ${res.statusText} ${text}`);
    }

    const headers = new Headers(res.headers);
    headers.set("X-Stream-Version", "v2");
    headers.set("Access-Control-Expose-Headers", "*");

    return new Response(res.body, {
      headers,
      status: res.status,
      statusText: res.statusText,
    });
  }

  private parseLastEventId(lastEventId?: string): number | undefined {
    if (!lastEventId) return undefined;
    // tolerate formats like "1699999999999-5" (take leading digits)
    const digits = lastEventId.split("-")[0];
    const n = Number(digits);
    return Number.isFinite(n) && n >= 0 ? n + 1 : undefined;
  }
}
