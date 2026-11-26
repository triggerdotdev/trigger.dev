import {
  MAX_SIGNAL_KEYS,
  parseSignalRecord,
  RESERVED_SIGNAL_PREFIX,
  SIGNAL_PAYLOAD_MAX_BYTES,
  signalEntryKey,
  signalNameError,
  signalPayloadError,
  type SignalEntry,
  type SignalRecord,
  tryCatch,
} from "@trigger.dev/core/v3";
import { randomUUID } from "node:crypto";
import pMap from "p-map";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { meter, startActiveSpan } from "~/v3/tracer.server";
import { S2RealtimeStreams } from "./s2realtimeStreams.server";
import {
  getRealtimeStreamInstance,
  hasS2RealtimeStreams,
  type StreamEnvironment,
} from "./v1StreamsGlobal.server";

// Signals: one S2 stream per environment (`<env prefix>/signals`), appended by the webapp on
// send, read by runs through `GET /realtime/v1/signals`. Every record carries the latest signal of
// every (name, task) pair, so S2 is the only store: "latest of name N" is the stream's last record,
// read without scanning, and a listener that starts at the last record has the state in its first
// record. A send reads the last record, merges, and appends only if nothing was appended since
// (S2 `match_seq_num`), so concurrent sends can't lose each other's entries.

export const SIGNALS_STREAM = "signals";

/** Records kept behind the tail. Only the last one is needed; the rest cover slow readers. */
const SIGNAL_RECORDS_KEPT = 100;
/** A platform payload (the skew protection threshold signal) can name up to 50 tasks. */
const PLATFORM_SIGNAL_PAYLOAD_MAX_BYTES = 32 * 1024;
const SEND_ATTEMPTS = 5;
/** The platform's own sends (the threshold signal) must not starve behind a burst of API sends. */
const PLATFORM_SEND_ATTEMPTS = 10;
/**
 * The largest record a send or clear may append. Worst case within the other caps: 32 API entries
 * of a 1 KiB payload, a 128-character name and a 256-character task (about 1.5 KiB each as JSON,
 * 48 KiB) plus the platform's skew protection threshold signal (at most 50 tasks, about 17 KiB), doubled by
 * the record's data being a JSON string inside the S2 envelope: about 130 KiB. S2's record limit
 * is 1 MiB. Every listening run receives each record, so this is a guard, not a budget.
 */
const MAX_SIGNAL_RECORD_BYTES = 256 * 1024;

const sendsCounter = meter.createCounter("signals.sends_total", {
  description: "Signal sends and clears appended to an environment's signal stream",
});
const openSubscriptions = meter.createUpDownCounter("signals.subscriptions_open", {
  description: "Runs subscribed to their environment's signal stream through this process",
});

export class SignalError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 413 | 501 | 503
  ) {
    super(message);
    this.name = "SignalError";
  }
}

/** A timeout, a failed connection or a 5xx from S2. */
export function isS2Unavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  return /^S2 .*failed: 5\d\d\b/.test(error.message);
}

type SignalStreamEnvironment = StreamEnvironment & {
  organization: { streamBasinName: string | null };
};

/**
 * Whether the organization's environments have signals (and so mid-turn handovers): false on an
 * instance without S2 realtime streams, where `signalStreamsFor` throws the 501.
 */
export function signalsAvailable(organization: { streamBasinName: string | null }): boolean {
  return hasS2RealtimeStreams({ organization });
}

export function signalStreamsFor(environment: SignalStreamEnvironment): S2RealtimeStreams {
  let streams: unknown;
  try {
    streams = getRealtimeStreamInstance(environment, "v2", {
      organization: environment.organization,
    });
  } catch {
    streams = undefined;
  }
  if (!(streams instanceof S2RealtimeStreams)) {
    throw new SignalError("Signals require the S2 realtime backend.", 501);
  }
  return streams;
}

/**
 * Delete the signal streams of environments that are going away (project or org deleted, branch
 * archived). The stream keeps its records until trimmed, so nothing else removes the payloads.
 * Pass each environment's slug from before an archive renamed it. Best effort: failures are logged.
 */
