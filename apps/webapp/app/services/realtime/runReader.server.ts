import { type Prisma, type PrismaClient } from "@trigger.dev/database";
import { BoundedTtlCache } from "./boundedTtlCache";
import { type RealtimeRunRow } from "./electricStreamProtocol.server";

/**
 * RunReader — the pluggable read half of the notifier-backed realtime feed.
 *
 * The mandate: ClickHouse is filter-only and resolves IDs,
 * Postgres always hydrates row columns. This file owns the Postgres hydration
 * half (`RunHydrator`, by-id) and the `RunListResolver` interface (the tag/list
 * filter -> id-set seam, implemented over ClickHouse).
 *
 * Splitting hydration behind this small surface keeps the realtime feed
 * decoupled from where runs physically live, ready for a future `TaskRunFast`
 * table or a non-Postgres row store.
 */

/** The TaskRun columns the realtime feed projects (mirrors DEFAULT_ELECTRIC_COLUMNS). */
export const RUN_HYDRATOR_SELECT = {
  id: true,
  taskIdentifier: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  delayUntil: true,
  queuedAt: true,
  expiredAt: true,
  completedAt: true,
  friendlyId: true,
  number: true,
  isTest: true,
  status: true,
  usageDurationMs: true,
  costInCents: true,
  baseCostInCents: true,
  ttl: true,
  payload: true,
  payloadType: true,
  metadata: true,
  metadataType: true,
  output: true,
  outputType: true,
  runTags: true,
  error: true,
  realtimeStreams: true,
} satisfies Prisma.TaskRunSelect;

/**
 * Columns the feed needs internally regardless of the client's `skipColumns`:
 * `id` keys the row, `updatedAt` drives the offset and the live working-set diff.
 * Everything else can be projected away when the client skips it (see
 * `buildHydratorSelect`), so the replica doesn't ship large `payload`/`output`/
 * `metadata`/`error` columns the response will drop anyway.
 */
const ALWAYS_HYDRATED_COLUMNS = new Set<string>(["id", "updatedAt"]);

/** Project `RUN_HYDRATOR_SELECT` down to the columns the client didn't skip (plus
 * the always-needed ones). An empty skip set returns the full select unchanged. */
export function buildHydratorSelect(skipColumns: string[] = []): Prisma.TaskRunSelect {
  if (skipColumns.length === 0) {
    return RUN_HYDRATOR_SELECT;
  }
  const skip = new Set(skipColumns);
  const select: Record<string, boolean> = {};
  for (const column of Object.keys(RUN_HYDRATOR_SELECT)) {
    if (ALWAYS_HYDRATED_COLUMNS.has(column) || !skip.has(column)) {
      select[column] = true;
    }
  }
  return select as Prisma.TaskRunSelect;
}

export type RunListFilter = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  /** Contains-ANY tag match (OR). Omit/empty for non-tag feeds. */
  tags?: string[];
  /** Restrict to a single batch (internal batch id) — the batch feed. */
  batchId?: string;
  /** Lower bound on createdAt (the tag-list feed pins this; batch omits it). */
  createdAtAfter?: Date;
  /** Hard cap on the result set so a broad filter can't unbound the snapshot. */
  limit: number;
};

/**
 * Resolves a tag/list filter into the matching run id-set, filter-only (no row
 * columns; rows are hydrated from Postgres by id afterward). Pluggable so the
 * resolution source can change without touching the feed. The ClickHouse
 * implementation lives in `clickHouseRunListResolver.server.ts`.
 */
export interface RunListResolver {
  resolveMatchingRunIds(filter: RunListFilter): Promise<string[]>;
}

export type RunHydratorOptions = {
  /** A read-replica Prisma client (`$replica`). Always Postgres. */
  replica: Pick<PrismaClient, "taskRun">;
  /**
   * Read-through cache TTL (ms) to collapse duplicate refetches across a burst
   * of live polls for the same run. Fan-in is low in practice, so this is
   * insurance, not load-bearing. Set to 0 to disable. Defaults to 250ms.
   */
  cacheTtlMs?: number;
  /** Hard cap on cache entries before expired entries are swept. */
  maxCacheEntries?: number;
};

const DEFAULT_CACHE_TTL_MS = 250;
const DEFAULT_MAX_CACHE_ENTRIES = 5_000;

/**
 * Hydrates a single run by id from the read replica, projected to the realtime
 * columns. Concurrent refetches for the same (env, run) are single-flighted, and
 * a short TTL cache collapses rapid repeats.
 */
export class RunHydrator {
  readonly #inflight = new Map<string, Promise<RealtimeRunRow | null>>();
  readonly #cache: BoundedTtlCache<RealtimeRunRow | null>;
  readonly #cacheTtlMs: number;

  constructor(private readonly options: RunHydratorOptions) {
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#cache = new BoundedTtlCache(
      this.#cacheTtlMs,
      options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES
    );
  }

  async getRunById(environmentId: string, runId: string): Promise<RealtimeRunRow | null> {
    const key = `${environmentId}:${runId}`;

    if (this.#cacheTtlMs > 0) {
      // A cached null is a valid "run not found" hit; only undefined is a miss.
      const cached = this.#cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
    }

    const existing = this.#inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.#fetch(environmentId, runId).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);

    const row = await promise;

    if (this.#cacheTtlMs > 0) {
      this.#cache.set(key, row);
    }

    return row;
  }

  /** Hydrate many runs by id in one query (tag/list feed). Order is not guaranteed.
   * `skipColumns` projects the SELECT so the replica doesn't ship columns the client
   * dropped (notably the large `payload`/`output`/`metadata`/`error` columns). */
  async hydrateByIds(
    environmentId: string,
    ids: string[],
    skipColumns: string[] = []
  ): Promise<RealtimeRunRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.options.replica.taskRun.findMany({
      where: {
        runtimeEnvironmentId: environmentId,
        id: { in: ids },
      },
      select: buildHydratorSelect(skipColumns),
    });
    return rows as unknown as RealtimeRunRow[];
  }

  async #fetch(environmentId: string, runId: string): Promise<RealtimeRunRow | null> {
    const run = await this.options.replica.taskRun.findFirst({
      where: {
        id: runId,
        runtimeEnvironmentId: environmentId,
      },
      select: RUN_HYDRATOR_SELECT,
    });

    return (run ?? null) as RealtimeRunRow | null;
  }
}
