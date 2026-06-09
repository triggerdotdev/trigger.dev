import { json } from "@remix-run/server-runtime";
import { safeParseNaturalLanguageDurationAgo } from "@trigger.dev/core/v3/isomorphic";
import { randomUUID } from "node:crypto";
import { API_VERSIONS, CURRENT_API_VERSION } from "~/api/versions";
import {
  type CachedLimitProvider,
  type RealtimeEnvironment,
  type RealtimeRequestOptions,
  type RealtimeRunsParams,
} from "../realtimeClient.server";
import { logger } from "../logger.server";
import {
  buildElectricSchemaHeader,
  buildRowsBody,
  buildRowsBodyFromSerialized,
  buildSnapshotBody,
  buildUpdateBody,
  buildUpToDateBody,
  encodeOffset,
  INITIAL_OFFSET,
  parseOffsetUpdatedAtMs,
  type RealtimeRunRow,
  rewriteBodyForLegacyApiVersion,
  RESERVED_COLUMNS,
  type RowChange,
  type SerializedRowChange,
} from "./electricStreamProtocol.server";
import { BoundedTtlCache } from "./boundedTtlCache";
import {
  type EnvChangeRouter,
  type FeedFilter,
  type MatchedRow,
} from "./envChangeRouter.server";
import { type RunHydrator, type RunListResolver } from "./runReader.server";
import { type RealtimeConcurrencyLimiter } from "./realtimeConcurrencyLimiter.server";

/** The tag-list feed resolves ids via ClickHouse, which needs org + project + env.
 * `authentication.environment` (AuthenticatedEnvironment) provides projectId, so
 * widening here avoids touching the Electric client's RealtimeEnvironment type. */
export type RealtimeListEnvironment = RealtimeEnvironment & { projectId: string };

/** The realtime feeds the run routes depend on (single-run, tag-list, batch). Both
 * the Electric client and this notifier client satisfy it, so the routes can switch
 * between them behind a flag. */
