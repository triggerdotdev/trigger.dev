import { AppendInput, AppendRecord, S2 } from "@s2-dev/streamstore";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { SSEStreamSubscription } from "@trigger.dev/core/v3";

export type SessionAddressing = {
  orgId: string;
  envSlug: string;
  envId: string;
  addressingKey: string;
  io?: "out" | "in";
};

/**
 * The full, prefixed S2 stream name for a session channel on the shared basin
 * (per-org basins disabled), matching `toSessionStreamName` +
 * `streamPrefixFor` in the webapp. A test appending with the root S2 token uses
 * this literal name.
 */
export function sessionStreamName(p: SessionAddressing): string {
  return `org/${p.orgId}/env/${p.envSlug}/${p.envId}/sessions/${p.addressingKey}/${p.io ?? "out"}`;
}

/**
 * Mint a session-scoped public access token the way `mintSessionToken.server.ts`
 * does: a JWT signed with the environment secret, `sub` = env id, `pub` true,
 * scoped to read/write the given addressing key.
 */
export function mintSessionToken(p: {
  apiKey: string;
  envId: string;
  addressingKey: string;
}): Promise<string> {
  return generateJWT({
    secretKey: p.apiKey,
    payload: {
      pub: true,
      sub: p.envId,
      scopes: [`read:sessions:${p.addressingKey}`, `write:sessions:${p.addressingKey}`],
    },
    expirationTime: "1h",
  });
}

/**
 * Writes `.out` records straight to S2 (the "agent simulator"). Uses the same
 * `@s2-dev/streamstore` primitives the real agent runtime uses, so data,
 * `trigger-control` and `trim` command records land in exactly the shapes the
 * client + proxy expect.
 */
export class SessionStreamProducer {
  private stream;

  constructor(p: { endpoint: string; basin: string; streamName: string; accessToken?: string }) {
    const s2 = new S2({
      accessToken: p.accessToken ?? "ignored",
      endpoints: { account: p.endpoint, basin: p.endpoint },
    });
    this.stream = s2.basin(p.basin).stream(p.streamName);
  }

  /** Append one data record (`{data, id}` envelope). Returns its seq_num. */
  async appendData(data: unknown, id: string): Promise<number> {
    const ack = await this.stream.append(
      AppendInput.create([AppendRecord.string({ body: JSON.stringify({ data, id }) })])
    );
    return Number(ack.start.seqNum);
  }

  /** Append a `trigger-control: turn-complete` record (empty body). */
  async appendTurnComplete(publicAccessToken?: string): Promise<number> {
    const headers: Array<[string, string]> = [["trigger-control", "turn-complete"]];
    if (publicAccessToken) headers.push(["public-access-token", publicAccessToken]);
    const ack = await this.stream.append(
      AppendInput.create([AppendRecord.string({ body: "", headers })])
    );
    return Number(ack.start.seqNum);
  }

  /** Append an S2 `trim` command record, trimming below `earliestSeqNum`. */
  async trim(earliestSeqNum: number): Promise<void> {
    await this.stream.append(AppendInput.create([AppendRecord.trim(earliestSeqNum)]));
  }
}

export type CollectedPart = {
  id: string;
  chunk: unknown;
  headers?: ReadonlyArray<readonly [string, string]>;
};

export function isTurnComplete(part: CollectedPart): boolean {
  return (part.headers ?? []).some(([k, v]) => k === "trigger-control" && v === "turn-complete");
}

export function isUpgradeRequired(part: CollectedPart): boolean {
  return (part.headers ?? []).some(([k, v]) => k === "trigger-control" && v === "upgrade-required");
}

export type SubscribeOptions = {
  baseUrl: string;
  addressingKey: string;
  token: string;
  lastEventId?: string;
  timeoutInSeconds?: number;
  peekSettled?: boolean;
  io?: "out" | "in";
};

function sessionChannelUrl(baseUrl: string, addressingKey: string, io: "out" | "in"): string {
  return `${baseUrl}/realtime/v1/sessions/${encodeURIComponent(addressingKey)}/${io}`;
}

/**
 * Append a record to a session's `.in` channel through the webapp route the
 * browser uses (client -> agent). Returns the status, the reflected
 * Access-Control-Allow-Origin (when an Origin was sent), and the parsed body.
 */
export async function appendInput(opts: {
  baseUrl: string;
  addressingKey: string;
  token: string;
  body: string;
  partId?: string;
  origin?: string;
}): Promise<{ status: number; acao: string | null; json: unknown }> {
  const url = `${sessionChannelUrl(opts.baseUrl, opts.addressingKey, "in")}/append`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      ...(opts.partId ? { "X-Part-Id": opts.partId } : {}),
      ...(opts.origin ? { Origin: opts.origin } : {}),
    },
    body: opts.body,
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, acao: res.headers.get("access-control-allow-origin"), json };
}