export async function deleteEnvironmentSignalStreams(
  environments: SignalStreamEnvironment[]
): Promise<void> {
  for (const environment of environments) {
    let streams: S2RealtimeStreams;
    try {
      streams = signalStreamsFor(environment);
    } catch {
      continue; // No S2 backend for this environment, so no signal stream.
    }
    const [error] = await tryCatch(
      streams.deleteStream(streams.toEnvironmentStreamName(SIGNALS_STREAM))
    );
    if (error) {
      logger.warn("Failed to delete an environment's signal stream", {
        environmentId: environment.id,
        error,
      });
    }
  }
}

/**
 * Carry environments' signal state across an organization's basin change (provisioned or
 * deprovisioned): merge each old stream's latest signals into the new stream, then delete the old
 * stream. A (name, task) pair already sent to the new stream (after the cutover, so newer) keeps
 * that value; the rest carry over. Re-run safe; best effort: failures are logged, never thrown,
 * and the old stream is deleted only after its state reached the new one.
 */
export async function moveEnvironmentSignalStreams(
  environments: StreamEnvironment[],
  fromBasin: string | null,
  toBasin: string | null
): Promise<void> {
  await pMap(
    environments,
    async (environment) => {
      const [error, outcome] = await tryCatch(moveSignalStream(environment, fromBasin, toBasin));
      if (error) {
        logger.warn("Failed to move an environment's signal stream to its new basin", {
          environmentId: environment.id,
          fromBasin,
          toBasin,
          error,
        });
      } else if (outcome !== "none") {
        logger.info("Moved an environment's signal stream to its new basin", {
          environmentId: environment.id,
          fromBasin,
          toBasin,
          outcome,
        });
      }
    },
    { concurrency: 5 }
  );
}

async function moveSignalStream(
  environment: StreamEnvironment,
  fromBasin: string | null,
  toBasin: string | null
): Promise<"none" | "copied" | "kept-newer"> {
  let from: S2RealtimeStreams;
  let to: S2RealtimeStreams;
  try {
    from = signalStreamsFor({
      ...environment,
      organization: { ...environment.organization, streamBasinName: fromBasin },
    });
    to = signalStreamsFor({
      ...environment,
      organization: { ...environment.organization, streamBasinName: toBasin },
    });
  } catch {
    return "none"; // One side has no S2 backend: nothing to move, or nowhere to move it.
  }
  const fromStream = from.toEnvironmentStreamName(SIGNALS_STREAM);
  const sourceLast = await from.readLastRecord(fromStream);
  const source = latestOf(sourceLast);
  const outcome =
    source.length > 0 ? await mergeSignals(environment, to, source, sourceLast.nextSeq) : "none";
  await from.deleteStream(fromStream);
  return outcome;
}

/**
 * A last record's latest map, oldest first. As runs do: an entry claiming a later seq than its
 * record wasn't written by a send.
 */
function latestOf(last: { record?: { seq: number; body: string } }): SignalEntry[] {
  const record = last.record;
  if (!record) return [];
  return (readRecord(record.body)?.latest ?? [])
    .filter((e) => e.seq <= record.seq)
    .sort((a, b) => a.seq - b.seq);
}

/** S2 takes at most this many records in one append. */
const S2_MAX_BATCH_RECORDS = 1000;

/**
 * Append `source`'s pairs that the stream doesn't have, under the ones it does, as one record.
 * Every entry is renumbered in order (the carried ones first) up to the record's own seq, which
 * no-op trims ahead of it make room for: the newer of a signal sent to every run and one sent to a
 * task stays the newer one. The trims also lift the entries to the old stream's next seq, so a run
 * that reconnects with a cursor from the old stream resumes before the record and finds every
 * entry above what it was delivered. Carried pairs that would take the map over the send limits
 * are dropped, oldest first and API names before the platform's: sends and clears must keep
 * working on the new stream.
 */
