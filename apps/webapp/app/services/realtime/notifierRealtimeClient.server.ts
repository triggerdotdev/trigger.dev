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
} from "./electricStreamProtocol.server";
import { BoundedTtlCache } from "./boundedTtlCache";
import { type RunChangeNotifier, type RunChangeSubscription } from "./runChangeNotifier.server";
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

export type NotifierRealtimeClientOptions = {
  runReader: RunHydrator;
  /** Resolves the tag/list filter into the matching id-set (filter-only). */
  runListResolver: RunListResolver;
  notifier: RunChangeNotifier;
  limiter: RealtimeConcurrencyLimiter;
  cachedLimitProvider: CachedLimitProvider;
  /** Backstop wait before refetching on a live request (ms). Defaults to 5000. */
  livePollTimeoutMs?: number;
  /** Ceiling for the tag-list createdAt lookback window (ms). */
  maximumCreatedAtFilterAgeMs: number;
  /** Hard cap on tag-list snapshot size. Defaults to 1000. */
  maxListResults?: number;
  /** TTL (ms) for the multi-run resolve+hydrate coalescing cache. Defaults to 1000. */
  runSetResolveCacheTtlMs?: number;
  /** Max entries in the resolve+hydrate cache. Defaults to 5000. */
  runSetResolveCacheMaxEntries?: number;
  /** Max entries in the per-handle working-set cache. Defaults to 10000. */
  listCacheMaxEntries?: number;
  /** Epoch-aligned bucket (ms) the tag-list createdAt lower bound is floored to, so
   * same-tag feeds pinned within the same bucket share a cache entry. Defaults to
   * 60000. 0 disables bucketing. */
  runSetCreatedAtBucketMs?: number;
  /** Observability hook: why a live request woke (notify vs timeout vs abort). */
  onWakeup?: (reason: WakeupReason) => void;
  /** Observability hook: whether a multi-run resolve hit the cache, coalesced onto
   * an in-flight resolve, or missed (issued fresh ClickHouse + Postgres queries). */
  onRunSetResolve?: (result: "hit" | "miss" | "coalesced") => void;
  /** Observability hook: latency (ms) of the ClickHouse resolve / Postgres hydrate. */
  onRunSetQuery?: (stage: "resolve" | "hydrate", ms: number) => void;
};

const DEFAULT_CONCURRENCY_LIMIT = 100_000;
const DEFAULT_LIVE_POLL_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_LIST_RESULTS = 1_000;
const LIST_CACHE_TTL_MS = 5 * 60_000;
const LIST_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_RUNSET_CACHE_TTL_MS = 1_000;
const DEFAULT_RUNSET_CACHE_MAX_ENTRIES = 5_000;
const DEFAULT_RUNSET_CREATED_AT_BUCKET_MS = 60_000;

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
 * Notifier-backed implementation of the realtime run feeds: signals run changes
 * over Redis pub/sub and refetches the current rows from a read replica.
 *
 * Single-run (`streamRun`):
 *  - initial (`offset=-1`): hydrate + emit `insert` + `up-to-date` (with schema)
 *  - live: race a per-run notification vs a ~5s backstop and the abort signal,
 *    refetch, and emit a full-row `update` ONLY when `updatedAt` advanced past what
 *    the client has (a stale replica read never regresses); else a bare `up-to-date`.
 *
 * Multi-run feeds (`streamRuns` tag-list, `streamBatch`) share one core:
 *  - initial: resolve the matching id-set via ClickHouse `listRunIds` (filter-only,
 *    tag-OR or batchId), hydrate by-id from Postgres, emit N `insert`s.
 *  - live: one per-env subscription wakes the feed; re-resolve the set, hydrate it,
 *    and emit only new (`insert`) / advanced (`update`) rows — diffed on the
 *    authoritative Postgres `updatedAt` against a per-handle working set (cache miss
 *    falls back to the offset floor, merge-safe). ClickHouse supplies membership;
 *    Postgres supplies fresh row state, so CH ingest lag never stales the rows.
 *    Tag-list pins its `createdAt` window in the handle; batch needs no window.
 *
 * Tokens are opaque: `offset` = `<maxUpdatedAtMs>_<seq>`, `handle` is per-shape,
 * `cursor` is a live-only counter. The wire format is produced by
 * `electricStreamProtocol`.
 */
export class NotifierRealtimeClient implements RealtimeStreamClient {
  #seq = 0;
  readonly #workingSetCache: BoundedTtlCache<WorkingSet>;
  /** Coalescing cache for the multi-run (resolveIds -> hydrateByIds) pair, keyed by
   * (env, filter, columns). Collapses an env-wide wake's per-feed query fan-out into
   * one shared resolve+hydrate per filter per short window. */
  readonly #runSetCache: BoundedTtlCache<RealtimeRunRow[]>;
  readonly #runSetInflight = new Map<string, Promise<RealtimeRunRow[]>>();