/**
 * Raw SSE GET against a session channel, exposing the response status +
 * headers (which `SSEStreamSubscription` hides). Reads the body to close and
 * reports how long that took, for asserting the server-side peek fast-close.
 */
export async function openChannelRaw(opts: SubscribeOptions & { maxMs?: number }): Promise<{
  status: number;
  sessionSettled: string | null;
  closedMs: number;
  body: string;
  timedOut: boolean;
}> {
  const url = sessionChannelUrl(opts.baseUrl, opts.addressingKey, opts.io ?? "out");
  const started = performance.now();
  const maxMs = opts.maxMs ?? 15_000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), maxMs);
  try {
    const res = await fetch(url, {
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "text/event-stream",
        ...(opts.lastEventId ? { "Last-Event-ID": opts.lastEventId } : {}),
        ...(opts.timeoutInSeconds ? { "Timeout-Seconds": String(opts.timeoutInSeconds) } : {}),
        ...(opts.peekSettled ? { "X-Peek-Settled": "1" } : {}),
      },
    });
    const sessionSettled = res.headers.get("x-session-settled");
    let body = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
      } catch {
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    return {
      status: res.status,
      sessionSettled,
      closedMs: performance.now() - started,
      body,
      timedOut: false,
    };
  } catch {
    return {
      status: 0,
      sessionSettled: null,
      closedMs: performance.now() - started,
      body: "",
      timedOut: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function subscribeSessionOut(opts: SubscribeOptions): SSEStreamSubscription {
  const url = sessionChannelUrl(opts.baseUrl, opts.addressingKey, opts.io ?? "out");
  return new SSEStreamSubscription(url, {
    headers: {
      Authorization: `Bearer ${opts.token}`,
      ...(opts.peekSettled ? { "X-Peek-Settled": "1" } : {}),
    },
    timeoutInSeconds: opts.timeoutInSeconds ?? 30,
    lastEventId: opts.lastEventId,
    maxRetries: 0,
  });
}

/**
 * Subscribe + drain parts into an array, stopping when `until(parts)` is true,
 * the stream closes, or `maxMs` elapses. Cancels the reader on exit. Returns
 * the parts plus how many distinct SSE connections/opens the subscription made
 * (for asserting the round-trip count on a reconnect).
 */
export async function collectSessionOut(
  opts: SubscribeOptions & { until?: (parts: CollectedPart[]) => boolean; maxMs?: number }
): Promise<{ parts: CollectedPart[]; durationMs: number; subscription: SSEStreamSubscription }> {
  const subscription = subscribeSessionOut(opts);
  const stream = await subscription.subscribe();
  const reader = stream.getReader();
  const parts: CollectedPart[] = [];
  const started = performance.now();
  const deadline = started + (opts.maxMs ?? 30_000);

  try {
    while (true) {
      if (opts.until && opts.until(parts)) break;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
      ]);
      if (next === "timeout") break;
      if (next.done) break;
      parts.push(next.value as CollectedPart);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { parts, durationMs: performance.now() - started, subscription };
}

/**
 * Subscribe + drain while awaiting the client's `caughtUp()`. Resolves once the
 * client reports it has drained to the live tail (or `maxMs` elapses). Used by
 * the GREEN legs: the drain is what lets the wrapper mark the tail boundary, so
 * `parts` holds everything delivered up to the moment caught-up fires — the
 * data-loss guard.
 */
export async function collectUntilCaughtUp(opts: SubscribeOptions & { maxMs?: number }): Promise<{
  parts: CollectedPart[];
  caughtUp: boolean;
  tailSeqNum?: number;
  settleMs: number;
}> {
  const subscription = subscribeSessionOut(opts);
  const stream = await subscription.subscribe();
  const reader = stream.getReader();
  const parts: CollectedPart[] = [];
  const started = performance.now();

  let caughtUp = false;
  let tailSeqNum: number | undefined;
  let settleMs = 0;
  subscription
    .caughtUp()
    .then((tail) => {
      caughtUp = true;
      tailSeqNum = tail.seqNum;
      settleMs = performance.now() - started;
    })
    .catch(() => {});

  const deadline = started + (opts.maxMs ?? 30_000);
  try {
    while (!caughtUp) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<"tick">((r) => setTimeout(() => r("tick"), Math.min(remaining, 250))),
      ]);
      if (next === "tick") continue;
      if (next.done) break;
      parts.push(next.value as CollectedPart);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { parts, caughtUp, tailSeqNum, settleMs: settleMs || performance.now() - started };
}