export interface RealtimeStreamClient {
  streamRun(
    url: URL | string,
    environment: RealtimeEnvironment,
    runId: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response>;
  streamRuns(
    url: URL | string,
    environment: RealtimeListEnvironment,
    params: RealtimeRunsParams,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response>;
  streamBatch(
    url: URL | string,
    environment: RealtimeListEnvironment,
    batchId: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response>;
}

export type WakeupReason = "notify" | "timeout" | "abort";

/** How a live poll resolved, for observability:
 *  - `fast-hydrate`: the router woke this feed with matched rows (hydrated by id, NO
 *    ClickHouse). Non-matching changes never wake the feed, so they cost nothing.
 *  - `full-resolve`: the backstop timeout did a ClickHouse resolve (the correctness net). */
export type LivePollPath = "fast-hydrate" | "full-resolve";

export type NotifierRealtimeClientOptions = {
  runReader: RunHydrator;
  /** Resolves the tag/list filter into the matching id-set (filter-only). */
  runListResolver: RunListResolver;
  /** Per-instance routing layer over the single env change channel. */
  router: EnvChangeRouter;
  limiter: RealtimeConcurrencyLimiter;
  cachedLimitProvider: CachedLimitProvider;
  /** Backstop wait before refetching on a live request (ms). Defaults to 5000. */
  livePollTimeoutMs?: number;
  /** Ceiling for the tag-list createdAt lookback window (ms). */
  maximumCreatedAtFilterAgeMs: number;
  /** Hard cap on tag-list snapshot size. Defaults to 1000. */
  maxListResults?: number;
  /** TTL (ms) for the multi-run resolve+hydrate coalescing cache (initial + backstop). */
  runSetResolveCacheTtlMs?: number;
  /** Max entries in the resolve+hydrate cache. Defaults to 5000. */
  runSetResolveCacheMaxEntries?: number;
  /** Max entries in the per-handle working-set cache. Defaults to 10000. */
  listCacheMaxEntries?: number;
  /** Epoch-aligned bucket (ms) the tag-list createdAt lower bound is floored to, so
   * same-tag feeds pinned within the same bucket share a cache entry. Defaults to
   * 60000. 0 disables bucketing. */
  runSetCreatedAtBucketMs?: number;
  /** When true (default), a multi-run live poll holds the connection until a real delta
   * or the backstop, rather than returning an empty up-to-date the client would re-issue. */
  holdOnEmpty?: boolean;
  /** Max concurrent fresh ClickHouse resolves (cache misses) across this instance. Bounds a
   * distinct-filter reconnect stampede so it queues instead of hammering ClickHouse. Defaults
   * to 16; 0 disables the gate (unbounded). */
  resolveAdmissionLimit?: number;
  /** Observability hook: why a live request woke (notify vs timeout vs abort). */
  onWakeup?: (reason: WakeupReason) => void;
  /** Observability hook: how a live poll resolved (fast path vs full resolve). */
  onLivePollPath?: (path: LivePollPath) => void;
  /** Observability hook: whether a multi-run resolve (initial/backstop) hit the cache,
   * coalesced onto an in-flight resolve, or missed (fresh ClickHouse + Postgres). */
  onRunSetResolve?: (result: "hit" | "miss" | "coalesced") => void;
  /** Observability hook: latency (ms) of the ClickHouse resolve / Postgres hydrate. */
  onRunSetQuery?: (stage: "resolve" | "hydrate", ms: number) => void;
  /** Observability hook: a fresh resolve had to wait `ms` for an admission permit (the gate
   * engaged — i.e. a stampede was throttled). Not called when a permit is free. */
  onResolveAdmissionWait?: (ms: number) => void;
};

const DEFAULT_CONCURRENCY_LIMIT = 100_000;
// Matches Electric's ~20s live long-poll hold (jittered ±15% per request).
const DEFAULT_LIVE_POLL_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_LIST_RESULTS = 1_000;
const LIST_CACHE_TTL_MS = 5 * 60_000;
const LIST_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_RUNSET_CACHE_TTL_MS = 1_000;
const DEFAULT_RUNSET_CACHE_MAX_ENTRIES = 5_000;
const DEFAULT_RUNSET_CREATED_AT_BUCKET_MS = 60_000;
const DEFAULT_RESOLVE_ADMISSION_LIMIT = 16;

/**
 * Fair FIFO semaphore bounding how many fresh ClickHouse resolves run concurrently. It sits
 * BEHIND the single-flight + TTL cache, so only genuine cache-miss resolves take a permit: a
 * same-filter reconnect stampede still collapses to one in-flight resolve (one permit), while
 * a distinct-filter stampede — where every filter is a different cache key and so can't
 * coalesce — is throttled to `limit` concurrent CH queries instead of firing all N at the
 * database at once. Trades a little connect latency under a stampede for bounded CH load.
 */
class ResolveAdmissionGate {
  #available: number;
  #inUse = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#available = limit;
  }

  /** Permits currently held (for a metrics gauge); never exceeds the limit. */
  get inUse(): number {
    return this.#inUse;
  }

  async acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available--;
      this.#inUse++;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#inUse++;
  }

  release(): void {
    this.#inUse--;
    const next = this.#waiters.shift();
    if (next) {
      next(); // hand the freed permit straight to the next waiter (FIFO, no count churn)
    } else {
      this.#available++;
    }
  }
}

/** A multi-run feed's filter. Tag-list sets `tags` (+ pinned `createdAtAfter`);
 * the batch feed sets `batchId`. Both resolve to an id-set via the resolver. */
type RunSetFilter = {
  tags?: string[];
  batchId?: string;
  createdAtAfter?: Date;
};

/** Per-handle working set: runId -> last-emitted updatedAt (ms), so live polls
 * emit only rows that advanced. */
type WorkingSet = Map<string, number>;

type ResponseHeaderInput = {
  offset: string;
  handle: string;
  cursor?: string;
  schema?: string;
};

/**
 * Notifier-backed implementation of the realtime run feeds. All three feeds are
 * predicates over ONE per-environment change stream (the EnvChangeRouter); the router
 * decides membership, hydrates the matched runs from a read replica, and serializes their
 * wire values once. This client owns the snapshot, the per-handle working-set diff, the
 * ClickHouse-backed backstop, and the wire response.
 *
 * Single-run (`streamRun`):
 *  - initial (`offset=-1`): hydrate + emit `insert` + `up-to-date` (with schema).
 *  - live: the router wakes this feed when its run changes; emit a full-row `update` when
 *    `updatedAt` advanced past what the client has, else a bare `up-to-date`. The backstop
 *    re-checks via `getRunById`.
 *
 * Multi-run feeds (`streamRuns` tag-list, `streamBatch`):
 *  - initial: resolve the matching id-set via ClickHouse (filter-only), hydrate by-id from
 *    Postgres, emit N `insert`s, seed the working set.
 *  - live: the router wakes the feed with the matched runs already hydrated + serialized;
 *    diff them on the authoritative Postgres `updatedAt` against the per-handle working
 *    set and emit only new/advanced rows. The backstop (timeout) does a full ClickHouse
 *    resolve — the correctness net that catches gaps and drops departed runs.
 *
 * Tokens are opaque: `offset` = `<maxUpdatedAtMs>_<seq>`, `handle` is per-shape, `cursor`
 * is a live-only counter. The wire format is produced by `electricStreamProtocol`.
 */
export class NotifierRealtimeClient implements RealtimeStreamClient {
  #seq = 0;
  readonly #workingSetCache: BoundedTtlCache<WorkingSet>;
  /** Coalescing cache for the multi-run (resolveIds -> hydrateByIds) pair used by the
   * initial snapshot and the backstop, keyed by (env, filter, columns). Collapses a
   * reconnect/snapshot stampede of identical filters into one shared resolve+hydrate. */
  readonly #runSetCache: BoundedTtlCache<RealtimeRunRow[]>;
  readonly #runSetInflight = new Map<string, Promise<RealtimeRunRow[]>>();
  /** Bounds concurrent fresh CH resolves (undefined => unbounded). */
  readonly #admissionGate?: ResolveAdmissionGate;

