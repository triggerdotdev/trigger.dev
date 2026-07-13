import { json } from "@remix-run/server-runtime";
import { safeParseNaturalLanguageDurationAgo } from "@trigger.dev/core/v3/isomorphic";
import { randomUUID } from "node:crypto";
import type { API_VERSIONS } from "~/api/versions";
import { CURRENT_API_VERSION } from "~/api/versions";
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
import { type EnvChangeRouter, type FeedFilter, type MatchedRow } from "./envChangeRouter.server";
import { type RunHydrator, type RunListResolver } from "./runReader.server";
import { type RealtimeConcurrencyLimiter } from "./realtimeConcurrencyLimiter.server";
import { InMemoryReplayCursorStore, type ReplayCursorStore } from "./replayCursorStore.server";

/** Widened with projectId so the tag-list feed can resolve ids via ClickHouse (needs org + project + env). */
export type RealtimeListEnvironment = RealtimeEnvironment & { projectId: string };

/** The realtime feeds the run routes depend on (single-run, tag-list, batch); both backends satisfy it. */
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

/** How a live poll resolved: `fast-hydrate` (router woke us, hydrate-by-id), `full-resolve`
 * (backstop), or `cold-resolve` (fresh env subscription probed once instead of holding blind). */
export type LivePollPath = "fast-hydrate" | "full-resolve" | "cold-resolve";

export type NativeRealtimeClientOptions = {
  runReader: RunHydrator;
  /** Resolves the tag/list filter into the matching id-set (filter-only). */
  runListResolver: RunListResolver;
  /** Per-instance routing layer over the single env change channel. */
  router: EnvChangeRouter;
  limiter: RealtimeConcurrencyLimiter;
  cachedLimitProvider: CachedLimitProvider;
  /** Fallback per-env concurrent-connection limit when the org has none cached. */
  defaultConcurrencyLimit?: number;
  /** Backstop wait before refetching on a live request (ms). Defaults to 20000. */
  livePollTimeoutMs?: number;
  /** Jitter ratio applied to the live-poll timeout (0.15 = ±15%). */
  livePollJitterRatio?: number;
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
  /** TTL (ms) for working-set cache entries. Defaults to 300000. */
  workingSetCacheTtlMs?: number;
  /** Epoch-aligned bucket (ms) the tag-list createdAt floor is floored to, so same-tag feeds share a cache entry. Defaults to 60000; 0 disables. */
  runSetCreatedAtBucketMs?: number;
  /** When true (default), a multi-run live poll holds until a real delta or the backstop rather than returning an empty up-to-date. */
  holdOnEmpty?: boolean;
  /** Max concurrent fresh ClickHouse resolves (cache misses) per instance, bounding a distinct-filter stampede. Defaults to 16; 0 disables. */
  resolveAdmissionLimit?: number;
  /** Per-connection replay-cursor store. Inject a fleet-shared (Redis) store so an instance
   * hop reads the connection's true inter-poll gap instead of cold-probing; defaults to a
   * per-instance in-memory cache. */
  replayCursorStore?: ReplayCursorStore;
  /** Observability hook: why a live request woke (notify vs timeout vs abort). */
  onWakeup?: (reason: WakeupReason) => void;
  /** Observability hook: how a live poll resolved (fast path vs full resolve). */
  onLivePollPath?: (path: LivePollPath) => void;
  /** Observability hook: whether a multi-run resolve hit the cache, coalesced onto an in-flight resolve, or missed. */
  onRunSetResolve?: (result: "hit" | "miss" | "coalesced") => void;
  /** Observability hook: latency (ms) of the ClickHouse resolve / Postgres hydrate. */
  onRunSetQuery?: (stage: "resolve" | "hydrate", ms: number) => void;
  /** Observability hook: a fresh resolve waited `ms` for an admission permit (only when the gate engaged). */
  onResolveAdmissionWait?: (ms: number) => void;
  /** Observability hook: a live emission left the server — lag is now minus the newest
   * emitted row's updatedAt (the end-to-end delivery SLI), rowCount the delta size. */
  onEmit?: (path: LivePollPath, lagMs: number, rowCount: number) => void;
  /** Observability hook: a backstop resolve found missed changes (delivered) or nothing
   * (empty). Sustained `delivered` means the notify/replay path is leaking. */
  onBackstopResult?: (result: "delivered" | "empty") => void;
  /** Observability hook: a poll was rejected by the per-env concurrency limiter (429). */
  onConcurrencyRejected?: () => void;
};