async function mergeSignals(
  environment: StreamEnvironment,
  to: S2RealtimeStreams,
  source: SignalEntry[],
  sourceNextSeq: number
): Promise<"copied" | "kept-newer"> {
  const stream = to.toEnvironmentStreamName(SIGNALS_STREAM);
  await to.keepStreamUntilTrimmed(stream);
  for (let attempt = 1; ; attempt++) {
    const last = await to.readLastRecord(stream);
    const current = latestOf(last);
    const sent = new Set(current.map(signalEntryKey));
    const carried = source.filter((e) => !sent.has(signalEntryKey(e)));
    const dropped: string[] = [];
    let body = "";
    let latest: SignalEntry[] = [];
    while (carried.length > 0) {
      const entries = [...carried, ...current];
      // shortcut: the lift fits one append, so a cursor over ~1000 records behind the old stream's
      // tail can still land on the new one's seqs; carry a stream id in records and cursors if
      // basin moves with long-suspended listeners show up.
      const lift = Math.max(
        0,
        Math.min(sourceNextSeq - last.nextSeq, S2_MAX_BATCH_RECORDS - entries.length)
      );
      latest = entries.map((e, i) => ({ ...e, seq: last.nextSeq + lift + i }));
      const record: SignalRecord = { name: latest[latest.length - 1].name, latest };
      body = JSON.stringify({ data: JSON.stringify(record), id: randomUUID() });
      const overKeys =
        apiEntries(new Map(entries.map((e) => [signalEntryKey(e), e]))) > MAX_SIGNAL_KEYS;
      if (!overKeys && Buffer.byteLength(body, "utf8") <= MAX_SIGNAL_RECORD_BYTES) break;
      const api = carried.findIndex((e) => !e.name.startsWith(RESERVED_SIGNAL_PREFIX));
      if (overKeys && api === -1) break; // Only the new stream's own pairs are over the cap.
      dropped.push(signalEntryKey(carried.splice(api === -1 ? 0 : api, 1)[0]));
    }
    if (dropped.length > 0) {
      logger.warn("Dropped signals that would take the new basin's signals over the limits", {
        environmentId: environment.id,
        dropped,
      });
    }
    if (carried.length === 0) return "kept-newer";
    const trimNothing = Buffer.alloc(8); // Trim to seq 0.
    const result = await to.appendIfNextSeq(
      stream,
      [
        ...Array.from({ length: latest[0].seq - last.nextSeq + latest.length - 1 }, () => ({
          headers: [["", "trim"]] as Array<[string, string]>,
          body: trimNothing,
        })),
        { body },
      ],
      last.nextSeq
    );
    if (result.ok) return "copied";
    if (attempt >= PLATFORM_SEND_ATTEMPTS) {
      throw new Error("The new signal stream kept changing during the move");
    }
  }
}

export type SendSignalInput = { name: string; payload: unknown; task?: string };

/**
 * Validate a send. `platform` sends (from the webapp itself) may use `trigger.` names and a
 * larger payload; API sends may not.
 */
function validateSignal(input: SendSignalInput, options?: { platform?: boolean }): void {
  const nameError = signalNameError(input.name, { allowReserved: options?.platform });
  if (nameError) throw new SignalError(nameError, 400);
  if (input.task !== undefined && (input.task.length === 0 || input.task.length > 256)) {
    throw new SignalError("A task id is 1 to 256 characters.", 400);
  }
  const max = options?.platform ? PLATFORM_SIGNAL_PAYLOAD_MAX_BYTES : SIGNAL_PAYLOAD_MAX_BYTES;
  const payloadError = signalPayloadError(input.payload, max);
  if (payloadError) throw new SignalError(payloadError, 400);
}

function readRecord(body: string | undefined): SignalRecord | undefined {
  if (!body) return undefined;
  try {
    const envelope = JSON.parse(body) as { data?: unknown };
    return parseSignalRecord(envelope.data);
  } catch {
    return undefined;
  }
}

/** The latest signal of every (name, task) pair, from the stream's last record. */
export async function readLatestSignals(
  environment: AuthenticatedEnvironment
): Promise<SignalEntry[]> {
  const streams = signalStreamsFor(environment);
  const last = await streams.readLastRecord(streams.toEnvironmentStreamName(SIGNALS_STREAM));
  const record = last.record;
  // As runs do: an entry claiming a later seq than its record wasn't written by a send.
  return record ? (readRecord(record.body)?.latest ?? []).filter((e) => e.seq <= record.seq) : [];
}

/**
 * The latest signal of `name` sent with `task` (absent: the untasked one), or null. With
 * `includeUntasked`, the newer of that and the untasked one: what a run of `task` gets first from
 * `on(name)`.
 */
