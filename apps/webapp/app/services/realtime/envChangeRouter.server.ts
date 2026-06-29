import { type ChangeRecord } from "./runChangeNotifier.server";
import { type RealtimeRunRow, serializeRunRow } from "./electricStreamProtocol.server";
import { logger } from "~/services/logger.server";

/**
 * EnvChangeRouter — per-instance routing layer that fans one env's change stream out to the feeds it
 * matches. Owns one subscription per env (over the RunChangeNotifier) plus an inverted index of held
 * feeds, then per batch: routes via the index, batch-hydrates matched runs once per column set,
 * serializes each row's wire value once, and resolves each matched feed's pending wait. Stateless across reconnects.
 */

export type WakeReason = "notify" | "timeout" | "abort";

/** A feed's membership predicate over the env stream. */
export type FeedFilter =
  | { kind: "run"; runId: string }
  | { kind: "tag"; tags: string[]; createdAtFloorMs?: number }
  | { kind: "batch"; batchId: string };

/** A matched run handed to a feed: the hydrated row (for the feed's working-set diff) and
 * its wire `value` serialized once for this feed's column set (shared across feeds). */
export type MatchedRow = { row: RealtimeRunRow; value: Record<string, string | null> };

export type WaitResult = { reason: WakeReason; rows: MatchedRow[] };

/** Minimal deps so the router is unit-testable without Redis/Postgres. */
export interface EnvChangeSource {
  subscribeToEnv(environmentId: string, onBatch: (records: ChangeRecord[]) => void): () => void;
}
export interface RowHydrator {
  hydrateByIds(
    environmentId: string,
    ids: string[],
    skipColumns: string[]
  ): Promise<RealtimeRunRow[]>;
}

export type EnvChangeRouterOptions = {
  source: EnvChangeSource;
  hydrator: RowHydrator;
  /** Observability: a hydrate-by-id batch ran (count = runs hydrated this tick). */
  onHydrate?: (runCount: number) => void;
  /** How far back (ms) a newly-armed feed replays buffered records. 0 disables replay. */
  replayWindowMs?: number;
  /** Cap on buffered recent records per env (latest record per run). */
  replayMaxRunsPerEnv?: number;
  /** How long (ms) to keep an env subscribed + buffering after its last feed closes. 0 disables. */
  unsubscribeLingerMs?: number;
  /** Observability: a replay scan found candidates and delivered rows (or none survived). */
  onReplay?: (result: "delivered" | "empty") => void;
  /** Observability: a buffered record was evicted. `cap` evictions mean the env churns more
   * runs inside the window than the buffer holds (the replay guarantee is degrading). */
  onReplayEviction?: (reason: "cap" | "window") => void;
  /** Read-your-writes gate over the replica: delays wake-path hydrates until the replica
   * should have applied the change (record.updatedAtMs + lag + margin), and re-hydrates
   * rows the tripwire still finds stale. Omit to hydrate immediately (legacy behavior). */
  replicaLag?: ReplicaLagGate;
};

export type ReplicaLagGate = {
  /** Current replica-lag estimate (ms). */
  getLagMs(): number;
  /** Feedback: a hydrate provably read at least this far behind the primary. */
  noteObservedLagMs(lagMs: number): void;
  /** Safety margin added on top of the estimate (clock skew + scheduling). */
  marginMs: number;
  /** Hard cap on any single gate delay — a sick replica degrades freshness, never liveness. */
  maxDelayMs: number;
  /** Re-hydrate attempts for rows that still read stale after the delay. */
  staleRetries: number;
  /** Observability: stale rows recovered by a retry, or delivered stale after exhausting them. */
  onStaleHydrate?: (outcome: "recovered" | "gave_up", runCount: number) => void;
};

const DEFAULT_REPLAY_WINDOW_MS = 2_000;
const DEFAULT_REPLAY_MAX_RUNS_PER_ENV = 512;
const DEFAULT_UNSUBSCRIBE_LINGER_MS = 5_000;

/** Handle a feed holds for the duration of one long-poll. */
export type FeedRegistration = {
  /** Wait for the next batch matching this feed (or timeout/abort), with the matched runs
   * hydrated + serialized for this feed's columns. One wait active at a time. */
  waitForMatch(signal: AbortSignal | undefined, timeoutMs: number): Promise<WaitResult>;
  /** Deregister from the index; unsubscribes the env when the last feed leaves. */
  close(): void;
  /** False when this instance's env subscription is younger than the replay window, so a
   * change in the caller's inter-poll gap may have been missed (hop/cold start) — the
   * caller should resolve once instead of holding blind. */
  gapCovered: boolean;
};