  constructor(private readonly options: NotifierRealtimeClientOptions) {
    this.#workingSetCache = new BoundedTtlCache(
      LIST_CACHE_TTL_MS,
      options.listCacheMaxEntries ?? LIST_CACHE_MAX_ENTRIES
    );
    this.#runSetCache = new BoundedTtlCache(
      options.runSetResolveCacheTtlMs ?? DEFAULT_RUNSET_CACHE_TTL_MS,
      options.runSetResolveCacheMaxEntries ?? DEFAULT_RUNSET_CACHE_MAX_ENTRIES
    );
  }

  /** Current size of the per-handle working-set cache (for a metrics gauge). */
  get workingSetCacheSize(): number {
    return this.#workingSetCache.size;
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
    const { offset, isLive, skipColumns } = this.#parseStreamRequest(url, requestOptions);

    // The batch set is fully defined by batchId (the route resolves it from the
    // friendlyId on every request), so the handle is derived and stable and there's
    // no createdAt window to pin.
    const handle = `batch-${batchId}`;
    const filter: RunSetFilter = { batchId };

    if (offset !== INITIAL_OFFSET && isLive) {
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

    // Initial snapshot + non-live catch-up.
    return this.#runSetSnapshotResponse(
      environment,
      filter,
      handle,
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
      const reason = await this.#waitForChange(runId, signal);
      this.options.onWakeup?.(reason);

      const row = await this.options.runReader.getRunById(environment.id, runId);
      const lastSeenMs = parseOffsetUpdatedAtMs(offset);
      const seq = this.#nextSeq();

      // Only-on-advance: emit a full-row update when the replica row moved past
      // what the client already has; otherwise a bare up-to-date keeps the offset.
      // Live responses carry electric-cursor but NOT electric-schema (the client
      // already has the schema from the initial snapshot) — matching real Electric.
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
    this.#workingSetCache.set(handle, seen);

    return this.#buildResponse(buildRowsBody(changes, skipColumns), apiVersion, clientVersion, {
      offset: encodeOffset(maxUpdatedAt, this.#nextSeq()),
      handle,
      schema: buildElectricSchemaHeader(skipColumns),
    });
  }

  /** Live poll for a multi-run feed: wait, re-resolve the set, and emit only the
   * rows that are new or advanced vs the cached working set. */
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
      // One env-scoped subscription per feed (not one per run): any run change in
      // the env wakes us, then we re-resolve the filter.
      const reason = await this.#waitForEnvChange(environment.id, signal);
      this.options.onWakeup?.(reason);

      const cached = this.#workingSetCache.get(handle);
      const offsetFloorMs = parseOffsetUpdatedAtMs(offset);
      const seq = this.#nextSeq();

      // ClickHouse resolves the (possibly stale) membership; Postgres hydrates the
      // authoritative current rows, so status is always fresh even if CH lags. The
      // resolve+hydrate is coalesced + short-TTL cached so a single env-wide wake
      // doesn't fan out into one CH+PG query per concurrent same-filter feed.
      const rows = await this.#resolveAndHydrate(environment, filter, skipColumns);

      // Diff against what the client already has, using the hydrated updatedAt:
      // cache hit => per-row (new = insert, advanced = update); miss => anything
      // newer than the offset floor as a merge-safe update.
      const changes: RowChange[] = [];
      const seen: WorkingSet = new Map();
      let maxUpdatedAt = offsetFloorMs;
      for (const row of rows) {
        const updatedAtMs = row.updatedAt.getTime();
        seen.set(row.id, updatedAtMs);
        maxUpdatedAt = Math.max(maxUpdatedAt, updatedAtMs);

        if (cached) {
          const prior = cached.get(row.id);
          if (prior === undefined) {
            changes.push({ row, operation: "insert" });
          } else if (updatedAtMs > prior) {
            changes.push({ row, operation: "update" });
          }
        } else if (updatedAtMs > offsetFloorMs) {
          changes.push({ row, operation: "update" });
        }
      }

      // Refresh the working set so runs that left the filter stop being tracked
      // (the client keeps showing them; the SDK never applies deletes).
      this.#workingSetCache.set(handle, seen);

      const body = changes.length === 0 ? buildUpToDateBody() : buildRowsBody(changes, skipColumns);

      return this.#buildResponse(body, apiVersion, clientVersion, {
        offset: encodeOffset(maxUpdatedAt, seq),
        handle,
        cursor: String(seq),
      });
    });
  }

  /**
   * Resolve the filter's id-set (ClickHouse) and hydrate the rows (Postgres),
   * coalesced + short-TTL cached by (env, filter, columns). Every batch feed for a
   * batch, and every tag feed sharing tags+window+columns, shares ONE resolve+hydrate
   * instead of each firing its own when the per-env channel wakes them together.
   * Concurrent callers await an in-flight resolve; callers within the TTL reuse the
   * cached rows (staleness budget: up to the TTL; the next live poll catches up).
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
    const promise = this.#resolveAndHydrateUncached(environment, filter, skipColumns)
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
    const tags = filter.tags && filter.tags.length > 0 ? [...filter.tags].sort().join(",") : "";
    const cols = skipColumns.length > 0 ? [...skipColumns].sort().join(",") : "";
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
    return `runs_${Math.trunc(createdAtFilterMs)}_${this.#nextSeq()}`;
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

  #waitForChange(runId: string, signal?: AbortSignal): Promise<WakeupReason> {
    return this.#waitForSubscription(this.options.notifier.subscribeToRunChanges(runId), signal);
  }

  #waitForEnvChange(environmentId: string, signal?: AbortSignal): Promise<WakeupReason> {
    return this.#waitForSubscription(
      this.options.notifier.subscribeToEnvChanges(environmentId),
      signal
    );
  }

  /** Race a notifier subscription against the backstop timeout and the abort signal. */
  async #waitForSubscription(
    subscription: RunChangeSubscription,
    signal?: AbortSignal
  ): Promise<WakeupReason> {
    if (signal?.aborted) {
      subscription.unsubscribe();
      return "abort";
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      return await new Promise<WakeupReason>((resolve) => {
        subscription.changed.then(() => resolve("notify")).catch(() => resolve("timeout"));

        timer = setTimeout(() => resolve("timeout"), this.#jitteredTimeout());

        if (signal) {
          onAbort = () => resolve("abort");
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      subscription.unsubscribe();
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
