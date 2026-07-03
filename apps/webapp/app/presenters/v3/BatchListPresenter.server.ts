import { type BatchTaskRunStatus } from "@trigger.dev/database";
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
export type BatchListItem = BatchList["batches"][0];
export type BatchListAppliedFilters = BatchList["filters"];

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

export class BatchListPresenter extends BasePresenter {
  // Optional run-ops read-routing. Omitted (single-DB / self-host) => everything
  // reads from `_replica` exactly as today (passthrough). Field names are local to
  // this presenter; only the read-routing convention (optional handles, default-to-_replica,
  // boot-constant splitEnabled) is mirrored, not the literal RunsRepositoryOptions names.
  constructor(
    prismaClient?: PrismaClientOrTransaction,
    replicaClient?: PrismaClientOrTransaction,
    private readonly readRoute?: {
      runOpsNew?: PrismaClientOrTransaction; // new run-ops client
      runOpsLegacyReplica?: PrismaClientOrTransaction; // legacy run-ops READ REPLICA only — never the legacy primary
      controlPlaneReplica?: PrismaClientOrTransaction; // control-plane DB (for project)
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
    scan: (client: PrismaClientOrTransaction) => Promise<BatchRow[]>
  ): Promise<BatchRow[]> {
    if (!this.readRoute?.splitEnabled) {
      return scan(this._replica);
    }

    const newRows = await scan(this.readRoute.runOpsNew ?? this._replica);

    // New DB filled the page — skip the legacy read entirely; older rows fall on a later page.
    if (newRows.length >= pageSize + 1) {
      return newRows;
    }

    const legacyRows = await scan(this.readRoute.runOpsLegacyReplica ?? this._replica);

    // De-dupe by id (new wins), re-sort under the page's keyset order, re-apply the over-fetch
    // LIMIT — reproduces the pageSize+1 window a single union scan would return.
    const byId = new Map<string, BatchRow>();
    for (const row of newRows) {
      byId.set(row.id, row);
    }
    for (const row of legacyRows) {
      if (!byId.has(row.id)) {
        byId.set(row.id, row);
      }
    }

    // codepoint comparator (NEVER localeCompare): BatchTaskRun.id is ASCII (cuid or ksuid).
    const sign = direction === "forward" ? 1 : -1; // forward => DESC; backward => ASC
    return Array.from(byId.values())
      .sort((a, b) => (a.id < b.id ? sign : a.id > b.id ? -sign : 0))
      .slice(0, pageSize + 1);
  }

  // Empty-state probe. Split on: probe the new run-ops DB first, then the legacy READ REPLICA only
  // (never the legacy primary). Split off (single-DB / self-host): one plain `_replica` probe.
  async #probeAnyBatch(environmentId: string): Promise<boolean> {
    // Passthrough: probe the SAME client the scan uses (_replica), or the empty-state hint can
    // disagree with the page when a run-ops DB is configured but read-split is off.
    if (!this.readRoute?.splitEnabled) {
      const onReplica = await this._replica.batchTaskRun.findFirst({
        where: { runtimeEnvironmentId: environmentId },
      });
      return Boolean(onReplica);
    }

    const onNew = await (this.readRoute.runOpsNew ?? this._replica).batchTaskRun.findFirst({
      where: { runtimeEnvironmentId: environmentId },
    });
    if (onNew) {
      return true;
    }

    const onLegacy = await (
      this.readRoute.runOpsLegacyReplica ?? this._replica
    ).batchTaskRun.findFirst({
      where: { runtimeEnvironmentId: environmentId },
    });
    return Boolean(onLegacy);
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

    const batches = await this.#scanBatchTaskRun(pageSize, direction, (client) =>
      client.batchTaskRun.findMany({
        where: {
          runtimeEnvironmentId: environmentId,
          ...(cursor ? { id: direction === "forward" ? { lt: cursor } : { gt: cursor } } : {}),
          ...(friendlyId ? { friendlyId } : {}),
          ...(statuses && statuses.length > 0
            ? { status: { in: statuses }, batchVersion: { not: "v1" } }
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
        orderBy: { id: direction === "forward" ? "desc" : "asc" },
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

    //get cursors for next and previous pages
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? batches.at(0)?.id : undefined;
        if (hasMore) {
          next = batches[pageSize - 1]?.id;
        }
        break;
      case "backward":
        batches.reverse();
        if (hasMore) {
          previous = batches[1]?.id;
          next = batches[pageSize]?.id;
        } else {
          next = batches[pageSize - 1]?.id;
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