export async function latestEnvironmentSignal(
  environment: AuthenticatedEnvironment,
  input: { name: string; task?: string; includeUntasked?: boolean }
): Promise<SignalEntry | null> {
  validateSignal({ name: input.name, task: input.task, payload: null }, { platform: true });
  let found: SignalEntry | null = null;
  for (const entry of await readLatestSignals(environment)) {
    if (entry.name !== input.name) continue;
    if (entry.task !== input.task && !(input.includeUntasked && entry.task === undefined)) continue;
    if (!found || entry.seq > found.seq) found = entry;
  }
  return found;
}

type LatestMap = Map<string, SignalEntry>;

/**
 * Change the latest map with one conditional append: read the last record, apply `change`, append
 * `[trim, data]` only if nothing was appended since (S2 `match_seq_num`), retry on a lost race.
 * `change` gets the seq the new record will have and returns false to append nothing.
 */
async function updateLatestSignals(
  environment: AuthenticatedEnvironment,
  operation: "send" | "clear",
  input: { name: string; task?: string; platform: boolean },
  change: (latest: LatestMap, seq: number) => boolean
): Promise<{ seq: number } | undefined> {
  return startActiveSpan(`signals.${operation}`, async (span) => {
    span.setAttribute("environmentId", environment.id);
    span.setAttribute("signal.name", input.name);
    if (input.task !== undefined) span.setAttribute("signal.task", input.task);

    const streams = signalStreamsFor(environment);
    const stream = streams.toEnvironmentStreamName(SIGNALS_STREAM);

    for (let attempt = 1; ; attempt++) {
      const last = await streams.readLastRecord(stream);
      const trim = last.nextSeq > 0;
      // The data record comes after the trim command, so it is always the stream's last record.
      const seq = trim ? last.nextSeq + 1 : last.nextSeq;
      const latest: LatestMap = new Map(
        (readRecord(last.record?.body)?.latest ?? []).map((e) => [signalEntryKey(e), e])
      );
      if (!change(latest, seq)) {
        span.setAttribute("signal.changed", false);
        return undefined;
      }
      if (last.nextSeq === 0) {
        // First write (the stream is new, or a listener's read created it with the basin's age
        // retention): keep its records until trimmed, or a quiet environment would lose the latest.
        await streams.keepStreamUntilTrimmed(stream);
      }

      const record: SignalRecord = { name: input.name, latest: [...latest.values()] };
      const body = JSON.stringify({ data: JSON.stringify(record), id: randomUUID() });
      const recordBytes = Buffer.byteLength(body, "utf8");
      if (recordBytes > MAX_SIGNAL_RECORD_BYTES) {
        throw new SignalError(
          `The environment's signals would take ${recordBytes} bytes, over the ${MAX_SIGNAL_RECORD_BYTES} byte limit. Clear some with unstable_signals.clear(name).`,
          413
        );
      }

      const trimTo = Buffer.alloc(8);
      trimTo.writeBigUInt64BE(BigInt(Math.max(0, last.nextSeq - SIGNAL_RECORDS_KEPT)));
      const result = await streams.appendIfNextSeq(
        stream,
        [
          ...(trim ? [{ headers: [["", "trim"]] as Array<[string, string]>, body: trimTo }] : []),
          { body },
        ],
        last.nextSeq
      );
      if (result.ok) {
        span.setAttribute("signal.seq", seq);
        span.setAttribute("signal.recordBytes", recordBytes);
        span.setAttribute("signal.retries", attempt - 1);
        span.setAttribute("signal.names", latest.size);
        sendsCounter.add(1, { operation, platform: input.platform });
        logger.info(
          operation === "send" ? "Sent an environment signal" : "Cleared an environment signal",
          {
            environmentId: environment.id,
            // Not `name`: the logger sets its own.
            signalName: input.name,
            task: input.task,
            seq,
            recordBytes,
            retries: attempt - 1,
            names: latest.size,
          }
        );
        return { seq };
      }
      const attempts = input.platform ? PLATFORM_SEND_ATTEMPTS : SEND_ATTEMPTS;
      if (attempt >= attempts) {
        span.setAttribute("signal.retries", attempt - 1);
        throw new SignalError("Signals in this environment are busy. Try again shortly.", 503);
      }
      // Jittered backoff: concurrent sends that retried at once would collide again every attempt.
      await sleep(attempt * (10 + Math.random() * 40));
    }
  });
}