  constructor(private readonly options: NotifierRealtimeClientOptions) {
    this.#workingSetCache = new BoundedTtlCache(
      LIST_CACHE_TTL_MS,
      options.listCacheMaxEntries ?? LIST_CACHE_MAX_ENTRIES
    );
    this.#runSetCache = new BoundedTtlCache(
      options.runSetResolveCacheTtlMs ?? DEFAULT_RUNSET_CACHE_TTL_MS,
      options.runSetResolveCacheMaxEntries ?? DEFAULT_RUNSET_CACHE_MAX_ENTRIES
    );
    const admissionLimit = options.resolveAdmissionLimit ?? DEFAULT_RESOLVE_ADMISSION_LIMIT;
    if (admissionLimit > 0) {
      this.#admissionGate = new ResolveAdmissionGate(admissionLimit);
    }
  }

  /** Current size of the per-handle working-set cache (for a metrics gauge). */
  get workingSetCacheSize(): number {
    return this.#workingSetCache.size;
  }

  /** Fresh CH resolves currently holding an admission permit (for a metrics gauge). */
  get resolveAdmissionInUse(): number {
    return this.#admissionGate?.inUse ?? 0;
  }

  async streamRun(
    url: URL | string,
    environment: RealtimeEnvironment,
    runId: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const { offset, handle, isLive, skipColumns } = this.#parseStreamRequest(url, requestOptions);

    // Initial snapshot — no prior offset/handle.
    if (offset === INITIAL_OFFSET || !handle) {
      const row = await this.options.runReader.getRunById(environment.id, runId);
      return this.#snapshotResponse(runId, row, skipColumns, apiVersion, clientVersion);
    }

    if (isLive) {
      return this.#liveResponse({
        environment,
        runId,
        offset,
        handle,
        skipColumns,
        apiVersion,
        clientVersion,
        signal,
      });
    }

    // Non-live catch-up with a handle: re-emit the current snapshot (idempotent).
    const row = await this.options.runReader.getRunById(environment.id, runId);
    return this.#snapshotResponse(runId, row, skipColumns, apiVersion, clientVersion, handle);
  }

  async streamRuns(
    url: URL | string,
    environment: RealtimeListEnvironment,
    params: RealtimeRunsParams,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const { offset, handle, isLive, skipColumns } = this.#parseStreamRequest(url, requestOptions);
    const tags = params.tags ?? [];

    // Initial snapshot — pin the createdAt window in a fresh handle.
    if (offset === INITIAL_OFFSET || !handle) {
      const createdAtFilterMs = this.#computeCreatedAtFilter(params.createdAt).getTime();
      return this.#runSetSnapshotResponse(
        environment,
        { tags, createdAtAfter: new Date(createdAtFilterMs) },
        this.#mintListHandle(createdAtFilterMs),
        skipColumns,
        apiVersion,
        clientVersion
      );
    }

    // Recover the pinned window from the handle so the lower bound never drifts.
    // Re-clamp the recovered value to the max-age floor so a stale or crafted handle
    // can't widen the lookback past the configured ceiling.
    const recoveredMs = this.#filterMsFromHandle(handle);
    const filter: RunSetFilter = {
      tags,
      createdAtAfter: new Date(
        recoveredMs !== undefined
          ? this.#clampCreatedAtFloor(recoveredMs)
          : this.#computeCreatedAtFilter(params.createdAt).getTime()
      ),
    };

    if (isLive) {
      return this.#runSetLiveResponse(
        environment,
        filter,
        handle,
        offset,
        skipColumns,
        apiVersion,
        clientVersion,
        signal
      );
    }

    // Non-live catch-up under the same handle.
    return this.#runSetSnapshotResponse(
      environment,
      filter,
      handle,
      skipColumns,
      apiVersion,
      clientVersion
    );
  }

  async streamBatch(
    url: URL | string,
    environment: RealtimeListEnvironment,
    batchId: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const { offset, handle, isLive, skipColumns } = this.#parseStreamRequest(url, requestOptions);

    const filter: RunSetFilter = { batchId };

    if (offset !== INITIAL_OFFSET && handle && isLive) {
      return this.#runSetLiveResponse(
        environment,
        filter,
        handle,
        offset,
        skipColumns,
        apiVersion,
        clientVersion,
        signal
      );
    }

    // Initial snapshot + non-live catch-up. The handle must be per-connection, never
    // derived from the batchId: working sets are keyed by handle, and a shared handle
    // lets one subscriber's emit permanently suppress the same row for another.
    return this.#runSetSnapshotResponse(
      environment,
      filter,
      handle ?? this.#mintBatchHandle(batchId),
      skipColumns,
      apiVersion,
      clientVersion
    );
  }

  #snapshotResponse(
    runId: string,
    row: Awaited<ReturnType<RunHydrator["getRunById"]>>,
    skipColumns: string[],
    apiVersion: API_VERSIONS,
    clientVersion?: string,
    existingHandle?: string
  ): Response {
    const body = buildSnapshotBody(row, skipColumns);
    const offset = row ? encodeOffset(row.updatedAt.getTime(), this.#nextSeq()) : encodeOffset(0, 0);
    return this.#buildResponse(body, apiVersion, clientVersion, {
      offset,
      handle: existingHandle ?? this.#mintHandle(runId),
      schema: buildElectricSchemaHeader(skipColumns),
    });
  }

  /**
   * Live poll for a single-run feed. The router wakes this feed when its run changes,
   * with the run already hydrated + serialized (no ClickHouse, ever). On the backstop
   * timeout it re-checks via `getRunById`. Only-on-advance: emit a full-row `update` when
   * the row moved past what the client already has; else a bare `up-to-date`.
   */
  async #liveResponse(params: {
    environment: RealtimeEnvironment;
    runId: string;
    offset: string;
    handle: string;
    skipColumns: string[];
    apiVersion: API_VERSIONS;
    clientVersion?: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const { environment, runId, offset, handle, skipColumns, apiVersion, clientVersion, signal } =
      params;

    return this.#withConcurrencySlot(environment, async () => {
      const lastSeenMs = parseOffsetUpdatedAtMs(offset);
      const registration = this.options.router.register(
        environment.id,
        { kind: "run", runId },
        skipColumns
      );

      try {
        const { reason, rows } = await registration.waitForMatch(signal, this.#jitteredTimeout());
        this.options.onWakeup?.(reason);

        if (reason === "abort") {
          return this.#buildResponse(buildUpToDateBody(), apiVersion, clientVersion, {
            offset,
            handle,
            cursor: String(this.#nextSeq()),
          });
        }

        if (reason === "notify" && rows.length > 0) {
          // The router hydrated + serialized this run; emit it (only on advance).
          this.options.onLivePollPath?.("fast-hydrate");
          const matched = rows[0];
          const updatedAtMs = matched.row.updatedAt.getTime();
          const seq = this.#nextSeq();
          if (updatedAtMs > lastSeenMs) {
            return this.#buildResponse(
              buildRowsBodyFromSerialized([
                { runId: matched.row.id, value: matched.value, operation: "update" },
              ]),
              apiVersion,
              clientVersion,
              { offset: encodeOffset(updatedAtMs, seq), handle, cursor: String(seq) }
            );
          }
          return this.#buildResponse(buildUpToDateBody(), apiVersion, clientVersion, {
            offset,
            handle,
            cursor: String(seq),
          });
        }

        // Backstop timeout: re-check the run directly (no ClickHouse for the single-run feed).
        this.options.onLivePollPath?.("full-resolve");
        const row = await this.options.runReader.getRunById(environment.id, runId);
        const seq = this.#nextSeq();
        if (row && row.updatedAt.getTime() > lastSeenMs) {
          return this.#buildResponse(buildUpdateBody(row, skipColumns), apiVersion, clientVersion, {
            offset: encodeOffset(row.updatedAt.getTime(), seq),
            handle,
            cursor: String(seq),
          });
        }
        return this.#buildResponse(buildUpToDateBody(), apiVersion, clientVersion, {
          offset,
          handle,
          cursor: String(seq),
        });
      } finally {
        registration.close();
      }
    });
  }

  /** Initial (and non-live catch-up) snapshot for a multi-run feed: resolve the
   * id-set, hydrate, emit every row as an `insert`, and seed the working set. */
  async #runSetSnapshotResponse(
    environment: RealtimeListEnvironment,
    filter: RunSetFilter,
    handle: string,
    skipColumns: string[],
    apiVersion: API_VERSIONS,
    clientVersion?: string
  ): Promise<Response> {
    const rows = await this.#resolveAndHydrate(environment, filter, skipColumns);

    const changes: RowChange[] = rows.map((row) => ({ row, operation: "insert" as const }));

    // updatedAt comes from the authoritative Postgres hydrate, not ClickHouse.
    const seen: WorkingSet = new Map();
    let maxUpdatedAt = 0;
    for (const row of rows) {
      const updatedAtMs = row.updatedAt.getTime();
      seen.set(row.id, updatedAtMs);
      maxUpdatedAt = Math.max(maxUpdatedAt, updatedAtMs);
    }
    this.#workingSetCache.set(this.#workingSetKey(environment.id, handle), seen);

    return this.#buildResponse(buildRowsBody(changes, skipColumns), apiVersion, clientVersion, {
      offset: encodeOffset(maxUpdatedAt, this.#nextSeq()),
      handle,
      schema: buildElectricSchemaHeader(skipColumns),
    });
  }

  /**
   * Live poll for a multi-run feed. Two paths:
   *  - Fast path (router notify): the router woke us with the matched runs already
   *    membership-confirmed, hydrated, and serialized (no ClickHouse). Diff them against
   *    the per-handle working set and emit new/advanced rows.
   *  - Backstop (timeout): a full ClickHouse resolve + hydrate. The correctness net —
   *    catches members missed during a gap and drops runs that left the filter.
   * With hold-on-empty (default) the connection holds until a real delta or the backstop
   * rather than returning an empty response the client would re-issue.
   */
  async #runSetLiveResponse(
    environment: RealtimeListEnvironment,
    filter: RunSetFilter,
    handle: string,
    offset: string,
    skipColumns: string[],
    apiVersion: API_VERSIONS,
    clientVersion: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    return this.#withConcurrencySlot(environment, async () => {
      const offsetFloorMs = parseOffsetUpdatedAtMs(offset);
      // Total time to hold this long-poll, jittered to avoid synchronized refetch herds.
      const deadline = Date.now() + this.#jitteredTimeout();
      const holdOnEmpty = this.options.holdOnEmpty ?? true;

      // Working set we diff against: seeded from the cache (or the offset floor on a
      // miss) and advanced on each refetch within this held request.
      const workingSetKey = this.#workingSetKey(environment.id, handle);
      let prevSeen = this.#workingSetCache.get(workingSetKey);

      const emitFromSerialized = (changes: SerializedRowChange[], maxUpdatedAt: number): Response => {
        const seq = this.#nextSeq();
        return this.#buildResponse(buildRowsBodyFromSerialized(changes), apiVersion, clientVersion, {
          offset: encodeOffset(maxUpdatedAt, seq),
          handle,
          cursor: String(seq),
        });
      };
      const emitFromRows = (changes: RowChange[], maxUpdatedAt: number): Response => {
        const seq = this.#nextSeq();
        return this.#buildResponse(buildRowsBody(changes, skipColumns), apiVersion, clientVersion, {
          offset: encodeOffset(maxUpdatedAt, seq),
          handle,
          cursor: String(seq),
        });
      };
      const emitUpToDate = (maxUpdatedAt: number): Response => {
        const seq = this.#nextSeq();
        return this.#buildResponse(buildUpToDateBody(), apiVersion, clientVersion, {
          offset: encodeOffset(maxUpdatedAt, seq),
          handle,
          cursor: String(seq),
        });
      };

      const registration = this.options.router.register(
        environment.id,
        this.#feedFilter(filter),
        skipColumns
      );

      try {
        while (true) {
          const remaining = deadline - Date.now();
          const { reason, rows } =
            remaining > 0
              ? await registration.waitForMatch(signal, remaining)
              : { reason: "timeout" as const, rows: [] as MatchedRow[] };
          this.options.onWakeup?.(reason);

          if (reason === "abort") {
            return emitUpToDate(offsetFloorMs);
          }

          // FAST PATH: the router already confirmed membership + the createdAt window and
          // hydrated/serialized the matched runs. Just diff against the working set.
          if (reason === "notify") {
            this.options.onLivePollPath?.("fast-hydrate");
            const { changes, maxUpdatedAt, touched } = this.#diffMatched(
              rows,
              prevSeen,
              offsetFloorMs
            );
            // Merge (not replace): the router only surfaced the changed subset, so keep the
            // rest of the working set intact. The backstop full-resolve rebuilds it.
            const merged = this.#mergeWorkingSet(prevSeen, touched);
            this.#workingSetCache.set(workingSetKey, merged);
            prevSeen = merged;

            if (changes.length > 0) {
              return emitFromSerialized(changes, maxUpdatedAt);
            }
            // Matched but no row advanced (already seen). Keep holding.
            if (holdOnEmpty) {
              continue;
            }
            return emitUpToDate(maxUpdatedAt);
          }

          // BACKSTOP: full ClickHouse resolve + hydrate. Replaces the working set so runs
          // that left the filter stop being tracked (the client keeps showing them).
          this.options.onLivePollPath?.("full-resolve");
          const resolved = await this.#resolveAndHydrate(environment, filter, skipColumns);
          const { changes, maxUpdatedAt, touched } = this.#diffRows(
            resolved,
            prevSeen,
            offsetFloorMs
          );
          this.#workingSetCache.set(workingSetKey, touched);
          prevSeen = touched;

          if (changes.length > 0) {
            return emitFromRows(changes, maxUpdatedAt);
          }
          // Empty backstop diff: timeout returns up-to-date; (holdOnEmpty never reaches
          // here on a notify — those are handled in the fast path above).
          return emitUpToDate(maxUpdatedAt);
        }
      } finally {
        registration.close();
      }
    });
  }

  /** Translate a multi-run filter into the router's membership predicate. */
  #feedFilter(filter: RunSetFilter): FeedFilter {
    if (filter.batchId !== undefined) {
      return { kind: "batch", batchId: filter.batchId };
    }
    return {
      kind: "tag",
      tags: filter.tags ?? [],
      createdAtFloorMs: filter.createdAtAfter?.getTime(),
    };
  }

  /** Diff router-matched rows (already serialized) against the prior working set, pairing
   * each row's shared `value` with this feed's operation. */
  #diffMatched(
    matched: MatchedRow[],
    prevSeen: WorkingSet | undefined,
    offsetFloorMs: number
  ): { changes: SerializedRowChange[]; maxUpdatedAt: number; touched: WorkingSet } {
    const changes: SerializedRowChange[] = [];
    const touched: WorkingSet = new Map();
    let maxUpdatedAt = offsetFloorMs;
    for (const { row, value } of matched) {
      const updatedAtMs = row.updatedAt.getTime();
      touched.set(row.id, updatedAtMs);
      maxUpdatedAt = Math.max(maxUpdatedAt, updatedAtMs);

      if (prevSeen) {
        const prior = prevSeen.get(row.id);
        if (prior === undefined) {
          changes.push({ runId: row.id, value, operation: "insert" });
        } else if (updatedAtMs > prior) {
          changes.push({ runId: row.id, value, operation: "update" });
        }
      } else if (updatedAtMs > offsetFloorMs) {
        changes.push({ runId: row.id, value, operation: "update" });
      }
    }
    return { changes, maxUpdatedAt, touched };
  }

  /**
   * Diff hydrated rows against the prior working set on the authoritative Postgres
   * `updatedAt`: a run not in the set is an `insert`, one whose `updatedAt` advanced is an
   * `update`. On a working-set miss, anything past the offset floor is a merge-safe
   * `update`. Used by the snapshot and the backstop full-resolve.
   */
  #diffRows(
    rows: RealtimeRunRow[],
    prevSeen: WorkingSet | undefined,
    offsetFloorMs: number
  ): { changes: RowChange[]; maxUpdatedAt: number; touched: WorkingSet } {
    const changes: RowChange[] = [];
    const touched: WorkingSet = new Map();
    let maxUpdatedAt = offsetFloorMs;
    for (const row of rows) {
      const updatedAtMs = row.updatedAt.getTime();
      touched.set(row.id, updatedAtMs);
      maxUpdatedAt = Math.max(maxUpdatedAt, updatedAtMs);

      if (prevSeen) {
        const prior = prevSeen.get(row.id);
        if (prior === undefined) {
          changes.push({ row, operation: "insert" });
        } else if (updatedAtMs > prior) {
          changes.push({ row, operation: "update" });
        }
      } else if (updatedAtMs > offsetFloorMs) {
        changes.push({ row, operation: "update" });
      }
    }
    return { changes, maxUpdatedAt, touched };
  }

  /** Merge fast-path touched rows into the prior working set. The fast path only saw the
   * changed subset, so we keep the rest (the backstop full-resolve does the exact rebuild). */
  #mergeWorkingSet(prevSeen: WorkingSet | undefined, touched: WorkingSet): WorkingSet {
    const merged: WorkingSet = new Map(prevSeen ?? undefined);
    for (const [id, updatedAtMs] of touched) {
      merged.set(id, updatedAtMs);
    }
    return merged;
  }

  /**
   * Resolve the filter's id-set (ClickHouse) and hydrate the rows (Postgres), coalesced +
   * short-TTL cached by (env, filter, columns). Used by the initial snapshot and the
   * backstop. A reconnect/snapshot stampede of identical filters shares ONE resolve+hydrate
   * (concurrent callers await the in-flight one; callers within the TTL reuse the rows).
   */
  async #resolveAndHydrate(
    environment: RealtimeListEnvironment,
    filter: RunSetFilter,
    skipColumns: string[]
  ): Promise<RealtimeRunRow[]> {
    const key = this.#runSetCacheKey(environment.id, filter, skipColumns);

    const cached = this.#runSetCache.get(key);
    if (cached) {
      this.options.onRunSetResolve?.("hit");
      return cached;
    }

    const existing = this.#runSetInflight.get(key);
    if (existing) {
      this.options.onRunSetResolve?.("coalesced");
      return existing;
    }

    this.options.onRunSetResolve?.("miss");
    // Registered in #runSetInflight synchronously below, so same-filter callers that arrive
    // while this is still waiting for an admission permit coalesce onto it (one permit, not N).
    const promise = this.#admitAndResolveUncached(environment, filter, skipColumns)
      .then((rows) => {
        this.#runSetCache.set(key, rows);
        return rows;
      })
      .finally(() => {
        this.#runSetInflight.delete(key);
      });

    this.#runSetInflight.set(key, promise);
    return promise;
  }

  /** Acquire an admission permit (if the gate is enabled) before the fresh CH+PG resolve, so
   * a distinct-filter stampede is throttled to the configured concurrency. */
  async #admitAndResolveUncached(
    environment: RealtimeListEnvironment,
    filter: RunSetFilter,
    skipColumns: string[]
  ): Promise<RealtimeRunRow[]> {
    if (!this.#admissionGate) {
      return this.#resolveAndHydrateUncached(environment, filter, skipColumns);
    }
    const waitStart = Date.now();
    await this.#admissionGate.acquire();
    const waited = Date.now() - waitStart;
    if (waited > 0) {
      this.options.onResolveAdmissionWait?.(waited);
    }
    try {
      return await this.#resolveAndHydrateUncached(environment, filter, skipColumns);
    } finally {
      this.#admissionGate.release();
    }
  }

  async #resolveAndHydrateUncached(
    environment: RealtimeListEnvironment,
    filter: RunSetFilter,
    skipColumns: string[]
  ): Promise<RealtimeRunRow[]> {
    const resolveStart = Date.now();
    const ids = await this.#resolveIds(environment, filter);
    this.options.onRunSetQuery?.("resolve", Date.now() - resolveStart);

    const hydrateStart = Date.now();
    const rows = await this.options.runReader.hydrateByIds(environment.id, ids, skipColumns);
    this.options.onRunSetQuery?.("hydrate", Date.now() - hydrateStart);

    return rows;
  }

  /** Stable cache key for the resolve+hydrate cache. Same key => same id-set and the
   * same projected columns, so cached rows always match the requesting feed. */
  #runSetCacheKey(environmentId: string, filter: RunSetFilter, skipColumns: string[]): string {
    // JSON-encode the arrays (not a join) so a value containing the separators —
    // e.g. a tag with a comma — can't collide: ["a,b"] must not key the same as
    // ["a","b"], which are different ClickHouse filters.
    const tags = filter.tags && filter.tags.length > 0 ? JSON.stringify([...filter.tags].sort()) : "";
    const cols = skipColumns.length > 0 ? JSON.stringify([...skipColumns].sort()) : "";
    const maxListResults = this.options.maxListResults ?? DEFAULT_MAX_LIST_RESULTS;
    return `${environmentId}|${tags}|${filter.batchId ?? ""}|${
      filter.createdAtAfter?.getTime() ?? ""
    }|${maxListResults}|${cols}`;
  }

  async #resolveIds(environment: RealtimeListEnvironment, filter: RunSetFilter): Promise<string[]> {
    const maxListResults = this.options.maxListResults ?? DEFAULT_MAX_LIST_RESULTS;
    const ids = await this.options.runListResolver.resolveMatchingRunIds({
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
      tags: filter.tags,
      batchId: filter.batchId,
      createdAtAfter: filter.createdAtAfter,
      limit: maxListResults,
    });

    if (ids.length >= maxListResults) {
      logger.warn("[notifierRealtimeClient] run-set feed hit the result cap", {
        environmentId: environment.id,
        filter,
        cap: maxListResults,
      });
    }

    return ids;
  }

  #computeCreatedAtFilter(createdAt: string | undefined): Date {
    // Clamp to the maximum lookback window, mirroring realtimeClient.
    const floor = new Date(Date.now() - this.options.maximumCreatedAtFilterAgeMs);
    const parsed = safeParseNaturalLanguageDurationAgo(createdAt ?? "24h");
    const resolved = !parsed || parsed < floor ? floor : parsed;
    // Quantize the lower bound to a coarse epoch-aligned bucket and pin THAT in the
    // handle, so same-tag feeds whose windows land in the same bucket resolve to the
    // same filter -> same coalescing cache key -> one shared ClickHouse + Postgres
    // query instead of one per feed. Floored (rounds the bound earlier), so the
    // window only ever widens by < bucket and never drops a run the client should see.
    return new Date(this.#bucketCreatedAtMs(resolved.getTime()));
  }

  #bucketCreatedAtMs(ms: number): number {
    const bucket = this.options.runSetCreatedAtBucketMs ?? DEFAULT_RUNSET_CREATED_AT_BUCKET_MS;
    return bucket > 0 ? Math.floor(ms / bucket) * bucket : ms;
  }

  /** Clamp a handle-recovered createdAt lower bound up to the max-age floor (so a
   * stale or crafted handle can't widen the window past the ceiling), then re-bucket. */
  #clampCreatedAtFloor(ms: number): number {
    const floorMs = Date.now() - this.options.maximumCreatedAtFilterAgeMs;
    return this.#bucketCreatedAtMs(Math.max(ms, floorMs));
  }

  #mintListHandle(createdAtFilterMs: number): string {
    // Pins the createdAt threshold in the opaque handle so live polls reuse the
    // same lower bound even on a working-set cache miss.
    return `runs_${Math.trunc(createdAtFilterMs)}_${this.#mintUniqueSuffix()}`;
  }

  #mintBatchHandle(batchId: string): string {
    return `batch_${batchId}_${this.#mintUniqueSuffix()}`;
  }

  #mintUniqueSuffix(): string {
    // The seq alone isn't unique across instances/restarts; behind a non-sticky ALB a
    // collision would land two connections on one working-set cache entry.
    return `${this.#nextSeq()}_${randomUUID().slice(0, 8)}`;
  }

  #workingSetKey(environmentId: string, handle: string): string {
    // The handle is client-echoed; env-prefix the key so a foreign handle can never
    // read or overwrite another tenant's working set.
    return `${environmentId}:${handle}`;
  }

  #filterMsFromHandle(handle: string): number | undefined {
    const parts = handle.split("_");
    if (parts[0] !== "runs") {
      return undefined;
    }
    const ms = Number(parts[1]);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }

  #parseStreamRequest(
    url: URL | string,
    requestOptions?: RealtimeRequestOptions
  ): { offset: string; handle: string | null; isLive: boolean; skipColumns: string[] } {
    const $url = new URL(url.toString());
    return {
      offset: $url.searchParams.get("offset") ?? INITIAL_OFFSET,
      handle: $url.searchParams.get("handle") ?? $url.searchParams.get("shape_id"),
      isLive: $url.searchParams.get("live") === "true",
      skipColumns: this.#resolveSkipColumns($url, requestOptions),
    };
  }

  /**
   * Runs `work` inside a per-env concurrency slot: acquires a slot (429 if over the
   * org limit, 500 if the limit can't be read) and always releases it afterward.
   */
  async #withConcurrencySlot(
    environment: RealtimeEnvironment,
    work: () => Promise<Response>
  ): Promise<Response> {
    const requestId = randomUUID();
    const concurrencyLimit = await this.options.cachedLimitProvider.getCachedLimit(
      environment.organizationId,
      DEFAULT_CONCURRENCY_LIMIT
    );

    if (concurrencyLimit == null) {
      logger.error("[notifierRealtimeClient] Failed to get concurrency limit", {
        organizationId: environment.organizationId,
      });
      return json({ error: "Failed to get concurrency limit" }, { status: 500 });
    }

    const canProceed = await this.options.limiter.incrementAndCheck(
      environment.id,
      requestId,
      concurrencyLimit
    );

    if (!canProceed) {
      return json({ error: "Too many concurrent requests" }, { status: 429 });
    }

    try {
      return await work();
    } finally {
      await this.options.limiter.decrement(environment.id, requestId);
    }
  }

  #jitteredTimeout(): number {
    const base = this.options.livePollTimeoutMs ?? DEFAULT_LIVE_POLL_TIMEOUT_MS;
    // +/-15% jitter to avoid synchronized refetch herds.
    return Math.round(base * (0.85 + Math.random() * 0.3));
  }

  #buildResponse(
    body: string,
    apiVersion: API_VERSIONS,
    clientVersion: string | undefined,
    headers: ResponseHeaderInput
  ): Response {
    const finalBody =
      apiVersion === CURRENT_API_VERSION ? body : rewriteBodyForLegacyApiVersion(body);

    const responseHeaders = new Headers();
    responseHeaders.set("content-type", "application/json");
    responseHeaders.set("cache-control", "no-store");

    // Carry CORS on the response itself, mirroring how the Electric upstream does
    // (apiCors passes a response through untouched once it has allow-origin). Browsers
    // can only read the electric-* headers cross-origin if they're explicitly exposed;
    // without this the deployed react-hooks fail with MissingHeadersError. Bearer-token
    // requests are non-credentialed, so a wildcard is safe.
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("access-control-expose-headers", "*");

    // Modern clients (1.0.14) send `x-trigger-electric-version` and read the
    // lowercase `electric-*` headers. Legacy clients (0.4.0) omit the version and
    // read `electric-shape-id`/`electric-chunk-last-offset` (case-insensitive),
    // matching realtimeClient's rewriteResponseHeaders behavior exactly.
    if (clientVersion) {
      responseHeaders.set("electric-offset", headers.offset);
      responseHeaders.set("electric-handle", headers.handle);
    } else {
      responseHeaders.set("electric-chunk-last-offset", headers.offset);
      responseHeaders.set("electric-shape-id", headers.handle);
    }

    if (headers.cursor !== undefined) {
      responseHeaders.set("electric-cursor", headers.cursor);
    }
    if (headers.schema !== undefined) {
      responseHeaders.set("electric-schema", headers.schema);
    }

    return new Response(finalBody, { status: 200, headers: responseHeaders });
  }

  #mintHandle(runId: string): string {
    // Stable per-run handle: the single-run shape never changes columns, so the
    // client never needs a must-refetch from a handle change.
    return `run-${runId}`;
  }

  #nextSeq(): number {
    this.#seq = (this.#seq + 1) % Number.MAX_SAFE_INTEGER;
    return this.#seq;
  }

  #resolveSkipColumns(url: URL, requestOptions?: RealtimeRequestOptions): string[] {
    const raw = requestOptions?.skipColumns ?? url.searchParams.get("skipColumns")?.split(",") ?? [];
    return raw.map((c) => c.trim()).filter((c) => c !== "" && !RESERVED_COLUMNS.includes(c));
  }
}
