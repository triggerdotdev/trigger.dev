// app/realtime/S2RealtimeStreams.ts
import type { UnkeyCache } from "@internal/cache";
import type { StreamIngestor, StreamRecord, StreamResponder, StreamResponseOptions } from "./types";
import type { LogLevel } from "@trigger.dev/core/logger";
import { Logger } from "@trigger.dev/core/logger";
import {
  headerValue,
  SESSION_IN_CONSUMED_ID_HEADER,
  SESSION_IN_EVENT_ID_HEADER,
  TURN_HANDOVER_STEPS_HEADER,
  TURN_HANDOVER_UPGRADE_HEADER,
} from "@trigger.dev/core/v3";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ServiceValidationError } from "~/v3/services/common.server";

// S2's per-record metered-size limit. Verified empirically against
// cloud S2: append succeeds at metered=1048576 and 422s at 1048577
// with `"record must have metered size less than 1 MiB"` (the "less
// than" wording is slightly off — the boundary is inclusive).
//
// Metered size formula:
//   metered = 8 (record overhead) + 2*H + Σ(header name + value) + body
// where `body` is the unescaped record body length in UTF-8 bytes and
// `H` is the number of S2 record headers.
//
// We attach no record headers (H=0), so the budget reduces to:
//   8 + body ≤ 1048576  →  body ≤ 1048568
const S2_MAX_METERED_BYTES = 1024 * 1024; // 1 MiB
const S2_RECORD_BASE_OVERHEAD_BYTES = 8;
const S2_PEEK_TIMEOUT_MS = 2000;
// Appends and stream config on the deploy and threshold paths: a hung S2 call can't hold a promote
// or a dashboard action open.
const S2_WRITE_TIMEOUT_MS = 5000;
// The `.out` tail peek reads this many records first. At steady state the tail is
// `[turn-complete, trim]`, and the peek runs on every reconnect, so it stays small.
const PEEK_TAIL_RECORDS = 2;
// When those hold only S2 command records (the agent trimmed more than once after its last real
// record), the peek walks back one record per read until it finds a real one. It looks at this many
// records at most, the first window included, so at most this many minus two extra reads. Past
// that the answer is "commands-only": the tail is not worth more reads on every reconnect.
const PEEK_TAIL_MAX_RECORDS = 6;
// The walk back past command records stops this long after it starts, or at the peek's own
// deadline, whichever comes first. The reads before it (the first window, and the tail check and
// newest-record read after a short read) use the peek's deadline alone. A walk that runs out of
// budget before it finds a real record is a failed read ("unknown"), not "commands-only".
const PEEK_WALK_BUDGET_MS = 500;

type PeekedRecord = {
  body: string;
  seq_num: number;
  timestamp: number;
  headers?: Array<[string, string]>;
};

/**
 * What the tail of a session's `.out` holds. "unknown" is a failed read (S2 did not answer or the
 * body did not parse), which a later read can fix. "commands-only" is an answer: the stream holds
 * records, but none of them can be read as a turn: the last few are all S2 command records, or a
 * trim deleted every record. The last turn cannot be read and nothing will change that until the
 * agent writes again. Callers treat both as "no record to go on"; only the run-end check tells
 * them apart, by retrying "unknown" and not "commands-only".
 */
export type SessionOutTail =
  | { kind: "empty" }
  | { kind: "unknown" }
  | { kind: "commands-only" }
  | {
      kind: "record";
      control: string | undefined;
      timestamp: number;
      inConsumedSeq: number | undefined;
      /**
       * The `.in` cursor the run committed at this turn boundary: every record at or below it was
       * handled, anything past it is unread. Present on every SDK that writes the cursor at all.
       */
      inEventId?: number;
      /** On a `turn-handover` marker: the steps of the reply finished before it was handed over. */
      handoverSteps?: number;
      /** On a `turn-handover` marker for `chat.requestUpgrade()`: the target, "" for current. */
      handoverUpgrade?: string;
    };

/**
 * Thrown when a record's metered size would exceed S2's hard per-record
 * limit. Caught by the route handler and surfaced as 413.
 */
class S2RecordTooLargeError extends ServiceValidationError {
  constructor(public readonly meteredBytes: number) {
    super(
      `Record metered size ${meteredBytes} bytes exceeds the S2 per-record limit of ${S2_MAX_METERED_BYTES} bytes. Reduce tool-output size or split into smaller parts.`,
      413
    );
    this.name = "S2RecordTooLargeError";
  }
}

