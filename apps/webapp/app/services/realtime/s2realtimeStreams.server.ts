// app/realtime/S2RealtimeStreams.ts
import type { UnkeyCache } from "@internal/cache";
import { StreamIngestor, StreamRecord, StreamResponder, StreamResponseOptions } from "./types";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import { headerValue } from "@trigger.dev/core/v3";
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
            records: Array<{
              body: string;
              seq_num: number;
              timestamp: number;
              headers?: Array<[string, string]>;
            }>;
          };

          for (const record of parsed.records) {
            // S2 command records (trim/fence) have a single header with
            // empty name. Skip — callers want only data + Trigger control
            // records.
            if (record.headers?.[0]?.[0] === "") {
              continue;
            }

            // Data records carry a JSON envelope; Trigger control records
            // have an empty body and route via headers. Tolerate non-JSON
            // bodies so a control record (or a malformed data record)
            // doesn't take the whole batch down with it.
            let parsedBody: { data: string; id: string } | undefined;
            try {
              parsedBody = JSON.parse(record.body) as { data: string; id: string };
            } catch {
              parsedBody = undefined;
            }
            records.push({
              data: parsedBody?.data ?? "",
              id: parsedBody?.id ?? "",
              seqNum: record.seq_num,
              headers: record.headers,
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
   * For `io=out`, peek the tail of the stream. If the most recent
   * non-command record is a `turn-complete` control record (i.e. the
   * agent has finished a turn and is either idle-waiting on `.in` or
   * has exited), no more chunks will arrive without further user
   * action. We switch the downstream S2 read to `wait=0` (drain
   * whatever's left, close fast) and set `X-Session-Settled: true` so
   * the client knows this SSE close is terminal instead of the normal
   * 60s long-poll cycle.
   *
   * The actual tail is now usually an S2 `trim` command record (the
   * agent appends one after every turn-complete to keep `.out`
   * bounded). The peek reads two records and walks past the trim to
   * find the turn-complete underneath.
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

    // Only peek + settle when the client opts in via `options.peekSettled`.
    // Reconnect-on-reload paths (`TriggerChatTransport.reconnectToStream`)
    // set it; active send-a-message paths don't — otherwise the peek
    // races the newly-triggered turn's first chunk and the SSE closes
    // before records land.
    if (io === "out" && options?.peekSettled) {
      settled = await this.#peekIsSettled(s2Stream);
      if (settled) {
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

  /**
   * Peek the tail of `.out` and return whether the stream is "settled" —
   * i.e. the most recent non-command record is a `turn-complete` control
   * record. The agent appends an S2 `trim` command record immediately
   * after every turn-complete to keep the stream bounded, so we read two
   * tail records and walk past any trim command to find the
   * turn-complete underneath.
   */
  async #peekIsSettled(s2Stream: string): Promise<boolean> {
    const qs = new URLSearchParams();
    // `tail_offset=2` rewinds two seq positions; `count=2` caps it to
    // those two records. At steady state these are `[turn-complete, trim]`.
    // `wait=0` returns immediately with no long-poll.
    qs.set("tail_offset", "2");
    qs.set("count", "2");
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
      return false;
    }

    if (!res.ok) {
      // 404: stream has never been written to. 416: range not
      // satisfiable (empty stream). Both mean "nothing to peek."
      if (res.status === 404 || res.status === 416) return false;
      const text = await res.text().catch(() => "");
      this.logger.warn("S2 peek last record failed", {
        status: res.status,
        statusText: res.statusText,
        text,
        stream: s2Stream,
      });
      return false;
    }

    let records: Array<{
      body: string;
      seq_num: number;
      timestamp: number;
      headers?: Array<[string, string]>;
    }>;
    try {
      const json = (await res.json()) as {
        records?: Array<{
          body: string;
          seq_num: number;
          timestamp: number;
          headers?: Array<[string, string]>;
        }>;
      };
      records = json.records ?? [];
    } catch (err) {
      this.logger.warn("S2 peek last record: parse failed", { err, stream: s2Stream });
      return false;
    }

    // Walk from most-recent backward, skipping S2 command records
    // (`headers[0][0] === ""`). The first non-command record is the
    // real tail — settled iff its `trigger-control` header is
    // `turn-complete`.
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!;
      if (record.headers?.[0]?.[0] === "") {
        continue;
      }
      const controlValue = headerValue(record.headers, "trigger-control");
      return controlValue === "turn-complete";
    }
    return false;
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
    // POST /v1/streams/{stream}/records (JSON).
    //
    // Retries transient failures (network errors and 5xx) up to 3 times with
    // exponential backoff. Undici's "fetch failed" errors observed locally
    // are pre-connection (DNS/TCP) so the request never reaches S2, making
    // retry safe — the alternative is a 500 surfacing to the SDK transport,
    // which then retries the whole `/in/append` round-trip and pollutes
    // logs. 4xx are not retried (genuine client errors).
    const url = `${this.baseUrl}/streams/${encodeURIComponent(stream)}/records`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "S2-Format": "raw",
        "S2-Basin": this.basin,
      },
      body: JSON.stringify(body),
    };

    const maxAttempts = 3;
    const backoffsMs = [100, 250, 600];
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // The `try` only wraps `fetch` — once we have a Response we handle status
      // outside the catch, so a 4xx throw can't be swallowed and retried.
      let res: Response | undefined;
      try {
        res = await fetch(url, init);
      } catch (err) {
        lastError = err;
      }

      if (res) {
        if (res.ok) {
          return (await res.json()) as S2AppendAck;
        }
        const text = await res.text().catch(() => "");
        const httpError = new Error(
          `S2 append failed: ${res.status} ${res.statusText} ${text}`
        );
        if (res.status >= 400 && res.status < 500) {
          // 4xx — caller-side problem (auth, malformed body, closed stream).
          // Retrying won't help.
          throw httpError;
        }
        // 5xx — retryable.
        lastError = httpError;
      }

      const isLastAttempt = attempt === maxAttempts - 1;
      const diagnostics = describeFetchError(lastError);
      if (isLastAttempt) {
        this.logger.error("S2 append failed after retries", {
          stream,
          attempts: maxAttempts,
          ...diagnostics,
        });
        break;
      }

      this.logger.warn("S2 append transient failure, retrying", {
        stream,
        attempt: attempt + 1,
        nextDelayMs: backoffsMs[attempt],
        ...diagnostics,
      });
      await new Promise((resolve) => setTimeout(resolve, backoffsMs[attempt]));
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async getS2AccessToken(id: string): Promise<string> {
    if (!this.cache) {
      return this.s2IssueAccessToken(id);
    }

    // Cache key includes basin so per-org basins never collide on
    // cached tokens. `${basin}:${prefix}` is unique per (org-basin, env).
    const cacheKey = `${this.basin}:${this.streamPrefix}`;
    const result = await this.cache.accessToken.swr(cacheKey, async () => {
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
          // S2 treats `trim` as a separate op from `append` even though
          // trim records are appended like any other record. Verified
          // empirically: without `"trim"` here, `AppendRecord.trim()`
          // writes 403 with "Operation not permitted". `chat.agent`'s
          // per-turn trim chain depends on this.
          ops: ["append", "create-stream", "trim"],
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

// Pulls the underlying network error out of undici's generic "fetch failed".
// undici sets `error.cause` to either a SystemError-shaped object with `code`
// (e.g. `ECONNRESET`, `UND_ERR_SOCKET`, `ETIMEDOUT`), `errno`, and `syscall`,
// or — for happy-eyeballs / multi-address connect attempts — an
// `AggregateError` whose `errors[]` each carry their own code. Surfacing
// those tells us whether failures are pre-connection (DNS / TCP), mid-stream
// socket resets, or genuine S2 server errors.
function describeFetchError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { error: String(err) };
  }
  const out: Record<string, unknown> = {
    error: err.message,
    name: err.name,
  };
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = cause as Record<string, unknown>;
    if (typeof c.code === "string") out.causeCode = c.code;
    if (typeof c.errno === "number" || typeof c.errno === "string") out.causeErrno = c.errno;
    if (typeof c.syscall === "string") out.causeSyscall = c.syscall;
    if (typeof c.message === "string") out.causeMessage = c.message;
    if (Array.isArray(c.errors)) {
      out.causeErrors = c.errors
        .filter((e: unknown): e is Error => e instanceof Error)
        .map((e) => ({
          message: e.message,
          code: (e as { code?: unknown }).code,
          syscall: (e as { syscall?: unknown }).syscall,
          address: (e as { address?: unknown }).address,
          port: (e as { port?: unknown }).port,
        }));
    }
  }
  return out;
}
