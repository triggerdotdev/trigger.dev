import { type ChangeRecord } from "./runChangeNotifier.server";
import { type RealtimeRunRow, serializeRunRow } from "./electricStreamProtocol.server";
import { logger } from "~/services/logger.server";

/**
 * EnvChangeRouter — the per-instance routing layer that turns "feeds as predicates over
 * one env stream" into cheap fan-out.
 *
 * It owns ONE subscription per environment (over the RunChangeNotifier) and an inverted
 * index of the feeds currently held by THIS instance: `runId -> feeds`, `tag -> feeds`,
 * `batchId -> feeds`. On a coalesced batch of ChangeRecords it:
 *   1. routes each record to only the matching held feeds via the index (O(record-tags),
 *      not O(feeds)) — a record that matches nothing costs nothing;
 *   2. batch-hydrates the matched runs from Postgres ONCE per column set (collapsing the
 *      hot-shared-tag fan-out: one run matching N feeds = one `hydrateByIds`, not N);
 *   3. serializes each row's wire value ONCE per column set, reused across all matching
 *      feeds;
 *   4. resolves each matching feed's pending wait with its hydrated+serialized rows.
 *
 * It is stateless across reconnects: the index is rebuilt from whatever feeds this
 * instance happens to hold, so no shape affinity or cross-poll memory is required. The
 * per-handle working-set diff (insert vs update) stays in the consumer; the router only
 * decides membership, hydrates, and serializes.
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
};

/** Handle a feed holds for the duration of one long-poll. */
export type FeedRegistration = {
  /** Wait for the next batch matching this feed (or timeout/abort), with the matched runs
   * hydrated + serialized for this feed's columns. One wait active at a time. */
  waitForMatch(signal: AbortSignal | undefined, timeoutMs: number): Promise<WaitResult>;
  /** Deregister from the index; unsubscribes the env when the last feed leaves. */
  close(): void;
};

type Feed = {
  filter: FeedFilter;
  skipColumns: string[];
  columnSig: string;
  /** The currently-waiting poll's resolver (null between polls). */
  resolve: ((result: WaitResult) => void) | null;
};

type EnvState = {
  unsubscribe: () => void;
  feeds: Set<Feed>;
  byRunId: Map<string, Set<Feed>>;
  byTag: Map<string, Set<Feed>>;
  byBatchId: Map<string, Set<Feed>>;
  /** All tag feeds, for routing partial records (no tags) as hydrate-to-classify candidates. */
  tagFeeds: Set<Feed>;
};

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

  register(environmentId: string, filter: FeedFilter, skipColumns: string[]): FeedRegistration {
    const env = this.#ensureEnv(environmentId);
    const feed: Feed = {
      filter,
      skipColumns,
      columnSig: skipColumns.length > 0 ? [...skipColumns].sort().join(",") : "",
      resolve: null,
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
        this.#envs.delete(environmentId);
        env.unsubscribe();
      }
    };

    return { waitForMatch, close };
  }

  /** Distinct environments currently routed (for metrics). */
  get activeEnvCount(): number {
    return this.#envs.size;
  }

  #ensureEnv(environmentId: string): EnvState {
    const existing = this.#envs.get(environmentId);
    if (existing) {
      return existing;
    }
    const env: EnvState = {
      unsubscribe: () => {},
      feeds: new Set(),
      byRunId: new Map(),
      byTag: new Map(),
      byBatchId: new Map(),
      tagFeeds: new Set(),
    };
    this.#envs.set(environmentId, env);
    env.unsubscribe = this.options.source.subscribeToEnv(environmentId, (records) => {
      // Fire-and-forget; the notifier doesn't await us. A hydrate failure must be caught
      // here (an unhandled rejection exits the process); the matched feeds' waiters stay
      // armed and time out into the full-resolve backstop.
      this.#onBatch(environmentId, env, records).catch((error) => {
        logger.error("[envChangeRouter] failed to route a change batch", {
          environmentId,
          error,
        });
      });
    });
    return env;
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
        for (const tag of feed.filter.tags) {
          removeFromIndex(env.byTag, tag, feed);
        }
        break;
    }
  }

  async #onBatch(environmentId: string, env: EnvState, records: ChangeRecord[]) {
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

  /** Authoritative re-check for tag feeds: the hydrated row's tags intersect the filter
   * and its createdAt is within the feed's window. Handles partial-record candidates and
   * guards record/row tag skew. */
  #tagRowMatches(row: RealtimeRunRow, filter: Extract<FeedFilter, { kind: "tag" }>): boolean {
    if (filter.createdAtFloorMs !== undefined && row.createdAt.getTime() < filter.createdAtFloorMs) {
      return false;
    }
    const rowTags = row.runTags ?? [];
    return filter.tags.some((tag) => rowTags.includes(tag));
  }
}