export type S2RealtimeStreamsOptions = {
  // S2
  basin: string; // e.g., "my-basin"
  accessToken: string; // "Bearer" token issued in S2 console
  streamPrefix?: string; // defaults to ""

  // Custom endpoint for s2-lite (self-hosted)
  endpoint?: string; // e.g., "http://localhost:4566/v1"
  /** Account-level API base for account/basin ops. Defaults to S2 cloud. */
  accountUrl?: string;
  /** Per-basin API base, with a `{basin}` placeholder. Defaults to S2 cloud. */
  basinUrl?: string;

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

const S2_APPEND_TOKEN_OPS = ["append", "create-stream"] as const;
const S2_SESSION_OUT_TOKEN_OPS = [...S2_APPEND_TOKEN_OPS, "trim"] as const;
const S2_TOKEN_CACHE_VERSION = "v2";

type S2TokenOperation = (typeof S2_SESSION_OUT_TOKEN_OPS)[number];
type S2TokenStreamScope =
  | { kind: "exact"; value: string; autoPrefixStreams: false }
  | { kind: "prefix"; value: string; autoPrefixStreams: true };

type S2TokenScope = {
  operations: readonly S2TokenOperation[];
  stream: S2TokenStreamScope;
};

/**
 * Placeholder handed back as the S2 access token when `skipAccessTokens` is set
 * and no token is configured (self-hosted s2-lite ignores the token entirely).
 * The SDK's session-stream writer rejects an empty access token as "no S2
 * credentials" and never opens the writer, so the token must be non-empty even
 * when it is semantically unused.
 */
const SKIP_ACCESS_TOKENS_SENTINEL = "s2-skip-access-tokens";

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
    this.baseUrl =
      opts.endpoint ??
      (opts.basinUrl ?? `https://{basin}.b.s2.dev/v1`).replace("{basin}", this.basin);
    this.accountUrl = opts.endpoint ?? opts.accountUrl ?? `https://a.s2.dev/v1`;
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
  public toSessionStreamName(friendlyId: string, io: "out" | "in", channel?: string): string {
    return `${this.streamPrefix}${this.#sessionStreamRelativeName(friendlyId, io, channel)}`;
  }

  #sessionStreamRelativeName(friendlyId: string, io: "out" | "in", channel?: string): string {
    return channel
      ? `/sessions/${friendlyId}/channels/${channel}/${io}`
      : `/sessions/${friendlyId}/${io}`;
  }

  async initializeStream(
    runId: string,
    streamId: string
  ): Promise<{ responseHeaders?: Record<string, string> }> {
    const prefixedName = this.toStreamName(runId, streamId);
    // Run writers use the relative-name contract shipped by older SDKs.
    return this.#initializeStreamByName(prefixedName, `/runs/${runId}/${streamId}`, {
      operations: S2_APPEND_TOKEN_OPS,
      stream: { kind: "prefix", value: this.streamPrefix, autoPrefixStreams: true },
    });
  }

  async initializeScopedStream(
    runId: string,
    streamId: string
  ): Promise<{ responseHeaders?: Record<string, string> }> {
    const streamName = this.toStreamName(runId, streamId);
    return this.#initializeStreamByName(streamName, streamName, {
      operations: S2_APPEND_TOKEN_OPS,
      stream: { kind: "exact", value: streamName, autoPrefixStreams: false },
    });
  }

  /**
   * Initialize an S2 stream by `(sessionFriendlyId, io)` — mirrors
   * {@link initializeStream} but addresses the new `sessions/*` key format.
   */
  async initializeSessionStream(
    friendlyId: string,
    io: "out" | "in",
    channel?: string
  ): Promise<{ responseHeaders?: Record<string, string> }> {
    const streamName = this.toSessionStreamName(friendlyId, io, channel);
    // Exact scopes cannot use S2 auto-prefixing, so clients receive the full name.
    return this.#initializeStreamByName(streamName, streamName, {
      operations: io === "out" ? S2_SESSION_OUT_TOKEN_OPS : S2_APPEND_TOKEN_OPS,
      stream: { kind: "exact", value: streamName, autoPrefixStreams: false },
    });
  }

  async #initializeStreamByName(
    prefixedName: string,
    clientStreamName: string,
    tokenScope: S2TokenScope
  ): Promise<{ responseHeaders?: Record<string, string> }> {
    const accessToken = this.skipAccessTokens
      ? this.token || SKIP_ACCESS_TOKENS_SENTINEL
      : await this.getS2AccessToken(randomUUID(), tokenScope);

    return {
      responseHeaders: {
        "X-S2-Access-Token": accessToken,
        "X-S2-Stream-Name": this.skipAccessTokens ? prefixedName : clientStreamName,
        "X-S2-Basin": this.basin,
        "X-S2-Flush-Interval-Ms": this.flushIntervalMs.toString(),
        "X-S2-Max-Retries": this.maxRetries.toString(),
        "X-S2-Endpoint": this.baseUrl,
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
    await this.#appendPartByName(part, partId, this.toStreamName(runId, streamId));
  }

  /** Append one record to a `Session` channel; returns its seq (same space as `session-in-event-id`). */
  async appendPartToSessionStream(
    part: string,
    partId: string,
    friendlyId: string,
    io: "out" | "in",
    channel?: string
  ): Promise<number> {
    return this.#appendPartByName(part, partId, this.toSessionStreamName(friendlyId, io, channel));
  }

  async #appendPartByName(part: string, partId: string, s2Stream: string): Promise<number> {
    const recordBody = JSON.stringify({ data: part, id: partId });
    const meteredBytes = Buffer.byteLength(recordBody, "utf8") + S2_RECORD_BASE_OVERHEAD_BYTES;
    if (meteredBytes > S2_MAX_METERED_BYTES) {
      throw new S2RecordTooLargeError(meteredBytes);
    }

    const result = await this.s2Append(s2Stream, {
      records: [{ body: recordBody }],
    });

    return result.start.seq_num;
  }

  getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number> {
    throw new Error("S2 streams are written to S2 via the client, not from the server");
  }

  async readRecords(
    runId: string,
    streamId: string,
    afterSeqNum?: number,
    limit?: number
  ): Promise<StreamRecord[]> {
    return this.#readRecordsByName(this.toStreamName(runId, streamId), afterSeqNum, limit);
  }

  async listRunStreams(runId: string): Promise<string[]> {
    const prefix = this.toStreamName(runId, "");
    const names = await this.#s2ListStreamNames(prefix);
    return names.map((name) => name.slice(prefix.length)).filter((streamId) => streamId);
  }

  /**
   * Read records from a `Session`-primitive channel starting after the
   * given sequence number. Used by the `.wait()` race-check path.
   */
  async readSessionStreamRecords(
    friendlyId: string,
    io: "out" | "in",
    afterSeqNum?: number,
    channel?: string,
    limit?: number
  ): Promise<StreamRecord[]> {
    return this.#readRecordsByName(
      this.toSessionStreamName(friendlyId, io, channel),
      afterSeqNum,
      limit
    );
  }

  async listSessionChannels(
    friendlyId: string,
    opts?: { beforeRead?: () => void }
  ): Promise<string[]> {
    const prefix = `${this.streamPrefix}/sessions/${friendlyId}/channels/`;
    const names = await this.#s2ListStreamNames(prefix, opts?.beforeRead);
    const channels = new Set<string>();
    for (const name of names) {
      const rest = name.slice(prefix.length);
      const channel = rest.split("/")[0];
      if (channel) channels.add(channel);
    }
    return [...channels];
  }

  async #s2ListStreamNames(prefix: string, beforeRead?: () => void): Promise<string[]> {
    const names: string[] = [];
    let startAfter: string | undefined;

    for (let page = 0; page < 100; page++) {
      if (page > 0) beforeRead?.();
      const qs = new URLSearchParams();
      qs.set("prefix", prefix);
      if (startAfter) qs.set("start_after", startAfter);

      const res = await fetch(`${this.baseUrl}/streams?${qs}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "S2-Basin": this.basin,
        },
      });

      if (!res.ok) {
        if (res.status === 404) return names;
        await cancelResponseBody(res);
        throw new Error(`S2 listStreams failed: ${res.status} ${res.statusText}`);
      }

      const body = (await res.json()) as {
        has_more?: boolean;
        streams?: Array<{ name: string; deleted_at?: string | null }>;
      };
      const streams = body.streams ?? [];
      for (const stream of streams) {
        if (stream.deleted_at) continue;
        names.push(stream.name);
      }
      if (!body.has_more || streams.length === 0) break;
      startAfter = streams[streams.length - 1]!.name;
    }

    return names;
  }

  /**
   * Non-blocking read of the records after `afterSeqNum`. Retries transient
   * failures (network errors, stream creation races, 5xx, and reads S2 ends with an `error` event)
   * because the `.wait()` race check depends on this read to find a record
   * sent before the waitpoint registered.
   */
  async #readRecordsByName(
    s2Stream: string,
    afterSeqNum?: number,
    limit?: number
  ): Promise<StreamRecord[]> {
    const backoffsMs = [100, 300];
    const maxAttempts = backoffsMs.length + 1;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#readRecordsOnce(s2Stream, afterSeqNum, limit);
      } catch (error) {
        const { status, streamNotFound } = error as {
          status?: number;
          streamNotFound?: boolean;
        };
        // A stream that is still absent after retries has no records yet.
        if (streamNotFound && attempt + 1 >= maxAttempts) return [];
        const isClientError =
          status !== undefined &&
          status >= 400 &&
          status < 500 &&
          status !== 409 &&
          !streamNotFound;
        if (isClientError || attempt + 1 >= maxAttempts) {
          this.logger.error("S2 readRecords failed", {
            stream: s2Stream,
            attempts: attempt + 1,
            error,
          });
          throw error;
        }

        this.logger.warn("S2 readRecords transient failure, retrying", {
          stream: s2Stream,
          attempt: attempt + 1,
          nextDelayMs: backoffsMs[attempt],
          error,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffsMs[attempt]));
      }
    }
  }

  async #readRecordsOnce(
    s2Stream: string,
    afterSeqNum?: number,
    limit?: number
  ): Promise<StreamRecord[]> {
    const startSeq = afterSeqNum != null ? afterSeqNum + 1 : 0;

    const qs = new URLSearchParams();
    qs.set("seq_num", String(startSeq));
    qs.set("clamp", "true");
    if (limit !== undefined) qs.set("count", String(limit));
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

    if (res.status === 416) {
      await cancelResponseBody(res);
      return [];
    }

    if (!res.ok) {
      const streamNotFound = await isS2StreamNotFound(res);
      await cancelResponseBody(res);
      throw Object.assign(new Error(`S2 readRecords failed: ${res.status} ${res.statusText}`), {
        status: res.status,
        streamNotFound,
      });
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

      if (eventType === "error") {
        throw new Error(`S2 readRecords failed: ${data ?? "error event"}`);
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
              timestamp: record.timestamp,
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
    options?: StreamResponseOptions,
    channel?: string
  ): Promise<Response> {
    const s2Stream = this.toSessionStreamName(friendlyId, io, channel);

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

  // ---------- Environment-level streams (signals) ----------

  /** An environment-level stream under this environment's prefix, e.g. `signals`. */
  public toEnvironmentStreamName(name: string): string {
    return `${this.streamPrefix}/${name}`;
  }

  /**
   * The last record of a stream and the seq the next append gets, without waiting. On a basin
   * that creates streams on read this creates an empty stream that didn't exist.
   */
  async readLastRecord(s2Stream: string): Promise<{
    nextSeq: number;
    record?: { seq: number; body: string; headers: Array<[string, string]> };
  }> {
    const res = await fetch(
      `${this.baseUrl}/streams/${encodeURIComponent(s2Stream)}/records?tail_offset=1&clamp=true&wait=0`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "S2-Format": "raw",
          "S2-Basin": this.basin,
        },
        signal: AbortSignal.timeout(S2_PEEK_TIMEOUT_MS),
      }
    );
    if (res.status === 416 || res.status === 404) {
      const body = (await res.json().catch(() => undefined)) as
        | { tail?: { seq_num?: number } }
        | undefined;
      return { nextSeq: body?.tail?.seq_num ?? 0 };
    }
    if (!res.ok) {
      await cancelResponseBody(res);
      throw new Error(`S2 read last record failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      records?: Array<{ seq_num: number; body: string; headers?: Array<[string, string]> }>;
      tail?: { seq_num: number };
    };
    const last = json.records?.at(-1);
    if (!last) return { nextSeq: json.tail?.seq_num ?? 0 };
    return {
      nextSeq: json.tail?.seq_num ?? last.seq_num + 1,
      record: { seq: last.seq_num, body: last.body, headers: last.headers ?? [] },
    };
  }

  /**
   * Append records only if the stream's next seq is still `matchSeqNum`. Returns the first
   * record's seq, or the actual next seq when another append got there first.
   */
  async appendIfNextSeq(
    s2Stream: string,
    records: Array<{ body: Uint8Array | string; headers?: Array<[string, string]> }>,
    matchSeqNum: number
  ): Promise<{ ok: true; startSeq: number } | { ok: false; nextSeq: number }> {
    const b64 = (value: Uint8Array | string) => Buffer.from(value).toString("base64");
    const res = await fetch(`${this.baseUrl}/streams/${encodeURIComponent(s2Stream)}/records`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "S2-Format": "base64",
        "S2-Basin": this.basin,
      },
      body: JSON.stringify({
        records: records.map((record) => ({
          ...(record.headers
            ? { headers: record.headers.map(([name, value]) => [b64(name), b64(value)]) }
            : {}),
          body: b64(record.body),
        })),
        match_seq_num: matchSeqNum,
      }),
      signal: AbortSignal.timeout(S2_WRITE_TIMEOUT_MS),
    });
    if (res.status === 412) {
      const body = (await res.json().catch(() => undefined)) as
        | { seq_num_mismatch?: number }
        | undefined;
      return { ok: false, nextSeq: body?.seq_num_mismatch ?? matchSeqNum };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`S2 append failed: ${res.status} ${text}`.trim()), {
        status: res.status,
      });
    }
    const ack = (await res.json()) as S2AppendAck;
    return { ok: true, startSeq: ack.start.seq_num };
  }

  /**
   * Keep a stream's records until they are trimmed, whatever the basin's age retention. Creates
   * the stream if it doesn't exist.
   */
  async keepStreamUntilTrimmed(s2Stream: string): Promise<void> {
    const config = { retention_policy: { infinite: {} } };
    const headers = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "S2-Basin": this.basin,
    };
    const patch = await fetch(`${this.baseUrl}/streams/${encodeURIComponent(s2Stream)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(S2_WRITE_TIMEOUT_MS),
    });
    if (patch.ok) return void (await cancelResponseBody(patch));
    await cancelResponseBody(patch);
    if (patch.status !== 404) {
      throw new Error(`S2 reconfigure stream failed: ${patch.status} ${patch.statusText}`);
    }
    const create = await fetch(`${this.baseUrl}/streams`, {
      method: "POST",
      headers,
      body: JSON.stringify({ stream: s2Stream, config }),
      signal: AbortSignal.timeout(S2_WRITE_TIMEOUT_MS),
    });
    await cancelResponseBody(create);
    if (!create.ok && create.status !== 409) {
      throw new Error(`S2 create stream failed: ${create.status} ${create.statusText}`);
    }
  }

  /** Delete a stream. A stream that doesn't exist counts as deleted. */
  async deleteStream(s2Stream: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/streams/${encodeURIComponent(s2Stream)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}`, "S2-Basin": this.basin },
      signal: AbortSignal.timeout(S2_WRITE_TIMEOUT_MS),
    });
    await cancelResponseBody(res);
    if (!res.ok && res.status !== 404) {
      throw new Error(`S2 delete stream failed: ${res.status} ${res.statusText}`);
    }
  }

  /** Serve SSE from an environment-level stream. */
  async streamResponseFromEnvironmentStream(
    name: string,
    signal: AbortSignal,
    options?: StreamResponseOptions
  ): Promise<Response> {
    return this.#streamResponseByName(this.toEnvironmentStreamName(name), signal, options);
  }

  async peekSessionOutTail(addressingKey: string): Promise<SessionOutTail> {
    return this.#peekTail(this.toSessionStreamName(addressingKey, "out"));
  }

  async readSessionInTailSeq(addressingKey: string): Promise<number | undefined> {
    return this.#readTailSeq(this.toSessionStreamName(addressingKey, "in"));
  }

  /** The next seq of `.out` (0 when empty); undefined when the tail can't be read. */
  async readSessionOutTailSeq(addressingKey: string): Promise<number | undefined> {
    return this.#readTailSeq(this.toSessionStreamName(addressingKey, "out"));
  }

  async #readTailSeq(
    s2Stream: string,
    signal: AbortSignal = AbortSignal.timeout(S2_PEEK_TIMEOUT_MS)
  ): Promise<number | undefined> {
    const res = await this.#fetchTail(s2Stream, "records/tail", "S2 read tail", signal);
    if (!res) return undefined;
    if (res.status === 404) return 0;
    if (res.status < 200 || res.status >= 300) {
      this.logger.warn("S2 read tail failed", { status: res.status, stream: s2Stream });
      return undefined;
    }
    const seqNum = parseTailSeq(res.body);
    if (seqNum === undefined) {
      this.logger.warn("S2 read tail: no seq_num in the response", { stream: s2Stream });
    }
    return seqNum;
  }

  /**
   * Peek the tail of `.out` and return whether the stream is "settled" —
   * i.e. the most recent non-command record is a `turn-complete` control
   * record.
   */
  async #peekIsSettled(s2Stream: string): Promise<boolean> {
    const tail = await this.#peekTail(s2Stream);
    return tail.kind === "record" && tail.control === "turn-complete";
  }

  /**
   * Read the most recent non-command record of a stream. The agent appends
   * an S2 `trim` command record after every turn-complete to keep `.out`
   * bounded, so the tail can be `[turn-complete, trim]`, or several trims.
   * Read the last two records first (the cheap read every reconnect pays).
   * When S2 returns fewer than two, it may have cut the read at its size cap
   * before the newest record, so the tail seq confirms it and the newest
   * record is read alone. When both are command records, walk back one record per read (S2 caps
   * one read at 1 MiB, so a wider read could stop before the newest records
   * and answer with an older one) until a real record turns up, looking at 6
   * records at most. When none does, or the stream is trimmed below the walk,
   * the answer is "commands-only": the stream was read, and it has no record
   * to report. A read that failed is "unknown", and so is a walk that ran out
   * of its 500 ms budget before finding a real record (the budget covers the
   * walk only, not the reads before it). Every read shares one deadline, so the
   * whole peek takes at most the peek timeout.
   */
  async #peekTail(s2Stream: string): Promise<SessionOutTail> {
    const signal = AbortSignal.timeout(S2_PEEK_TIMEOUT_MS);

    const narrow = await this.#readRecords(
      s2Stream,
      { tail_offset: String(PEEK_TAIL_RECORDS), count: String(PEEK_TAIL_RECORDS) },
      signal
    );
    if (narrow.kind === "no-records") return this.#tailAfterNoRecords(s2Stream, signal);
    if (narrow.kind !== "records") return narrow;

    let window = narrow.records;
    if (window.length < PEEK_TAIL_RECORDS) {
      // Fewer records than asked for: the stream holds fewer, or S2 cut the read at its size cap
      // and the newest record is beyond it. Only the tail seq tells them apart (one extra read,
      // only here). When the newest record is missing, read it alone and walk back from there.
      const tailSeq = await this.#readTailSeq(s2Stream, signal);
      if (tailSeq === undefined) return { kind: "unknown" };
      const last = window[window.length - 1]!;
      if (last.seq_num < tailSeq - 1) {
        const newest = await this.#readRecords(
          s2Stream,
          { seq_num: String(tailSeq - 1), count: "1" },
          signal
        );
        if (newest.kind === "no-records") return { kind: "unknown" };
        if (newest.kind !== "records") return newest;
        // Keep the records already read when they run up to the newest one, so the walk does not
        // read them again (one of them can be close to 1 MiB).
        window =
          newest.records[0]!.seq_num === last.seq_num + 1
            ? [...window, ...newest.records]
            : newest.records;
      }
    }
    const found = tailRecordFrom(window);
    if (found) return found;

    // Only commands so far. `seq` is the oldest record looked at: read the one before it. The walk
    // has its own budget on top of the peek's deadline, created only here, so a peek that found its
    // record makes no timer for it.
    const walkSignal = AbortSignal.any([signal, AbortSignal.timeout(PEEK_WALK_BUDGET_MS)]);
    let seq = window[0]!.seq_num;
    let looked = window.length;
    while (looked < PEEK_TAIL_MAX_RECORDS && seq > 0) {
      const older = await this.#readRecords(
        s2Stream,
        { seq_num: String(seq - 1), count: "1" },
        walkSignal
      );
      if (older.kind === "unknown") return older;
      // A 416 (S2 has no record there) or no records: trimmed below `seq`.
      if (older.kind !== "records") break;
      const record = older.records[0]!;
      // S2 starts a read below the trim point at the first record it still holds.
      if (record.seq_num !== seq - 1) break;
      const olderFound = tailRecordFrom([record]);
      if (olderFound) return olderFound;
      seq = record.seq_num;
      looked++;
    }

    this.logger.warn("S2 peek last record: only command records in the tail", {
      stream: s2Stream,
      looked,
    });
    return { kind: "commands-only" };
  }

  /** A read of `.out` records (`wait=0`, so it never long-polls), classified. */
  async #readRecords(
    s2Stream: string,
    query: Record<string, string>,
    signal: AbortSignal
  ): Promise<
    | { kind: "records"; records: PeekedRecord[] }
    | { kind: "no-records" }
    | { kind: "empty" }
    | { kind: "commands-only" }
    | { kind: "unknown" }
  > {
    const qs = new URLSearchParams({ ...query, wait: "0" });
    const label = "S2 peek last record";
    const res = await this.#fetchTail(s2Stream, `records?${qs}`, label, signal, {
      "S2-Format": "raw",
    });
    if (!res) return { kind: "unknown" };

    const answer = classifyTailRead(res.status, res.body);
    if (answer.kind === "unknown") {
      if (answer.reason === "parse-failed") {
        this.logger.warn(`${label}: parse failed`, { stream: s2Stream });
      } else {
        this.logger.warn(`${label} failed`, { status: res.status, stream: s2Stream });
      }
      return { kind: "unknown" };
    }
    return answer;
  }

  /**
   * A 200 with no records is a stream trimmed past its tail, or one that never held a record, so the
   * tail seq decides: past 0 means records were written and are gone, which is not "never written".
   * One extra read, only here.
   */
  async #tailAfterNoRecords(s2Stream: string, signal: AbortSignal): Promise<SessionOutTail> {
    const tailSeq = await this.#readTailSeq(s2Stream, signal);
    if (tailSeq === undefined) return { kind: "unknown" };
    if (tailSeq === 0) return { kind: "empty" };
    this.logger.warn("S2 peek last record: every record was trimmed", { stream: s2Stream });
    return { kind: "commands-only" };
  }

  /**
   * GET one of a stream's read endpoints with the whole body read, under the caller's deadline.
   * Undefined when S2 did not answer in time or the connection failed.
   */
  async #fetchTail(
    s2Stream: string,
    path: string,
    label: string,
    signal: AbortSignal,
    extraHeaders?: Record<string, string>
  ): Promise<{ status: number; body: string } | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/streams/${encodeURIComponent(s2Stream)}/${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...extraHeaders,
          "S2-Basin": this.basin,
        },
        signal,
      });
      return { status: res.status, body: await res.text() };
    } catch (error) {
      this.logger.warn(isTimeoutError(error) ? `${label}: timed out` : `${label}: fetch failed`, {
        stream: s2Stream,
        error: errorFields(error),
      });
      return undefined;
    }
  }

  async #streamResponseByName(
    s2Stream: string,
    signal: AbortSignal,
    options?: StreamResponseOptions
  ): Promise<Response> {
    const startSeq = this.parseLastEventId(options?.lastEventId);

    const tailFromLatest = startSeq == null && options?.startFrom === "latest";

    // Request SSE stream from S2 and return it directly
    const s2Response = await this.s2StreamRecords(s2Stream, {
      ...(tailFromLatest
        ? { tail_offset: 1, clamp: true }
        : { seq_num: startSeq ?? 0, clamp: true }),
      wait: options?.timeoutInSeconds ?? this.s2WaitSeconds, // S2 will keep the connection open and stream new records
      signal, // Pass abort signal so S2 connection is cleaned up when client disconnects
    });

    // Return S2's SSE response directly to the client
    return s2Response;
  }

  // ---------- Internals: S2 REST ----------
  private async s2Append(stream: string, body: S2AppendInput): Promise<S2AppendAck> {
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

    const maxAttempts = 5;
    const backoffsMs = [500, 1000, 1500, 2000];
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
        if (res.status === 409) {
          const text = await res.text().catch(() => "");
          lastError = new Error(`S2 append failed: 409 ${res.statusText} ${text}`.trim());
        } else {
          await cancelResponseBody(res);
          const httpError = Object.assign(
            new Error(`S2 append failed: ${res.status} ${res.statusText}`),
            { status: res.status }
          );
          if (res.status >= 400 && res.status < 500) {
            throw httpError;
          }
          lastError = httpError;
        }
      }

      const isLastAttempt = attempt === maxAttempts - 1;
      const diagnostics = describeFetchError(lastError);
      if (isLastAttempt) {
        this.logger.error("S2 append failed after retries", {
          attempts: maxAttempts,
          ...diagnostics,
        });
        break;
      }

      this.logger.warn("S2 append transient failure, retrying", {
        attempt: attempt + 1,
        nextDelayMs: backoffsMs[attempt],
        ...diagnostics,
      });
      await new Promise((resolve) => setTimeout(resolve, backoffsMs[attempt]));
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async getS2AccessToken(id: string, tokenScope: S2TokenScope): Promise<string> {
    if (!this.cache) {
      return this.s2IssueAccessToken(id, tokenScope);
    }

    const cacheKey = JSON.stringify([
      S2_TOKEN_CACHE_VERSION,
      this.basin,
      tokenScope.stream.kind,
      tokenScope.stream.value,
      [...tokenScope.operations].sort(),
      tokenScope.stream.autoPrefixStreams,
    ]);
    const result = await this.cache.accessToken.swr(cacheKey, async () => {
      return this.s2IssueAccessToken(id, tokenScope);
    });

    if (!result.val) {
      throw new Error("Failed to get S2 access token");
    }

    return result.val;
  }

  private async s2IssueAccessToken(id: string, tokenScope: S2TokenScope): Promise<string> {
    const streams =
      tokenScope.stream.kind === "exact"
        ? { exact: tokenScope.stream.value }
        : { prefix: tokenScope.stream.value };

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
          ops: [...tokenScope.operations],
          streams,
        },
        expires_at: new Date(Date.now() + this.accessTokenExpirationInMs).toISOString(),
        auto_prefix_streams: tokenScope.stream.autoPrefixStreams,
      }),
    });

    if (!res.ok) {
      await cancelResponseBody(res);
      throw new Error(`S2 issue access token failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as S2IssueAccessTokenResponse;
    return data.access_token;
  }

  private async s2StreamRecords(
    stream: string,
    opts: {
      seq_num?: number;
      tail_offset?: number;
      clamp?: boolean;
      wait?: number;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
    // GET /v1/streams/{stream}/records with Accept: text/event-stream for SSE streaming
    const qs = new URLSearchParams();
    if (opts.seq_num != null) qs.set("seq_num", String(opts.seq_num));
    if (opts.tail_offset != null) qs.set("tail_offset", String(opts.tail_offset));
    if (opts.clamp != null) qs.set("clamp", String(opts.clamp));
    if (opts.wait != null) qs.set("wait", String(opts.wait));

    // Concurrent first readers/writers can race S2's automatic stream creation.
    // S2-lite can also return stream_not_found during this race. Other 404s
    // (missing basin, token or route) are terminal. Retry before exposing SSE bytes.
    const backoffsMs = [100, 200, 400];
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(
        `${this.baseUrl}/streams/${encodeURIComponent(stream)}/records?${qs}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "text/event-stream",
            "S2-Format": "raw",
            "S2-Basin": this.basin,
          },
          signal: opts.signal,
        }
      );

      if (!res.ok) {
        const streamNotFound = await isS2StreamNotFound(res);
        await cancelResponseBody(res);
        opts.signal?.throwIfAborted();
        const delay = backoffsMs[attempt];
        if ((res.status === 409 || streamNotFound) && delay !== undefined) {
          await sleep(delay, undefined, { signal: opts.signal });
          continue;
        }
        throw new Error(`S2 stream failed: ${res.status} ${res.statusText}`);
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
  }

  private parseLastEventId(lastEventId?: string): number | undefined {
    if (!lastEventId) return undefined;
    // tolerate formats like "1699999999999-5" (take leading digits)
    const digits = lastEventId.split("-")[0];
    const n = Number(digits);
    return Number.isFinite(n) && n >= 0 ? n + 1 : undefined;
  }
}

