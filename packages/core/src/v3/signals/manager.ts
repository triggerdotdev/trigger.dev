import { ApiError } from "../apiClient/errors.js";
import type { ApiClient } from "../apiClient/index.js";
import { computeReconnectDelayMs } from "../utils/reconnectBackoff.js";
import {
  parseSignalRecord,
  signalEntryKey,
  type SignalEntry,
  type SignalHandler,
  type SignalsManager,
} from "./types.js";

/**
 * Statuses that won't change for the rest of the run: a bad request, a credential without access
 * to signals (403), a missing stream, or a server without the S2 realtime backend (501,
 * self-hosted on v1). The subscription stops instead of retrying for the whole run.
 */
const PERMANENT_SUBSCRIPTION_STATUSES = [400, 403, 404, 409, 410, 422, 501];

type Listener = {
  name: string;
  handler: SignalHandler;
  /** The last entry this listener has been given, per (name, task) key. */
  delivered: Map<string, Delivered>;
};

/**
 * A delivered entry's seq, and what identifies the send across streams: a basin move carries the
 * latest map to a new stream under new seqs, keeping each entry's `id` (`sentAt` and payload on
 * entries written before ids).
 */
type Delivered = { seq: number; identity: string };

/** Computed when the record arrives: a handler may change the payload object it is given. */
function identityOf(entry: SignalEntry): string {
  if (entry.id !== undefined) return `id:${entry.id}`;
  let payload: string | undefined;
  try {
    payload = JSON.stringify(entry.payload);
  } catch {
    payload = undefined;
  }
  return `at:${entry.sentAt}\u0000${payload ?? ""}`;
}

/**
 * The run's side of signals. The first `on()` opens one subscription to the environment's signal
 * stream (through the realtime service); stopping the last listener closes it. A fresh
 * subscription starts at the stream's last record, whose latest map already holds the newest
 * signal of every name, so a listener that starts late still learns the state. A reconnect
 * resumes after the last record seen; every record carries the latest map again, so a gap (a
 * dropped connection, a suspended run, trimmed records) costs at most the values in between: each
 * listener gets the newest of each name, never one it already had.
 */
export class StandardSignalsManager implements SignalsManager {
  #listeners = new Set<Listener>();
  /** The newest entry per (name, task) seen on the stream, so a later listener starts from it. */
  #latest = new Map<string, { entry: SignalEntry; identity: string }>();
  #lastSeq: number | undefined;
  #tail: AbortController | undefined;

  constructor(
    private readonly apiClient: ApiClient,
    private readonly baseUrl: string,
    /** The id of the task this run executes, for signals sent to one task. */
    private readonly currentTaskId: () => string | undefined,
    private readonly debug = false
  ) {}