const DEFAULT_CONCURRENCY_LIMIT = 100_000;
// Matches Electric's ~20s live long-poll hold (jittered ±15% per request).
const DEFAULT_LIVE_POLL_TIMEOUT_MS = 20_000;
const DEFAULT_LIVE_POLL_JITTER_RATIO = 0.15;
const DEFAULT_MAX_LIST_RESULTS = 1_000;
const LIST_CACHE_TTL_MS = 5 * 60_000;
const LIST_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_RUNSET_CACHE_TTL_MS = 1_000;
const DEFAULT_RUNSET_CACHE_MAX_ENTRIES = 5_000;
const DEFAULT_RUNSET_CREATED_AT_BUCKET_MS = 60_000;
const DEFAULT_RESOLVE_ADMISSION_LIMIT = 16;

/** Fair FIFO semaphore bounding concurrent fresh ClickHouse resolves. Sits behind the single-flight + TTL cache, so only genuine cache-miss resolves take a permit. */
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

/** A multi-run feed's filter: tag-list sets `tags` (+ pinned `createdAtAfter`); the batch feed sets `batchId`. */
type RunSetFilter = {
  tags?: string[];
  batchId?: string;
  createdAtAfter?: Date;
};

/** Per-handle working set: runId -> last-emitted updatedAt (ms), so live polls emit only rows that advanced. */
type WorkingSet = Map<string, number>;

type ResponseHeaderInput = {
  offset: string;
  handle: string;
  cursor?: string;
  schema?: string;
};

/**
 * Native-backend implementation of the realtime run feeds. All three feeds are predicates over ONE
 * per-environment change stream (the EnvChangeRouter), which decides membership, hydrates the matched
 * runs, and serializes their wire values once; this client owns the snapshot, the per-handle working-set
 * diff, the ClickHouse backstop, and the wire response (opaque `offset`/`handle`/`cursor` tokens).
 */
export class NativeRealtimeClient implements RealtimeStreamClient {
  #seq = 0;
  readonly #workingSetCache: BoundedTtlCache<WorkingSet>;
  /** Coalescing cache for the multi-run resolve+hydrate, keyed by (env, filter, columns), so identical filters share one resolve. */
  readonly #runSetCache: BoundedTtlCache<RealtimeRunRow[]>;
  readonly #runSetInflight = new Map<string, Promise<RealtimeRunRow[]>>();
  /** Bounds concurrent fresh CH resolves (undefined => unbounded). */
  readonly #admissionGate?: ResolveAdmissionGate;
  /** Per-connection: when this connection's last response was sent, so the router's
   * replay covers exactly the inter-poll gap instead of rewinding a full window.
   * Fleet-shared when a store is injected (hops stop looking like unknown gaps). */
  readonly #replayCursors: ReplayCursorStore;

