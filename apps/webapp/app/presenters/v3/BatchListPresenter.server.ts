import { type BatchTaskRunStatus, boundedIn } from "@trigger.dev/database";
import { type RunOpsPrismaClient } from "@internal/run-ops-database";
import parse from "parse-duration";
import { type PrismaClientOrTransaction } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { BasePresenter } from "./basePresenter.server";
import { type Direction } from "~/components/ListPagination";
import { timeFilters } from "~/components/runs/v3/SharedFilters";

export type BatchListOptions = {
  userId?: string;
  projectId: string;
  environmentId: string;
  //filters
  friendlyId?: string;
  statuses?: BatchTaskRunStatus[];
  period?: string;
  from?: number;
  to?: number;
  //pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 25;

export type BatchList = Awaited<ReturnType<BatchListPresenter["call"]>>;

// The row shape of the raw BatchTaskRun keyset scan. Extracted to a named type so the
// store-selected scan closure and the keyset merge in `#scanBatchTaskRun` can reference it.
type BatchRow = {
  id: string;
  friendlyId: string;
  runtimeEnvironmentId: string;
  status: BatchTaskRunStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  runCount: number;
  batchVersion: string;
};

// Composite keyset cursor "<createdAt-epoch-ms>_<id>". Ordering is by createdAt then id: a batch id is
// a cuid (legacy) OR a run-ops id (new), and the two schemes occupy different lexical ranges, so `id`
// alone is not a valid chronological order across the residency split. `id` is the stable tiebreak.
// Old plain-id cursors (no "_") decode to undefined and restart from page 1 (self-healing).
type BatchCursor = { createdAt: Date; id: string };
function encodeBatchCursor(row: BatchCursor): string {
  return `${row.createdAt.getTime()}_${row.id}`;
}
function decodeBatchCursor(cursor: string | undefined): BatchCursor | undefined {
  if (!cursor) return undefined;
  const sep = cursor.indexOf("_");
  if (sep === -1) return undefined;
  const ms = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  // Number.isFinite accepts e.g. 1e20, but new Date(1e20) is Invalid Date — reject it so a malformed
  // URL cursor self-heals to page 1 instead of reaching Prisma with an invalid date.
  const createdAt = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(createdAt.getTime()) || id.length === 0)
    return undefined;
  return { createdAt, id };
}

export class BatchListPresenter extends BasePresenter {
  // Optional run-ops read-routing. Omitted (single-DB / self-host) => everything
  // reads from `_replica` exactly as today (passthrough). Field names are local to
  // this presenter; only the read-routing convention (optional handles, default-to-_replica,
  // boot-constant splitEnabled) is mirrored, not the literal RunsRepositoryOptions names.
  constructor(
    prismaClient?: PrismaClientOrTransaction,
    replicaClient?: PrismaClientOrTransaction,
    private readonly readRoute?: {
      runOpsNew?: RunOpsPrismaClient; // new run-ops client (run-ops brand ⇒ guard classifies as runops)
      runOpsLegacyReplica?: RunOpsPrismaClient; // legacy run-ops READ REPLICA only — never the legacy primary
      controlPlaneReplica?: PrismaClientOrTransaction; // control-plane DB (for project)
      // Gen-2 shard replicas to fan out over, in configured order — ONE ENTRY PER PHYSICAL DATABASE.
      // The route passes `runOpsNonAliasedShardReplicas`, which has already dropped every shard that
      // declares `aliasOf` (an alias shares its target's client by reference, so a leg for it would
      // scan one database twice). Empty (RUN_OPS_SHARDS unset) keeps today's exact two legs.
      // NOTE: a shard configured without a `replicaUrl` reads its WRITER. That is the established
      // behaviour of every shard handle consumer; the "never the legacy primary" rule below is
      // scoped to the LEGACY store, which has no replica-less arm.
      shardReplicas?: ReadonlyArray<{ key: string; replica: RunOpsPrismaClient }>;
      splitEnabled?: boolean; // resolved boot constant
    }
  ) {
    super(prismaClient, replicaClient);
  }