  on(name: string, handler: SignalHandler): () => void {
    const listener: Listener = { name, handler, delivered: new Map() };
    this.#listeners.add(listener);
    // What the subscription already knows, delivered after `on()` returns like a live signal.
    queueMicrotask(() => {
      if (this.#listeners.has(listener)) this.#deliver(listener);
    });
    this.#ensureTail();

    return () => {
      this.#listeners.delete(listener);
      // The next subscription starts at the stream's last record, which holds the current state:
      // keeping this one's would hand a later listener a value that may have changed since.
      if (this.#listeners.size === 0) this.reset();
    };
  }

  reset(): void {
    this.#listeners.clear();
    this.#stopTail();
    this.#latest.clear();
    this.#lastSeq = undefined;
  }

  /** @internal For tests: apply a record as if it arrived on the subscription. */
  applyRecord(data: unknown, seq: number): void {
    // A record below the last one seen means the stream was recreated and its seqs start again.
    // What each listener was given still counts, by its send (see `Delivered`).
    if (this.#lastSeq !== undefined && seq < this.#lastSeq) {
      this.#latest.clear();
      for (const listener of this.#listeners) {
        for (const delivered of listener.delivered.values()) delivered.seq = -1;
      }
    }
    this.#lastSeq = seq;
    const record = parseSignalRecord(data);
    if (!record) return;
    // A record's latest map is the whole state, so a cleared name drops out.
    // An entry is written in a record at its own seq, so one claiming a later seq than the record
    // carrying it wasn't written by a send (a direct append), and would outrank every real one.
    this.#latest = new Map(
      record.latest
        .filter((entry) => entry.seq <= seq)
        .map((entry) => [signalEntryKey(entry), { entry, identity: identityOf(entry) }])
    );
    for (const listener of this.#listeners) this.#deliver(listener);
  }

  #deliver(listener: Listener): void {
    const taskId = this.currentTaskId();
    const due: SignalEntry[] = [];
    const renumbered: SignalEntry[] = [];
    for (const [key, { entry, identity }] of this.#latest) {
      if (entry.name !== listener.name) continue;
      if (entry.task !== undefined && entry.task !== taskId) continue;
      const last = listener.delivered.get(key);
      if (last && entry.seq <= last.seq) continue;
      listener.delivered.set(key, { seq: entry.seq, identity });
      // The same send under a new seq: a basin move renumbered it.
      if (last?.identity === identity) renumbered.push(entry);
      else due.push(entry);
    }
    // A move can carry in an older send of another scope of this name (sent to every run, or to
    // this task) under one this listener already has: the newer one still applies, so skip it.
    const newestHad = Math.max(-1, ...renumbered.map((e) => e.seq));
    const fresh = due.filter((e) => e.seq > newestHad).sort((a, b) => a.seq - b.seq);
    const onError = (error: unknown) => {
      if (this.debug) console.error("[SignalsManager] Handler error:", error);
    };
    for (const entry of fresh) {
      // A handler can stop its own listener while handling an earlier entry.
      if (!this.#listeners.has(listener)) return;
      try {
        // Typed `void`, but an async handler's rejection would otherwise fail the run.
        const result: unknown = listener.handler({
          name: entry.name,
          payload: entry.payload,
          ...(entry.task !== undefined ? { task: entry.task } : {}),
          sentAt: new Date(entry.sentAt),
          seq: entry.seq,
        });
        if (result instanceof Promise) result.catch(onError);
      } catch (error) {
        onError(error);
      }
    }
  }

  /** Whether `on()` opens a subscription. The test manager feeds records itself. */
  protected subscribes(): boolean {
    return true;
  }

  #ensureTail(): void {
    if (this.#tail || !this.subscribes()) return;
    const abort = new AbortController();
    this.#tail = abort;
    void this.#runTail(abort.signal);
  }

  #stopTail(): void {
    this.#tail?.abort();
    this.#tail = undefined;
  }

  async #runTail(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const stream = await this.apiClient.subscribeToEnvironmentSignals({
          signal,
          baseUrl: this.baseUrl,
          timeoutInSeconds: 600,
          lastEventId: this.#lastSeq !== undefined ? String(this.#lastSeq) : undefined,
          nonRetryableStatuses: PERMANENT_SUBSCRIPTION_STATUSES,
          onPart: (part) => {
            if (signal.aborted) return;
            const seq = Number.parseInt(part.id, 10);
            if (!Number.isFinite(seq)) return;
            failures = 0;
            this.applyRecord(part.chunk, seq);
          },
        });
        for await (const _ of stream) {
          if (signal.aborted) break;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (
          error instanceof ApiError &&
          error.status !== undefined &&
          PERMANENT_SUBSCRIPTION_STATUSES.includes(error.status)
        ) {
          if (this.debug) console.error("[SignalsManager] Subscription stopped:", error);
          return;
        }
        failures++;
        if (this.debug) console.error("[SignalsManager] Subscription error:", error);
      }
      if (signal.aborted) return;
      // S2's long poll ended normally: reconnect at once. After a failure, back off.
      if (failures > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, computeReconnectDelayMs(failures - 1));
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        });
      }
    }
  }
}