  constructor(private readonly options: NativeRealtimeClientOptions) {
    this.#workingSetCache = new BoundedTtlCache(
      options.workingSetCacheTtlMs ?? LIST_CACHE_TTL_MS,
      options.listCacheMaxEntries ?? LIST_CACHE_MAX_ENTRIES
    );
    this.#replayCursors =
      options.replayCursorStore ??
      new InMemoryReplayCursorStore(
        options.workingSetCacheTtlMs ?? LIST_CACHE_TTL_MS,
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
    const offset = row
      ? encodeOffset(row.updatedAt.getTime(), this.#nextSeq())
      : encodeOffset(0, 0);
    return this.#buildResponse(body, apiVersion, clientVersion, {
      offset,
      handle: existingHandle ?? this.#mintHandle(runId),
      schema: buildElectricSchemaHeader(skipColumns),
    });
  }

  /** Live poll for a single-run feed: emit a full-row `update` only when the row advanced past the client's offset, else a bare `up-to-date`. */
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
      const deadline = Date.now() + this.#jitteredTimeout();

      try {
        // Cold start (fresh env subscription, e.g. an instance hop): a change in the
        // caller's inter-poll gap may have been missed — check the row once, then hold.
        if (!registration.gapCovered) {
          this.options.onLivePollPath?.("cold-resolve");
          const probed = await this.options.runReader.getRunById(environment.id, runId);
          if (probed && probed.updatedAt.getTime() > lastSeenMs) {
            const seq = this.#nextSeq();
            this.options.onEmit?.("cold-resolve", Date.now() - probed.updatedAt.getTime(), 1);
            return this.#buildResponse(
              buildUpdateBody(probed, skipColumns),
              apiVersion,
              clientVersion,
              {
                offset: encodeOffset(probed.updatedAt.getTime(), seq),
                handle,
                cursor: String(seq),
              }
            );
          }
        }

        while (true) {
          const remaining = deadline - Date.now();
          const { reason, rows } =
            remaining > 0
              ? await registration.waitForMatch(signal, remaining)
              : { reason: "timeout" as const, rows: [] as MatchedRow[] };
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
            if (updatedAtMs > lastSeenMs) {
              const seq = this.#nextSeq();
              this.options.onEmit?.("fast-hydrate", Date.now() - updatedAtMs, 1);
              return this.#buildResponse(
                buildRowsBodyFromSerialized([
                  { runId: matched.row.id, value: matched.value, operation: "update" },
                ]),
                apiVersion,
                clientVersion,
                { offset: encodeOffset(updatedAtMs, seq), handle, cursor: String(seq) }
              );
            }
            // Already seen (e.g. a replayed record): keep holding rather than returning an
            // empty up-to-date the client would immediately re-issue.
            continue;
          }

          // Backstop timeout: re-check the run directly (no ClickHouse for the single-run feed).
          this.options.onLivePollPath?.("full-resolve");
          const row = await this.options.runReader.getRunById(environment.id, runId);
          const seq = this.#nextSeq();
          if (row && row.updatedAt.getTime() > lastSeenMs) {
            this.options.onBackstopResult?.("delivered");
            this.options.onEmit?.("full-resolve", Date.now() - row.updatedAt.getTime(), 1);
            return this.#buildResponse(
              buildUpdateBody(row, skipColumns),
              apiVersion,
              clientVersion,
              {
                offset: encodeOffset(row.updatedAt.getTime(), seq),
                handle,
                cursor: String(seq),
              }
            );
          }
          this.options.onBackstopResult?.("empty");
          return this.#buildResponse(buildUpToDateBody(), apiVersion, clientVersion, {
            offset,
            handle,
            cursor: String(seq),
          });
        }
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
    this.#replayCursors.set(this.#workingSetKey(environment.id, handle), Date.now());

    return this.#buildResponse(buildRowsBody(changes, skipColumns), apiVersion, clientVersion, {
      offset: encodeOffset(maxUpdatedAt, this.#nextSeq()),
      handle,
      schema: buildElectricSchemaHeader(skipColumns),
    });
  }

  /** Live poll for a multi-run feed: fast path diffs router-notified rows against the working set; the timeout backstop does a full ClickHouse resolve. */
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

      const markPollEnd = () => this.#replayCursors.set(workingSetKey, Date.now());
      const emitFromSerialized = (
        changes: SerializedRowChange[],
        maxUpdatedAt: number
      ): Response => {
        const seq = this.#nextSeq();
        markPollEnd();
        return this.#buildResponse(
          buildRowsBodyFromSerialized(changes),
          apiVersion,
          clientVersion,
          {
            offset: encodeOffset(maxUpdatedAt, seq),
            handle,
            cursor: String(seq),
          }
        );
      };
      const emitFromRows = (changes: RowChange[], maxUpdatedAt: number): Response => {
        const seq = this.#nextSeq();
        markPollEnd();
        return this.#buildResponse(buildRowsBody(changes, skipColumns), apiVersion, clientVersion, {
          offset: encodeOffset(maxUpdatedAt, seq),
          handle,
          cursor: String(seq),
        });
      };
      const emitUpToDate = (maxUpdatedAt: number): Response => {
        const seq = this.#nextSeq();
        markPollEnd();
        return this.#buildResponse(buildUpToDateBody(), apiVersion, clientVersion, {
          offset: encodeOffset(maxUpdatedAt, seq),
          handle,
          cursor: String(seq),
        });
      };

      // When this connection last received data, so replay covers exactly its gap. A store
      // error degrades to undefined (cold probe), never a failed poll.
      const replaySinceMs = await this.#replayCursors.get(workingSetKey);
      const registration = this.options.router.register(
        environment.id,
        this.#feedFilter(filter),
        skipColumns,
        { replaySinceMs }
      );

      // Cold start (fresh env subscription, e.g. an instance hop): resolve once up front
      // instead of holding blind — a change in the caller's inter-poll gap may have been missed.
      let coldProbe = !registration.gapCovered;

      try {
        while (true) {
          if (coldProbe) {
            coldProbe = false;
            this.options.onLivePollPath?.("cold-resolve");
            const resolved = await this.#resolveAndHydrate(environment, filter, skipColumns);
            const { changes, maxUpdatedAt, touched } = this.#diffRows(
              resolved,
              prevSeen,
              offsetFloorMs
            );
            this.#workingSetCache.set(workingSetKey, touched);
            prevSeen = touched;
            if (changes.length > 0) {
              this.options.onEmit?.("cold-resolve", Date.now() - maxUpdatedAt, changes.length);
              return emitFromRows(changes, maxUpdatedAt);
            }
            continue; // nothing was missed — hold as usual
          }

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
              this.options.onEmit?.("fast-hydrate", Date.now() - maxUpdatedAt, changes.length);
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
            this.options.onBackstopResult?.("delivered");
            this.options.onEmit?.("full-resolve", Date.now() - maxUpdatedAt, changes.length);
            return emitFromRows(changes, maxUpdatedAt);
          }
          // Empty backstop diff: timeout returns up-to-date; (holdOnEmpty never reaches
          // here on a notify — those are handled in the fast path above).
          this.options.onBackstopResult?.("empty");
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

  /** Diff hydrated rows against the prior working set on Postgres `updatedAt`: not-in-set is `insert`, advanced is `update`. */
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

  /** Resolve the filter's id-set (ClickHouse) and hydrate (Postgres), coalesced + short-TTL cached so identical filters share one resolve+hydrate. */
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
    // JSON-encode the arrays (not a join) so a tag containing the separator can't collide with a different filter.
    const tags =
      filter.tags && filter.tags.length > 0 ? JSON.stringify([...filter.tags].sort()) : "";
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
      logger.warn("[nativeRealtimeClient] run-set feed hit the result cap", {
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
    // Bucket the lower bound so same-tag feeds share a cache key; floored, so the window only ever widens by < bucket.
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

  /** Runs `work` inside a per-env concurrency slot (429 if over the org limit, 500 if the limit can't be read), always releasing it after. */
  async #withConcurrencySlot(
    environment: RealtimeEnvironment,
    work: () => Promise<Response>
  ): Promise<Response> {
    const requestId = randomUUID();
    const concurrencyLimit = await this.options.cachedLimitProvider.getCachedLimit(
      environment.organizationId,
      this.options.defaultConcurrencyLimit ?? DEFAULT_CONCURRENCY_LIMIT
    );

    if (concurrencyLimit == null) {
      logger.error("[nativeRealtimeClient] Failed to get concurrency limit", {
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
      this.options.onConcurrencyRejected?.();
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
    // Jittered to avoid synchronized refetch herds.
    const ratio = this.options.livePollJitterRatio ?? DEFAULT_LIVE_POLL_JITTER_RATIO;
    return Math.round(base * (1 - ratio + Math.random() * 2 * ratio));
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

    // Expose the electric-* headers cross-origin or the deployed react-hooks fail with MissingHeadersError (bearer requests are non-credentialed, so wildcard is safe).
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("access-control-expose-headers", "*");

    // Modern clients send `x-trigger-electric-version` and read `electric-offset`/`electric-handle`; legacy clients omit it and read the shape-id/chunk-last-offset names.
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
    const raw =
      requestOptions?.skipColumns ?? url.searchParams.get("skipColumns")?.split(",") ?? [];
    return raw.map((c) => c.trim()).filter((c) => c !== "" && !RESERVED_COLUMNS.includes(c));
  }
}