type Feed = {
  filter: FeedFilter;
  skipColumns: string[];
  columnSig: string;
  /** The currently-waiting poll's resolver (null between polls). */
  resolve: ((result: WaitResult) => void) | null;
  /** Buffered records at or before this timestamp have been replayed (or predate this feed). */
  replayCursorMs: number;
};

type EnvState = {
  unsubscribe: () => void;
  feeds: Set<Feed>;
  byRunId: Map<string, Set<Feed>>;
  byTag: Map<string, Set<Feed>>;
  byBatchId: Map<string, Set<Feed>>;
  /** All tag feeds, for routing partial records (no tags) as hydrate-to-classify candidates. */
  tagFeeds: Set<Feed>;
  /** Tag feeds with no tag filter — they match every record but are unreachable via byTag. */
  unfilteredTagFeeds: Set<Feed>;
  /** When this env's channel subscription started (for the gap-coverage check). */
  subscribedAtMs: number;
  /** Latest record per run, insertion-ordered, for replaying inter-poll gaps to newly-armed feeds. */
  recent: Map<string, { record: ChangeRecord; receivedAtMs: number }>;
  /** Pending teardown while the env lingers with zero feeds. */
  lingerTimer?: ReturnType<typeof setTimeout>;
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function addToIndex(index: Map<string, Set<Feed>>, key: string, feed: Feed) {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(feed);
}

function removeFromIndex(index: Map<string, Set<Feed>>, key: string, feed: Feed) {
  const set = index.get(key);
  if (set) {
    set.delete(feed);
    if (set.size === 0) {
      index.delete(key);
    }
  }
}

export class EnvChangeRouter {
  readonly #envs = new Map<string, EnvState>();

  constructor(private readonly options: EnvChangeRouterOptions) {}

  register(
    environmentId: string,
    filter: FeedFilter,
    skipColumns: string[],
    opts?: {
      /** When the caller last received data for this connection. Bounds the replay to the
       * true inter-poll gap; older than the window can't be proven covered. */
      replaySinceMs?: number;
    }
  ): FeedRegistration {
    const env = this.#ensureEnv(environmentId);
    const replayWindowMs = this.options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    const now = Date.now();
    const windowFloorMs = now - replayWindowMs;
    const sinceMs = opts?.replaySinceMs ?? windowFloorMs;
    const feed: Feed = {
      filter,
      skipColumns,
      columnSig: skipColumns.length > 0 ? [...skipColumns].sort().join(",") : "",
      resolve: null,
      // First arm replays the caller's inter-poll gap; later arms only what arrived since.
      // The buffer only spans the window, so never rewind past it.
      replayCursorMs: Math.max(sinceMs, windowFloorMs),
    };

    env.feeds.add(feed);
    this.#indexFeed(env, feed);

    const waitForMatch = (signal: AbortSignal | undefined, timeoutMs: number) =>
      new Promise<WaitResult>((resolve) => {
        if (signal?.aborted) {
          resolve({ reason: "abort", rows: [] });
          return;
        }
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const settle = (result: WaitResult) => {
          if (settled) return;
          settled = true;
          feed.resolve = null;
          if (timer) clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        feed.resolve = settle;
        timer = setTimeout(() => settle({ reason: "timeout", rows: [] }), timeoutMs);
        timer.unref?.();
        if (signal) {
          onAbort = () => settle({ reason: "abort", rows: [] });
          signal.addEventListener("abort", onAbort, { once: true });
        }
        // Deliver any buffered records this feed hasn't seen (catches changes that
        // landed while the caller was between polls).
        if (replayWindowMs > 0 && env.recent.size > 0) {
          this.#replayRecent(environmentId, env, feed).catch((error) => {
            logger.error("[envChangeRouter] failed to replay buffered records", {
              environmentId,
              error,
            });
          });
        }
      });

    const close = () => {
      if (!env.feeds.has(feed)) {
        return;
      }
      env.feeds.delete(feed);
      this.#deindexFeed(env, feed);
      // Resolve any in-flight wait so the poll doesn't hang.
      feed.resolve?.({ reason: "abort", rows: [] });
      feed.resolve = null;
      if (env.feeds.size === 0) {
        this.#scheduleEnvTeardown(environmentId, env);
      }
    };

    return {
      waitForMatch,
      close,
      // Covered when this instance was already subscribed (and buffering) at the gap's
      // start, and the gap fits inside the buffer's window.
      gapCovered:
        replayWindowMs <= 0 || (env.subscribedAtMs <= sinceMs && sinceMs >= windowFloorMs),
    };
  }

  /** Distinct environments currently routed (for metrics). */
  get activeEnvCount(): number {
    return this.#envs.size;
  }

  /** Currently-held feeds by kind (for metrics) — the system's capacity unit. */
  get heldFeedCounts(): { run: number; tag: number; batch: number } {
    const counts = { run: 0, tag: 0, batch: 0 };
    for (const env of this.#envs.values()) {
      for (const feed of env.feeds) {
        counts[feed.filter.kind]++;
      }
    }
    return counts;
  }

  #ensureEnv(environmentId: string): EnvState {
    const existing = this.#envs.get(environmentId);
    if (existing) {
      // A pending teardown is cancelled by new interest; the buffer survives the gap.
      if (existing.lingerTimer) {
        clearTimeout(existing.lingerTimer);
        existing.lingerTimer = undefined;
      }
      return existing;
    }
    const env: EnvState = {
      unsubscribe: () => {},
      feeds: new Set(),
      byRunId: new Map(),
      byTag: new Map(),
      byBatchId: new Map(),
      tagFeeds: new Set(),
      unfilteredTagFeeds: new Set(),
      subscribedAtMs: Date.now(),
      recent: new Map(),
    };
    this.#envs.set(environmentId, env);
    env.unsubscribe = this.options.source.subscribeToEnv(environmentId, (records) => {
      this.#bufferRecent(env, records);
      // Fire-and-forget; catch hydrate failures here (unhandled rejection exits the process) — waiters time out into the backstop.
      this.#onBatch(environmentId, env, records).catch((error) => {
        logger.error("[envChangeRouter] failed to route a change batch", {
          environmentId,
          error,
        });
      });
    });
    return env;
  }

  /** Keep the env subscribed + buffering for a linger after its last feed closes, so a
   * client's next poll (or another instance hop landing back here) can replay the gap. */
  #scheduleEnvTeardown(environmentId: string, env: EnvState) {
    const lingerMs = this.options.unsubscribeLingerMs ?? DEFAULT_UNSUBSCRIBE_LINGER_MS;
    if (lingerMs <= 0) {
      this.#envs.delete(environmentId);
      env.unsubscribe();
      return;
    }
    if (env.lingerTimer) {
      clearTimeout(env.lingerTimer);
    }
    env.lingerTimer = setTimeout(() => {
      if (env.feeds.size === 0) {
        this.#envs.delete(environmentId);
        env.unsubscribe();
      }
    }, lingerMs);
    env.lingerTimer.unref?.();
  }

  /** Upsert the latest record per run (insertion-ordered) and prune to the window + cap. */
  #bufferRecent(env: EnvState, records: ChangeRecord[]) {
    const windowMs = this.options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    if (windowMs <= 0) {
      return;
    }
    const maxRuns = this.options.replayMaxRunsPerEnv ?? DEFAULT_REPLAY_MAX_RUNS_PER_ENV;
    const now = Date.now();
    for (const record of records) {
      env.recent.delete(record.runId);
      env.recent.set(record.runId, { record, receivedAtMs: now });
    }
    const cutoff = now - windowMs;
    for (const [runId, entry] of env.recent) {
      if (entry.receivedAtMs >= cutoff && env.recent.size <= maxRuns) {
        break;
      }
      this.options.onReplayEviction?.(entry.receivedAtMs < cutoff ? "window" : "cap");
      env.recent.delete(runId);
    }
  }

  /** Whether a buffered record matches a feed's predicate (mirrors #onBatch's routing). */
  #recordMatchesFeed(record: ChangeRecord, feed: Feed): boolean {
    switch (feed.filter.kind) {
      case "run":
        return record.runId === feed.filter.runId;
      case "batch":
        return record.batchId != null && record.batchId === feed.filter.batchId;
      case "tag": {
        const tags = feed.filter.tags;
        // Unfiltered feed matches everything; partial record (no tags) = hydrate-to-classify.
        if (tags.length === 0 || record.tags === undefined) {
          return true;
        }
        return record.tags.some((tag) => tags.includes(tag));
      }
    }
  }

  /** How long to wait before hydrating so the replica has applied every change in the
   * batch: each record is safe at updatedAtMs + lag + margin (records without a watermark
   * anchor at now, degrading to a plain lag-sized delay). Capped — see ReplicaLagGate. */
  #gateDelayMs(records: ChangeRecord[]): number {
    const gate = this.options.replicaLag;
    if (!gate || records.length === 0) {
      return 0;
    }
    const now = Date.now();
    const lagMs = gate.getLagMs();
    let safeAtMs = 0;
    for (const record of records) {
      const anchorMs = record.updatedAtMs ?? now;
      safeAtMs = Math.max(safeAtMs, anchorMs + lagMs + gate.marginMs);
    }
    return Math.max(0, Math.min(safeAtMs - now, gate.maxDelayMs));
  }

  /** Deliver buffered records newer than the feed's cursor through the normal
   * hydrate -> serialize -> settle pipeline. Already-seen rows diff to nothing downstream. */
  async #replayRecent(environmentId: string, env: EnvState, feed: Feed) {
    const cursor = feed.replayCursorMs;
    feed.replayCursorMs = Date.now();

    const runIds: string[] = [];
    const candidateRecords: ChangeRecord[] = [];
    for (const [runId, entry] of env.recent) {
      if (entry.receivedAtMs > cursor && this.#recordMatchesFeed(entry.record, feed)) {
        runIds.push(runId);
        candidateRecords.push(entry.record);
      }
    }
    if (runIds.length === 0 || !feed.resolve) {
      return;
    }

    // Replayed records are usually past the lag window already (delay computes to 0); a
    // just-buffered one gets the same read-your-writes gate as the live path. No tripwire
    // here — a stale replay diffs to a re-emission on the next wake or backstop.
    const replayDelayMs = this.#gateDelayMs(candidateRecords);
    if (replayDelayMs > 0) {
      await sleepMs(replayDelayMs);
      if (!feed.resolve) {
        return;
      }
    }

    const hydrated = await this.options.hydrator.hydrateByIds(
      environmentId,
      runIds,
      feed.skipColumns
    );
    this.options.onHydrate?.(hydrated.length);

    const rows: MatchedRow[] = [];
    for (const row of hydrated) {
      if (feed.filter.kind === "tag" && !this.#tagRowMatches(row, feed.filter)) {
        continue;
      }
      rows.push({ row, value: serializeRunRow(row, feed.skipColumns) });
    }

    if (rows.length > 0 && feed.resolve) {
      this.options.onReplay?.("delivered");
      feed.resolve({ reason: "notify", rows });
    } else {
      this.options.onReplay?.("empty");
    }
  }

  #indexFeed(env: EnvState, feed: Feed) {
    switch (feed.filter.kind) {
      case "run":
        addToIndex(env.byRunId, feed.filter.runId, feed);
        break;
      case "batch":
        addToIndex(env.byBatchId, feed.filter.batchId, feed);
        break;
      case "tag":
        env.tagFeeds.add(feed);
        if (feed.filter.tags.length === 0) {
          env.unfilteredTagFeeds.add(feed);
        }
        for (const tag of feed.filter.tags) {
          addToIndex(env.byTag, tag, feed);
        }
        break;
    }
  }

  #deindexFeed(env: EnvState, feed: Feed) {
    switch (feed.filter.kind) {
      case "run":
        removeFromIndex(env.byRunId, feed.filter.runId, feed);
        break;
      case "batch":
        removeFromIndex(env.byBatchId, feed.filter.batchId, feed);
        break;
      case "tag":
        env.tagFeeds.delete(feed);
        env.unfilteredTagFeeds.delete(feed);
        for (const tag of feed.filter.tags) {
          removeFromIndex(env.byTag, tag, feed);
        }
        break;
    }
  }

  async #onBatch(environmentId: string, env: EnvState, records: ChangeRecord[], attempt = 0) {
    // 0. Read-your-writes gate: wait out the replica's apply lag before hydrating, so the
    //    rows we read contain the changes the records announce. Retry attempts were
    //    scheduled with their own delay, so only the first pass gates here.
    if (attempt === 0) {
      const delayMs = this.#gateDelayMs(records);
      if (delayMs > 0) {
        await sleepMs(delayMs);
      }
    }

    // 1. Route each record to the held feeds it matches; collect matched runIds per feed.
    const matchedRunIdsByFeed = new Map<Feed, Set<string>>();
    const addMatch = (feed: Feed, runId: string) => {
      if (!feed.resolve) {
        // Feed isn't currently waiting (between polls). Drop — its backstop catches gaps.
        return;
      }
      let set = matchedRunIdsByFeed.get(feed);
      if (!set) {
        set = new Set();
        matchedRunIdsByFeed.set(feed, set);
      }
      set.add(runId);
    };

    for (const record of records) {
      // run feeds: exact runId match.
      const runFeeds = env.byRunId.get(record.runId);
      if (runFeeds) {
        for (const feed of runFeeds) addMatch(feed, record.runId);
      }

      // batch feeds: exact batchId match (only when the record carries one).
      if (record.batchId) {
        const batchFeeds = env.byBatchId.get(record.batchId);
        if (batchFeeds) {
          for (const feed of batchFeeds) addMatch(feed, record.runId);
        }
      }

      // tag feeds.
      if (record.tags !== undefined) {
        // Full record: prune via the tag index; only feeds whose filter intersects match.
        const seen = new Set<Feed>();
        for (const tag of record.tags) {
          const tagFeeds = env.byTag.get(tag);
          if (!tagFeeds) continue;
          for (const feed of tagFeeds) {
            if (seen.has(feed)) continue;
            seen.add(feed);
            addMatch(feed, record.runId);
          }
        }
        // Unfiltered tag feeds match every record but live outside the index.
        for (const feed of env.unfilteredTagFeeds) addMatch(feed, record.runId);
      } else {
        // Partial record (no membership data): route to every tag feed as a candidate to
        // hydrate-and-classify (rare; the publish side emits full records in practice).
        for (const feed of env.tagFeeds) addMatch(feed, record.runId);
      }
    }

    if (matchedRunIdsByFeed.size === 0) {
      return;
    }

    // 2. Batch-hydrate ONCE per column set, then 3. serialize ONCE per (runId, column set).
    const runIdsByColumnSig = new Map<string, { skipColumns: string[]; runIds: Set<string> }>();
    for (const [feed, runIds] of matchedRunIdsByFeed) {
      let group = runIdsByColumnSig.get(feed.columnSig);
      if (!group) {
        group = { skipColumns: feed.skipColumns, runIds: new Set() };
        runIdsByColumnSig.set(feed.columnSig, group);
      }
      for (const id of runIds) group.runIds.add(id);
    }

    const hydratedByColumnSig = new Map<string, Map<string, MatchedRow>>();
    await Promise.all(
      [...runIdsByColumnSig.entries()].map(async ([columnSig, group]) => {
        const ids = [...group.runIds];
        const rows = await this.options.hydrator.hydrateByIds(
          environmentId,
          ids,
          group.skipColumns
        );
        this.options.onHydrate?.(rows.length);
        const map = new Map<string, MatchedRow>();
        for (const row of rows) {
          map.set(row.id, { row, value: serializeRunRow(row, group.skipColumns) });
        }
        hydratedByColumnSig.set(columnSig, map);
      })
    );

    // 3.5 Stale tripwire: a watermarked record whose hydrated row is older (or missing —
    //     the insert race) read a replica that hadn't applied the change. Withhold those
    //     rows and re-hydrate shortly. Exhausting the retry budget delivers what we have
    //     (liveness over freshness) — but a stale emission advances the feed's cursor, so
    //     it ALSO schedules echo passes past the gate: re-hydrates flowing through normal
    //     emission, where the working-set diff drops unchanged rows and emits the fresh
    //     version once the replica catches up. The backstop stays the terminal net.
    //     Each detection feeds the lag estimator.
    const gate = this.options.replicaLag;
    const isEchoPass = gate !== undefined && attempt > gate.staleRetries;
    const staleRunIds = gate
      ? this.#detectStaleRuns(records, runIdsByColumnSig, hydratedByColumnSig)
      : new Set<string>();
    if (attempt > 0 && !isEchoPass) {
      const recovered = new Set(records.map((r) => r.runId)).size - staleRunIds.size;
      if (recovered > 0) {
        gate?.onStaleHydrate?.("recovered", recovered);
      }
    }
    if (staleRunIds.size > 0 && gate) {
      const staleRecords = records.filter((record) => staleRunIds.has(record.runId));
      // Re-buffer the withheld records so a feed that re-arms between now and the next
      // pass replays them instead of waiting for its backstop.
      this.#bufferRecent(env, staleRecords);
      if (attempt >= gate.staleRetries) {
        // Budget exhausted: deliver the stale rows below (liveness) — but a stale emission
        // advances the feed's cursor, so keep echoing re-hydrates through normal emission
        // (the working-set diff drops unchanged rows, emits the fresh version when the
        // replica catches up). Echoes stop once the change ages past the horizon; deeper
        // outages are the backstop's job.
        if (attempt === gate.staleRetries) {
          gate.onStaleHydrate?.("gave_up", staleRunIds.size);
        }
        staleRunIds.clear();
      }
      const echoHorizonMs = gate.maxDelayMs * 10;
      const newestWatermarkMs = Math.max(...staleRecords.map((record) => record.updatedAtMs ?? 0));
      const withinEchoHorizon = Date.now() - newestWatermarkMs < echoHorizonMs;
      if (attempt < gate.staleRetries || withinEchoHorizon) {
        const retryDelayMs = Math.max(
          25,
          Math.min(gate.getLagMs() + gate.marginMs, gate.maxDelayMs)
        );
        const timer = setTimeout(() => {
          this.#onBatch(environmentId, env, staleRecords, attempt + 1).catch((error) => {
            logger.error("[envChangeRouter] failed to re-hydrate stale rows", {
              environmentId,
              error,
            });
          });
        }, retryDelayMs);
        timer.unref?.();
      }
    }

    // 4. Assemble each feed's matched rows (post-filtering tag feeds against the
    //    authoritative hydrated row) and resolve its pending wait.
    for (const [feed, runIds] of matchedRunIdsByFeed) {
      if (!feed.resolve) {
        continue; // stopped waiting while we hydrated; its next poll/backstop covers it
      }
      const hydrated = hydratedByColumnSig.get(feed.columnSig);
      if (!hydrated) continue;

      const rows: MatchedRow[] = [];
      for (const runId of runIds) {
        if (staleRunIds.has(runId)) {
          continue; // withheld; the scheduled re-hydrate delivers the fresh version
        }
        const matched = hydrated.get(runId);
        if (!matched) continue; // run not found / left the table
        if (feed.filter.kind === "tag" && !this.#tagRowMatches(matched.row, feed.filter)) {
          continue; // re-confirm tags + createdAt floor against the authoritative row
        }
        rows.push(matched);
      }

      if (rows.length > 0) {
        feed.resolve({ reason: "notify", rows });
      }
      // No surviving rows (e.g. a partial-record candidate that didn't actually match):
      // leave the feed waiting; nothing relevant changed for it.
    }
  }

  /** Runs whose hydrated row is provably behind its record's watermark (stale content),
   * or absent entirely despite a watermark (the insert hasn't applied). Records without
   * `updatedAtMs` can't be judged and always pass. */
  #detectStaleRuns(
    records: ChangeRecord[],
    runIdsByColumnSig: Map<string, { skipColumns: string[]; runIds: Set<string> }>,
    hydratedByColumnSig: Map<string, Map<string, MatchedRow>>
  ): Set<string> {
    const gate = this.options.replicaLag;
    const stale = new Set<string>();
    if (!gate) {
      return stale;
    }
    const expectedByRunId = new Map<string, number>();
    for (const record of records) {
      if (record.updatedAtMs !== undefined) {
        const existing = expectedByRunId.get(record.runId);
        if (existing === undefined || record.updatedAtMs > existing) {
          expectedByRunId.set(record.runId, record.updatedAtMs);
        }
      }
    }
    if (expectedByRunId.size === 0) {
      return stale;
    }
    const now = Date.now();
    for (const [columnSig, group] of runIdsByColumnSig) {
      const hydrated = hydratedByColumnSig.get(columnSig);
      for (const runId of group.runIds) {
        const expected = expectedByRunId.get(runId);
        if (expected === undefined || stale.has(runId)) {
          continue;
        }
        const matched = hydrated?.get(runId);
        if (!matched || matched.row.updatedAt.getTime() < expected) {
          stale.add(runId);
          gate.noteObservedLagMs(now - expected);
        }
      }
    }
    return stale;
  }

  /** Authoritative re-check for tag feeds: the hydrated row carries ALL the filter's tags
   * (Electric's `runTags @> ARRAY[...]` semantics) and its createdAt is within the window. */
  #tagRowMatches(row: RealtimeRunRow, filter: Extract<FeedFilter, { kind: "tag" }>): boolean {
    if (
      filter.createdAtFloorMs !== undefined &&
      row.createdAt.getTime() < filter.createdAtFloorMs
    ) {
      return false;
    }
    const rowTags = row.runTags ?? [];
    return filter.tags.every((tag) => rowTags.includes(tag));
  }
}