  // Control-plane READ handle for the `project` lookup. In single-DB / when omitted this is
  // `_replica` ⇒ unchanged.
  get #controlPlaneReplica(): PrismaClientOrTransaction {
    return this.readRoute?.controlPlaneReplica ?? this._replica;
  }

  // Run-ops reads for the Batches dashboard. Split on: new run-ops DB first; the LEGACY
  // RUN-OPS READ REPLICA ONLY for the older not-yet-migrated remainder/empty-state — never the
  // legacy primary. Split off (single-DB / self-host): one plain `_replica` read (passthrough).
  // `project` is resolved on the control-plane DB; the environment↔batch join is in-memory (no
  // cross-seam SQL join).
  async #scanBatchTaskRun(
    pageSize: number,
    direction: Direction,
    scan: (client: RunOpsPrismaClient) => Promise<BatchRow[]>
  ): Promise<BatchRow[]> {
    // Single-DB / passthrough: `_replica` IS the run-ops database (same physical DB), so it is the
    // run-ops read handle. Carry the run-ops brand — identical wiring, correct residency — and it
    // also backstops a split deployment that omitted a routed handle (never the legacy primary).
    const passthrough = this._replica as unknown as RunOpsPrismaClient;

    if (!this.readRoute?.splitEnabled) {
      return scan(passthrough);
    }

    // Always read EVERY store and merge. The old "skip legacy when new fills the page" shortcut is
    // unsound across the residency split: legacy cuid ids ("c…") sort ABOVE new run-ops ids ("0…")
    // under id order, so a new-only page can hide pre-flip legacy batches that belong ahead of it.
    // Ordering is by createdAt (id tiebreak), which is chronologically correct across every scheme.
    //
    // Every leg runs the SAME closure, so `take: pageSize + 1`, the cursor predicate and the two-key
    // order are shared. A row's rank within its own leg is never worse than its global rank, so the
    // true global first (pageSize + 1) rows are all present among the per-leg results — an argument
    // in the number of legs, not in two.
    //
    // Promise.all, NOT allSettled: one store down must fail the page. A tolerant fan-out would
    // return a SHORT page with no error, which is exactly the silent absence this routing exists to
    // remove, with a wider blast radius. The routing store's own list fan-out is Promise.all for the
    // same reason.
    const shardReplicas = this.readRoute.shardReplicas ?? [];
    const [newRows, legacyRows, ...shardRows] = await Promise.all([
      scan(this.readRoute.runOpsNew ?? passthrough),
      scan(this.readRoute.runOpsLegacyReplica ?? passthrough),
      ...shardReplicas.map((shard) => scan(shard.replica)),
    ]);

    // De-dupe by id, re-sort under the page's keyset order, re-apply the over-fetch LIMIT.
    //
    // Precedence ascends legacy → new → gen-2 shards, last write wins — the routing store's
    // `#mergeById` semantics, which inserts unconditionally over legs supplied in precedence order.
    // The gen-1 pair keeps its original conditional form so its result stays byte-identical; the
    // shard legs then overwrite. Do NOT "simplify" the conditional insert below into an
    // unconditional one without also reordering the legs, or legacy would start winning over new.
    //
    // Precedence is load-bearing, not decoration. Today a batch row has exactly one writer
    // (PostgresRunStore.createBatchTaskRun), which routes by id shape, so a duplicate id is not
    // produced by ordinary creates. But a row can still exist on two stores while data is being
    // moved between them, which is why the routing store dedupes batches WITHOUT alarming
    // (alarmOnDuplicate: false). When that happens the page must show the higher-authority copy,
    // and that is what the leg order below decides.
    const byId = new Map<string, BatchRow>();
    for (const row of newRows) {
      byId.set(row.id, row);
    }
    for (const row of legacyRows) {
      if (!byId.has(row.id)) {
        byId.set(row.id, row);
      }
    }
    for (const rows of shardRows) {
      for (const row of rows) {
        byId.set(row.id, row);
      }
    }

    // forward => newest-first (createdAt DESC), backward => oldest-first (ASC); id is the stable
    // tiebreak (ASCII codepoint, NEVER localeCompare).
    const sign = direction === "forward" ? 1 : -1;
    return Array.from(byId.values())
      .sort((a, b) => {
        const at = a.createdAt.getTime();
        const bt = b.createdAt.getTime();
        if (at !== bt) return at < bt ? sign : -sign;
        return a.id < b.id ? sign : a.id > b.id ? -sign : 0;
      })
      .slice(0, pageSize + 1);
  }

  // Empty-state probe. Split on: probe the new run-ops DB first, then the legacy READ REPLICA only
  // (never the legacy primary), then every configured gen-2 shard in parallel. Split off (single-DB
  // / self-host): one plain `_replica` probe.
  async #probeAnyBatch(environmentId: string): Promise<boolean> {
    // Single-DB / passthrough: `_replica` IS the run-ops database, and it is the SAME client the
    // scan uses, so the empty-state hint can't disagree with the page. Carry the run-ops brand
    // (identical wiring, correct residency) and backstop a split deployment that omitted a routed
    // handle (never the legacy primary).
    const passthrough = this._replica as unknown as RunOpsPrismaClient;

    if (!this.readRoute?.splitEnabled) {
      const onReplica = await passthrough.batchTaskRun.findFirst({
        where: { runtimeEnvironmentId: environmentId },
      });
      return Boolean(onReplica);
    }

    const onNew = await (this.readRoute.runOpsNew ?? passthrough).batchTaskRun.findFirst({
      where: { runtimeEnvironmentId: environmentId },
    });
    if (onNew) {
      return true;
    }

    const onLegacy = await (
      this.readRoute.runOpsLegacyReplica ?? passthrough
    ).batchTaskRun.findFirst({
      where: { runtimeEnvironmentId: environmentId },
    });
    if (onLegacy) {
      return true;
    }

    // The gen-1 pair above keeps its sequential short-circuit — it is two legs, and a project with
    // no batches yet is the common case for this path. The shards then go in ONE round trip instead
    // of N: the probe answers a boolean, so there is no precedence to resolve and nothing to
    // short-circuit for. `RoutingRunStore.#probeFirst` parallelises above two legs for the same
    // reason, though it switches on the TOTAL leg count rather than keeping a sequential head — so
    // an empty project with N shards costs 3 round trips here, not 1.
    const shardReplicas = this.readRoute.shardReplicas ?? [];
    if (shardReplicas.length === 0) {
      return false;
    }

    const onShards = await Promise.all(
      shardReplicas.map((shard) =>
        shard.replica.batchTaskRun.findFirst({
          where: { runtimeEnvironmentId: environmentId },
        })
      )
    );
    return onShards.some(Boolean);
  }

  public async call({
    userId,
    projectId,
    friendlyId,
    statuses,
    environmentId,
    period,
    from,
    to,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
  }: BatchListOptions) {
    //get the time values from the raw values (including a default period)
    const time = timeFilters({
      period,
      from,
      to,
    });

    const hasStatusFilters = statuses && statuses.length > 0;

    const hasFilters = hasStatusFilters || friendlyId !== undefined || !time.isDefault;

    const project = await this.#controlPlaneReplica.project.findFirstOrThrow({
      select: {
        id: true,
        environments: {
          where: { id: environmentId },
          select: {
            id: true,
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
      },
      where: {
        id: projectId,
      },
    });

    const periodMs = time.period ? parse(time.period) : undefined;

    let createdAtGte: Date | undefined;
    if (periodMs != null) {
      createdAtGte = new Date(Date.now() - periodMs);
    }
    if (time.from !== undefined) {
      createdAtGte =
        createdAtGte === undefined
          ? time.from
          : time.from > createdAtGte
            ? time.from
            : createdAtGte;
    }
    const createdAtLte: Date | undefined = time.to;

    // Composite (createdAt, id) keyset — see encodeBatchCursor. An old plain-id cursor decodes to
    // undefined and restarts from page 1.
    const keyCursor = decodeBatchCursor(cursor);

    const batches = await this.#scanBatchTaskRun(pageSize, direction, (client) =>
      client.batchTaskRun.findMany({
        where: {
          runtimeEnvironmentId: environmentId,
          ...(keyCursor
            ? {
                OR:
                  direction === "forward"
                    ? [
                        { createdAt: { lt: keyCursor.createdAt } },
                        { createdAt: keyCursor.createdAt, id: { lt: keyCursor.id } },
                      ]
                    : [
                        { createdAt: { gt: keyCursor.createdAt } },
                        { createdAt: keyCursor.createdAt, id: { gt: keyCursor.id } },
                      ],
              }
            : {}),
          ...(friendlyId ? { friendlyId } : {}),
          ...(statuses && statuses.length > 0
            ? { status: { in: boundedIn(statuses) }, batchVersion: { not: "v1" } }
            : {}),
          ...(createdAtGte !== undefined || createdAtLte !== undefined
            ? {
                createdAt: {
                  ...(createdAtGte !== undefined ? { gte: createdAtGte } : {}),
                  ...(createdAtLte !== undefined ? { lte: createdAtLte } : {}),
                },
              }
            : {}),
        },
        orderBy: [
          { createdAt: direction === "forward" ? "desc" : "asc" },
          { id: direction === "forward" ? "desc" : "asc" },
        ],
        take: pageSize + 1,
        select: {
          id: true,
          friendlyId: true,
          runtimeEnvironmentId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          runCount: true,
          batchVersion: true,
        },
      })
    );

    const hasMore = batches.length > pageSize;

    //get cursors for next and previous pages (composite (createdAt, id) keyset)
    const cur = (row?: BatchRow) => (row ? encodeBatchCursor(row) : undefined);
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? cur(batches.at(0)) : undefined;
        if (hasMore) {
          next = cur(batches[pageSize - 1]);
        }
        break;
      case "backward":
        batches.reverse();
        if (hasMore) {
          previous = cur(batches[1]);
          next = cur(batches[pageSize]);
        } else {
          next = cur(batches[pageSize - 1]);
        }
        break;
    }

    const batchesToReturn =
      direction === "backward" && hasMore
        ? batches.slice(1, pageSize + 1)
        : batches.slice(0, pageSize);

    let hasAnyBatches = batchesToReturn.length > 0;
    if (!hasAnyBatches) {
      hasAnyBatches = await this.#probeAnyBatch(environmentId);
    }

    return {
      batches: batchesToReturn.map((batch) => {
        const environment = project.environments.find(
          (env) => env.id === batch.runtimeEnvironmentId
        );

        if (!environment) {
          throw new Error(`Environment not found for Batch ${batch.id}`);
        }

        const hasFinished = batch.status !== "PENDING" && batch.status !== "PROCESSING";

        return {
          id: batch.id,
          friendlyId: batch.friendlyId,
          createdAt: batch.createdAt.toISOString(),
          updatedAt: batch.updatedAt.toISOString(),
          hasFinished,
          finishedAt: batch.completedAt
            ? batch.completedAt.toISOString()
            : hasFinished
              ? batch.updatedAt.toISOString()
              : undefined,
          status: batch.status,
          environment: displayableEnvironment(environment, userId),
          runCount: Number(batch.runCount),
          batchVersion: batch.batchVersion,
        };
      }),
      pagination: {
        next,
        previous,
      },
      filters: {
        friendlyId,
        statuses: statuses || [],
      },
      hasFilters,
      hasAnyBatches,
    };
  }
}
