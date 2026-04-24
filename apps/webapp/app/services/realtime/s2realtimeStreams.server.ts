// app/realtime/S2RealtimeStreams.ts
import type { UnkeyCache } from "@internal/cache";
import { StreamIngestor, StreamRecord, StreamResponder, StreamResponseOptions } from "./types";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import { randomUUID } from "node:crypto";

export type S2RealtimeStreamsOptions = {
  // S2
  basin: string; // e.g., "my-basin"
  accessToken: string; // "Bearer" token issued in S2 console
  streamPrefix?: string; // defaults to ""

  // Custom endpoint for s2-lite (self-hosted)
  endpoint?: string; // e.g., "http://localhost:4566/v1"

  // Skip access token issuance (s2-lite doesn't support /access-tokens)
  skipAccessTokens?: boolean;

  // Read behavior
  s2WaitSeconds?: number;

  flushIntervalMs?: number; // how often to flush buffered chunks (default 200ms)
  maxRetries?: number; // max number of retries for failed flushes (default 10)

  logger?: Logger;
  logLevel?: LogLevel;

  accessTokenExpirationInMs?: number;

  cache?: UnkeyCache<{
    accessToken: string;
  }>;
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
  private readonly accountUrl: string;
  private readonly endpoint?: string;
  private readonly token: string;
  private readonly streamPrefix: string;
  private readonly skipAccessTokens: boolean;

  private readonly s2WaitSeconds: number;

  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;

  private readonly logger: Logger;
  private readonly level: LogLevel;

  private readonly accessTokenExpirationInMs: number;

  private readonly cache?: UnkeyCache<{
    accessToken: string;
  }>;

  constructor(opts: S2RealtimeStreamsOptions) {
    this.basin = opts.basin;
    this.baseUrl = opts.endpoint ?? `https://${this.basin}.b.aws.s2.dev/v1`;
    this.accountUrl = opts.endpoint ?? `https://aws.s2.dev/v1`;
    this.endpoint = opts.endpoint;
    this.token = opts.accessToken;
    this.streamPrefix = opts.streamPrefix ?? "";
    this.skipAccessTokens = opts.skipAccessTokens ?? false;

    this.s2WaitSeconds = opts.s2WaitSeconds ?? 60;

    this.flushIntervalMs = opts.flushIntervalMs ?? 200;
    this.maxRetries = opts.maxRetries ?? 10;

    this.logger = opts.logger ?? new Logger("S2RealtimeStreams", opts.logLevel ?? "info");
    this.level = opts.logLevel ?? "info";

    this.cache = opts.cache;
    this.accessTokenExpirationInMs = opts.accessTokenExpirationInMs ?? 60_000 * 60 * 24; // 1 day
  }

  private toStreamName(runId: string, streamId: string): string {
    return `${this.streamPrefix}/runs/${runId}/${streamId}`;
  }

  /**
   * Build an S2 stream name for a `Session`-primitive channel, addressed by
   * the session's `friendlyId` and the I/O direction. Used by the session
   * realtime routes to route traffic to `sessions/{friendlyId}/{out|in}`.
   */
  public toSessionStreamName(friendlyId: string, io: "out" | "in"): string {
    return `${this.streamPrefix}/sessions/${friendlyId}/${io}`;
  }

  async initializeStream(
    runId: string,
    streamId: string
  ): Promise<{ responseHeaders?: Record<string, string> }> {
    return this.#initializeStreamByName(
      this.toStreamName(runId, streamId),
      `/runs/${runId}/${streamId}`
    );
  }

  /**
   * Initialize an S2 stream by `(sessionFriendlyId, io)` — mirrors
   * {@link initializeStream} but addresses the new `sessions/*` key format.
   */
  async initializeSessionStream(
    friendlyId: string,
    io: "out" | "in"
  ): Promise<{ responseHeaders?: Record<string, string> }> {
    return this.#initializeStreamByName(
      this.toSessionStreamName(friendlyId, io),
      `/sessions/${friendlyId}/${io}`
    );
  }

  async #initializeStreamByName(
    prefixedName: string,
    relativeName: string
  ): Promise<{ responseHeaders?: Record<string, string> }> {
    const accessToken = this.skipAccessTokens
      ? this.token
      : await this.getS2AccessToken(randomUUID());

    return {
      responseHeaders: {
        "X-S2-Access-Token": accessToken,
        "X-S2-Stream-Name": this.skipAccessTokens ? prefixedName : relativeName,
        "X-S2-Basin": this.basin,
        "X-S2-Flush-Interval-Ms": this.flushIntervalMs.toString(),
        "X-S2-Max-Retries": this.maxRetries.toString(),
        ...(this.endpoint ? { "X-S2-Endpoint": this.endpoint } : {}),
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
    return this.#appendPartByName(part, partId, this.toStreamName(runId, streamId));
  }

  /**
   * Append a single record to a `Session`-primitive channel.
   */
  async appendPartToSessionStream(
    part: string,
    partId: string,
    friendlyId: string,
    io: "out" | "in"
  ): Promise<void> {
    return this.#appendPartByName(part, partId, this.toSessionStreamName(friendlyId, io));
  }

  async #appendPartByName(part: string, partId: string, s2Stream: string): Promise<void> {
    this.logger.debug(`S2 appending to stream`, { part, stream: s2Stream });

    const result = await this.s2Append(s2Stream, {
      records: [{ body: JSON.stringify({ data: part, id: partId }) }],
    });

    this.logger.debug(`S2 append result`, { result });
  }

  getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number> {
    throw new Error("S2 streams are written to S2 via the client, not from the server");
  }

  async readRecords(
    runId: string,
    streamId: string,
    afterSeqNum?: number
  ): Promise<StreamRecord[]> {
    return this.#readRecordsByName(this.toStreamName(runId, streamId), afterSeqNum);
  }

  /**
   * Read records from a `Session`-primitive channel starting after the
   * given sequence number. Used by the `.wait()` race-check path.
   */
  async readSessionStreamRecords(
    friendlyId: string,
    io: "out" | "in",
    afterSeqNum?: number
  ): Promise<StreamRecord[]> {
    return this.#readRecordsByName(this.toSessionStreamName(friendlyId, io), afterSeqNum);
  }

  async #readRecordsByName(s2Stream: string, afterSeqNum?: number): Promise<StreamRecord[]> {
    const startSeq = afterSeqNum != null ? afterSeqNum + 1 : 0;

    const qs = new URLSearchParams();
    qs.set("seq_num", String(startSeq));
    qs.set("clamp", "true");
    qs.set("wait", "0"); // Non-blocking: return immediately with existing records

    const res = await fetch(
      `${this.baseUrl}/streams/${encodeURIComponent(s2Stream)}/records?${qs}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "text/event-stream",
          "S2-Format": "raw",
          "S2-Basin": this.basin,
        },
      }
    );

    if (!res.ok) {
      // Stream may not exist yet (no data sent)
      if (res.status === 404) {
        return [];
      }
      const text = await res.text().catch(() => "");
      throw new Error(`S2 readRecords failed: ${res.status} ${res.statusText} ${text}`);
    }

    // Parse the SSE response body to extract records
    const body = await res.text();
    return this.parseSSEBatchRecords(body);
  }

  private parseSSEBatchRecords(sseText: string): StreamRecord[] {
    const records: StreamRecord[] = [];

    // SSE events are separated by double newlines
    const events = sseText.split("\n\n").filter((e) => e.trim());

    for (const event of events) {
      const lines = event.split("\n");
      let eventType: string | undefined;
      let data: string | undefined;

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data = line.slice(5).trim();
        }
      }

      if (eventType === "batch" && data) {
        try {
          const parsed = JSON.parse(data) as {
            records: Array<{ body: string; seq_num: number; timestamp: number }>;
          };

          for (const record of parsed.records) {
            const parsedBody = JSON.parse(record.body) as { data: string; id: string };
            records.push({
              data: parsedBody.data,
              id: parsedBody.id,
              seqNum: record.seq_num,
            });
          }
        } catch {
          // Skip malformed events
        }
      }
    }

    return records;
  }

  // ---------- Serve SSE from S2 ----------

  async streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    signal: AbortSignal,
    options?: StreamResponseOptions
  ): Promise<Response> {
    return this.#streamResponseByName(this.toStreamName(runId, streamId), signal, options);
  }

  /**
   * Serve SSE from a `Session`-primitive channel addressed by
   * `(friendlyId, io)`.
   *
   * For `io=out`, peek the tail record first. If it's
   * `trigger:turn-complete`, the agent has finished a turn and is
   * either idle-waiting on `.in` or has exited — either way, no more
   * chunks will arrive without further user action. We switch the
   * downstream S2 read to `wait=0` (drain whatever's left, close fast)
   * and set `X-Session-Settled: true` so the client knows this SSE
   * close is terminal instead of the normal 60s long-poll cycle.
   *
   * Mid-turn tail (streaming UIMessageChunk) falls through to the
   * long-poll path; a crashed-mid-turn stream is indistinguishable
   * here and behaves like today (client sees wait=60 close, retries).
   */
  async streamResponseFromSessionStream(
    request: Request,
    friendlyId: string,
    io: "out" | "in",
    signal: AbortSignal,
    options?: StreamResponseOptions
  ): Promise<Response> {
    const s2Stream = this.toSessionStreamName(friendlyId, io);

    let waitSeconds = options?.timeoutInSeconds ?? this.s2WaitSeconds;
    let settled = false;

    if (io === "out") {
      const lastChunk = await this.#peekLastChunkBody(s2Stream);
      if (
        lastChunk != null &&
        typeof lastChunk === "object" &&
        (lastChunk as { type?: unknown }).type === "trigger:turn-complete"
      ) {
        settled = true;
        waitSeconds = 0;
      }
    }

    const s2Response = await this.#streamResponseByName(s2Stream, signal, {
      ...options,
      timeoutInSeconds: waitSeconds,
    });

    if (!settled) return s2Response;

    const headers = new Headers(s2Response.headers);
    headers.set("X-Session-Settled", "true");
    return new Response(s2Response.body, {
      status: s2Response.status,
      statusText: s2Response.statusText,
      headers,
    });
  }

  async #peekLastChunkBody(s2Stream: string): Promise<unknown | null> {
    const qs = new URLSearchParams();
    // `tail_offset=1` reads one record before the next seq — i.e. the
    // most recently appended record. `count=1` caps it to just that
    // record. `wait=0` returns immediately with no long-poll.
    qs.set("tail_offset", "1");
    qs.set("count", "1");
    qs.set("wait", "0");

    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/streams/${encodeURIComponent(s2Stream)}/records?${qs}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            "S2-Format": "raw",
            "S2-Basin": this.basin,
          },
        }
      );
    } catch (err) {
      this.logger.warn("S2 peek last record: fetch failed", { err, stream: s2Stream });
      return null;
    }

    if (!res.ok) {
      // 404: stream has never been written to. 416: range not
      // satisfiable (empty stream). Both mean "nothing to peek."
      if (res.status === 404 || res.status === 416) return null;
      const text = await res.text().catch(() => "");
      this.logger.warn("S2 peek last record failed", {
        status: res.status,
        statusText: res.statusText,
        text,
        stream: s2Stream,
      });
      return null;
    }

    try {
      const json = (await res.json()) as {
        records?: Array<{ body: string; seq_num: number; timestamp: number }>;
      };
      const record = json.records?.[0];
      if (!record) return null;
      // The record body is a JSON string `{data: <chunk>, id: partId}`
      // where `<chunk>` is the raw UIMessageChunk object (see
      // `StreamsWriterV2` — the agent-side writer serializes the chunk
      // object directly, not double-encoded). Unwrap the envelope and
      // return `data` as-is.
      const envelope = JSON.parse(record.body) as { data: unknown; id: string };
      return envelope.data;
    } catch (err) {
      this.logger.warn("S2 peek last record: parse failed", { err, stream: s2Stream });
      return null;
    }
  }

  async #streamResponseByName(
    s2Stream: string,
    signal: AbortSignal,
    options?: StreamResponseOptions
  ): Promise<Response> {
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
        "S2-Format": "raw",
        "S2-Basin": this.basin,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S2 append failed: ${res.status} ${res.statusText} ${text}`);
    }
    return (await res.json()) as S2AppendAck;
  }

  private async getS2AccessToken(id: string): Promise<string> {
    if (!this.cache) {
      return this.s2IssueAccessToken(id);
    }

    const result = await this.cache.accessToken.swr(this.streamPrefix, async () => {
      return this.s2IssueAccessToken(id);
    });

    if (!result.val) {
      throw new Error("Failed to get S2 access token");
    }

    return result.val;
  }

  private async s2IssueAccessToken(id: string): Promise<string> {
    // POST /v1/access-tokens
    const res = await fetch(`${this.accountUrl}/access-tokens`, {
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
            prefix: this.streamPrefix,
          },
        },
        expires_at: new Date(Date.now() + this.accessTokenExpirationInMs).toISOString(),
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
        "S2-Basin": this.basin,
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