/**
 * Send a signal to the environment: one S2 append (plus the read of the last record it merges
 * with). Returns the record's seq. Throws {@link SignalError} with the HTTP status.
 */
export async function sendEnvironmentSignal(
  environment: AuthenticatedEnvironment,
  input: SendSignalInput,
  options?: { platform?: boolean }
): Promise<{ seq: number }> {
  validateSignal(input, options);
  const platform = options?.platform ?? false;
  const result = await updateLatestSignals(
    environment,
    "send",
    { name: input.name, task: input.task, platform },
    (latest, seq) => {
      const entry: SignalEntry = {
        name: input.name,
        ...(input.task !== undefined ? { task: input.task } : {}),
        payload: input.payload ?? null,
        sentAt: new Date().toISOString(),
        seq,
        id: randomUUID(),
      };
      const key = signalEntryKey(entry);
      if (!latest.has(key) && !platform && apiEntries(latest) >= MAX_SIGNAL_KEYS) {
        throw new SignalError(
          `An environment holds the latest signal of at most ${MAX_SIGNAL_KEYS} names (each name and task pair counts once). Clear one with unstable_signals.clear(name) first.`,
          409
        );
      }
      latest.set(key, entry);
      return true;
    }
  );
  // A send always appends.
  return result!;
}

/**
 * Free a name: remove the latest signal of (name, task) from the map, so late listeners don't get
 * it and it no longer counts towards the cap. Runs already listening are not told. Returns the
 * record's seq, or `cleared: false` when there was nothing to clear (no append).
 */
export async function clearEnvironmentSignal(
  environment: AuthenticatedEnvironment,
  input: { name: string; task?: string },
  options?: { platform?: boolean }
): Promise<{ cleared: boolean; seq?: number }> {
  validateSignal({ ...input, payload: null }, options);
  const result = await updateLatestSignals(
    environment,
    "clear",
    { ...input, platform: options?.platform ?? false },
    (latest) => latest.delete(signalEntryKey(input))
  );
  return result ? { cleared: true, seq: result.seq } : { cleared: false };
}

/** Entries that count towards the cap: the platform's own names don't. */
function apiEntries(latest: LatestMap): number {
  let count = 0;
  for (const entry of latest.values()) {
    if (!entry.name.startsWith(RESERVED_SIGNAL_PREFIX)) count++;
  }
  return count;
}

/**
 * The seq a subscription resumes after, from its `Last-Event-ID`, or undefined to start at the
 * latest record. A negative id would replay every retained record, and one past the stream's tail
 * (a run resuming after its stream was recreated) would wait for a seq that may never come: both
 * start at the latest record, which carries every name's newest signal. One S2 read per resume;
 * if it fails, the id is used as given.
 */
export async function signalResumeSeq(
  streams: Pick<S2RealtimeStreams, "readLastRecord" | "toEnvironmentStreamName">,
  lastEventId: string | undefined
): Promise<number | undefined> {
  const lastSeq = lastEventId ? Number.parseInt(lastEventId.split(",")[0]!, 10) : NaN;
  if (!Number.isFinite(lastSeq) || lastSeq < 0) return undefined;
  const [error, last] = await tryCatch(
    streams.readLastRecord(streams.toEnvironmentStreamName(SIGNALS_STREAM))
  );
  if (!error && lastSeq >= last.nextSeq) return undefined;
  return lastSeq;
}

/** Count a run's subscription while its response is open. */
export function trackSignalSubscription(
  environment: AuthenticatedEnvironment,
  details: { resumeAfterSeq?: number }
): () => void {
  openSubscriptions.add(1);
  const opened = Date.now();
  logger.debug("A run subscribed to its environment's signals", {
    environmentId: environment.id,
    resumeAfterSeq: details.resumeAfterSeq,
  });
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    openSubscriptions.add(-1);
    logger.debug("A signal subscription closed", {
      environmentId: environment.id,
      openForMs: Date.now() - opened,
    });
  };
}