async function isS2StreamNotFound(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    const error: unknown = await response.json();
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "stream_not_found"
    );
  } catch {
    return false;
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
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

/** Name and message only: a timeout and a refused connection read differently. */
function errorFields(error: unknown): { name: string; message: string; code?: string } {
  if (!(error instanceof Error)) return { name: "unknown", message: String(error) };
  // undici's "fetch failed" keeps the reason (ECONNREFUSED, ETIMEDOUT) on its cause.
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * The most recent non-command record of a window of records (oldest first), skipping S2 command
 * records (`headers[0][0] === ""`, e.g. `trim`). Undefined when the window holds only commands.
 */
function tailRecordFrom(records: PeekedRecord[]): SessionOutTail | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    if (record.headers?.[0]?.[0] === "") continue;
    const headers = record.headers ?? undefined;
    const consumed = headerValue(headers, SESSION_IN_CONSUMED_ID_HEADER);
    const inConsumedSeq = consumed !== undefined && consumed !== "" ? Number(consumed) : NaN;
    const eventId = headerValue(headers, SESSION_IN_EVENT_ID_HEADER);
    const inEventId = eventId !== undefined && eventId !== "" ? Number(eventId) : NaN;
    const steps = headerValue(headers, TURN_HANDOVER_STEPS_HEADER);
    const handoverSteps = steps !== undefined && steps !== "" ? Number(steps) : NaN;
    const handoverUpgrade = headerValue(headers, TURN_HANDOVER_UPGRADE_HEADER);
    return {
      kind: "record",
      control: headerValue(headers, "trigger-control"),
      timestamp: record.timestamp,
      inConsumedSeq: Number.isInteger(inConsumedSeq) ? inConsumedSeq : undefined,
      inEventId: Number.isInteger(inEventId) ? inEventId : undefined,
      ...(Number.isInteger(handoverSteps) ? { handoverSteps } : {}),
      ...(handoverUpgrade !== undefined ? { handoverUpgrade } : {}),
    };
  }
  return undefined;
}

/**
 * What a read of a stream's records answered, from its status and body. "no-records" is a 200 with
 * none, which only the stream's tail seq can place. A 416 is what hosted S2 answers to a read with
 * no record to return, with the stream's tail in the body: past 0 the records were trimmed away,
 * and at 0 the stream never held one. A 416 whose tail cannot be read is a failed read, not an
 * empty stream.
 */
export type TailReadAnswer =
  | { kind: "records"; records: PeekedRecord[] }
  | { kind: "no-records" }
  | { kind: "empty" }
  | { kind: "commands-only" }
  | { kind: "unknown"; reason: "status" | "parse-failed" };

export function classifyTailRead(status: number, body: string): TailReadAnswer {
  if (status === 404) return { kind: "empty" };
  if (status === 416) {
    const tailSeq = parseTailSeq(body);
    if (tailSeq === undefined) return { kind: "unknown", reason: "parse-failed" };
    return tailSeq === 0 ? { kind: "empty" } : { kind: "commands-only" };
  }
  if (status < 200 || status >= 300) return { kind: "unknown", reason: "status" };
  try {
    const json = JSON.parse(body) as { records?: PeekedRecord[] };
    const records = json.records ?? [];
    return records.length > 0 ? { kind: "records", records } : { kind: "no-records" };
  } catch {
    return { kind: "unknown", reason: "parse-failed" };
  }
}

/** The tail seq in a `records/tail` body (also in a 416's), undefined when it is not a number. */
export function parseTailSeq(body: string): number | undefined {
  try {
    const seqNum = (JSON.parse(body) as { tail?: { seq_num?: unknown } } | null)?.tail?.seq_num;
    return typeof seqNum === "number" ? seqNum : undefined;
  } catch {
    return undefined;
  }
}
