import type { RunEngine } from "@internal/run-engine";
import type { Prisma } from "@trigger.dev/database";
import { TaskQueueType, boundedIn } from "@trigger.dev/database";
import { type PrismaClientOrTransaction } from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";
import { toQueueItem } from "./QueueRetrievePresenter.server";

type QueueListEngine = Pick<RunEngine, "lengthOfQueues" | "currentConcurrencyOfQueues">;

export const QUEUE_LIST_DEFAULT_ITEMS_PER_PAGE = 25;
const MAX_ITEMS_PER_PAGE = 100;

export type QueueListSort = "busiest" | "queued" | "name";

/** Ranking reads recent aggregated gauges, so ordering is a stable snapshot, not a live sort. */
const QUEUE_RANKING_WINDOW_MINUTES = 15;
const MAX_RANKED_QUEUES = 5000;

const typeToDBQueueType: Record<"task" | "custom", TaskQueueType> = {
  task: TaskQueueType.VIRTUAL,
  custom: TaskQueueType.NAMED,
};

const queueListSelect = {
  friendlyId: true,
  name: true,
  orderableName: true,
  concurrencyLimit: true,
  concurrencyLimitBase: true,
  concurrencyLimitOverriddenAt: true,
  concurrencyLimitOverriddenBy: true,
  concurrencyLimitOverridePercent: true,
  type: true,
  paused: true,
} satisfies Prisma.TaskQueueSelect;

type QueueListRow = Prisma.TaskQueueGetPayload<{ select: typeof queueListSelect }>;

// The percent source-of-truth for percent-based overrides isn't part of the shared `QueueItem`
// schema (that's a public contract), so we surface it as an extra field on the list item.
type QueueListItem = ReturnType<typeof toQueueItem> & {
  concurrencyLimitOverridePercent: number | null;
};

type QueueListPagination =
  | { mode: "filtered"; currentPage: number; hasMore: boolean }
  | { mode: "unfiltered"; currentPage: number; totalPages: number; count: number };

export type QueueListResult = {
  queues: QueueListItem[];
  pagination: QueueListPagination;
  totalQueues?: number;
  hasFilters: boolean;
};

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function buildQueueListWhere(
  environmentId: string,
  query: string | undefined,
  type: "task" | "custom" | undefined
): Prisma.TaskQueueWhereInput {
  const trimmedQuery = query?.trim();

  return {
    runtimeEnvironmentId: environmentId,
    version: "V2",
    name: trimmedQuery
      ? {
          contains: trimmedQuery,
          mode: "insensitive",
        }
      : undefined,
    type: type ? typeToDBQueueType[type] : undefined,
  };
}

export class QueueListPresenter extends BasePresenter {
  private readonly perPage: number;
  private readonly engineClient: QueueListEngine;

  constructor(
    perPage: number = QUEUE_LIST_DEFAULT_ITEMS_PER_PAGE,
    prismaClient?: PrismaClientOrTransaction,
    replicaClient?: PrismaClientOrTransaction,
    engineClient: QueueListEngine = engine
  ) {
    super(prismaClient, replicaClient);
    this.perPage = Math.min(perPage, MAX_ITEMS_PER_PAGE);
    this.engineClient = engineClient;
  }

  public async call({
    environment,
    query,
    page,
    type,
    sort = "name",
  }: {
    environment: AuthenticatedEnvironment;
    query?: string;
    page: number;
    perPage?: number;
    type?: "task" | "custom";
    sort?: QueueListSort;
  }): Promise<QueueListResult> {
    const hasFilters = Boolean(query?.trim()) || type !== undefined;

    if (sort !== "name") {
      // Ranking is additive: any failure or unsupported input falls back to name order.
      try {
        const ranked = await this.getRankedQueues(environment, query, page, type, sort);
        if (ranked) {
          return ranked;
        }
      } catch (error) {
        logger.warn("Queue ranking unavailable, falling back to name order", { error });
      }
    }

    if (hasFilters) {
      const { queues, hasMore } = await this.getFilteredQueues(environment, query, page, type);

      return {
        queues,
        pagination: {
          mode: "filtered" as const,
          currentPage: page,
          hasMore,
        },
        hasFilters,
      };
    }

    const totalQueues = await this._replica.taskQueue.count({
      where: buildQueueListWhere(environment.id, query, type),
    });

    return {
      queues: await this.getUnfilteredQueues(environment, page, type),
      pagination: {
        mode: "unfiltered" as const,
        currentPage: page,
        totalPages: Math.ceil(totalQueues / this.perPage),
        count: totalQueues,
      },
      totalQueues,
      hasFilters,
    };
  }

  /**
   * ClickHouse ranks queues by recent activity and returns the requested page of names;
   * queues with no recent metrics follow in name order. Null when ranking does not apply.
   */
  private async getRankedQueues(
    environment: AuthenticatedEnvironment,
    query: string | undefined,
    page: number,
    type: "task" | "custom" | undefined,
    sort: Exclude<QueueListSort, "name">
  ) {
    if (type !== undefined) {
      return null;
    }

    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      environment.organizationId,
      "queueMetrics"
    );

    // The window start is aligned to the minute so repeated page loads produce identical
    // query text and can share ClickHouse query-cache entries.
    const windowStartMs =
      Math.floor((Date.now() - QUEUE_RANKING_WINDOW_MINUTES * 60 * 1000) / 60_000) * 60_000;
    const rankingArgs = {
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
      startTime: formatClickhouseDateTime(new Date(windowStartMs)),
      nameContains: query?.trim() ?? "",
    };

    const offset = (page - 1) * this.perPage;

    // One scan returns the page and the total ranked count (window function).
    const [pageError, pageRows] = await clickhouse.queueMetrics.ranking({
      ...rankingArgs,
      byQueuedOnly: sort === "queued" ? 1 : 0,
      limit: this.perPage,
      offset,
    });
    if (pageError) {
      throw pageError;
    }

    let ranked = pageRows?.[0]?.ranked_total ?? 0;
    if (ranked === 0 && offset > 0) {
      // Empty page past the ranked head: fetch the count alone for the tail slot math.
      const [countError, countRows] = await clickhouse.queueMetrics.rankingCount(rankingArgs);
      if (countError) {
        throw countError;
      }
      ranked = countRows?.[0]?.ranked ?? 0;
    }
    if (ranked > MAX_RANKED_QUEUES) {
      return null;
    }

    const where = buildQueueListWhere(environment.id, query, type);
    const totalQueues = await this._replica.taskQueue.count({ where });

    let rankedPageQueues: QueueListRow[] = [];
    if ((pageRows?.length ?? 0) > 0) {
      const rankedNames = (pageRows ?? []).map((row) => row.queue_name);
      rankedPageQueues = await this.findQueuesByNames(where, rankedNames);
    }

    // Tail of the page: name-ordered queues that have no recent metrics. Slot math uses the
    // ClickHouse counts so pages never overlap, even if some ranked names no longer exist.
    const rankedSlots = Math.min(Math.max(ranked - offset, 0), this.perPage);
    const tailNeeded = this.perPage - rankedSlots;
    let tailQueues: QueueListRow[] = [];
    if (tailNeeded > 0) {
      let excludedNames: string[] = [];
      if (ranked > 0) {
        const [allError, allRows] = await clickhouse.queueMetrics.rankingNames({
          ...rankingArgs,
          limit: MAX_RANKED_QUEUES,
        });
        if (allError) {
          throw allError;
        }
        excludedNames = (allRows ?? []).map((row) => row.queue_name);
      }
      // AND keeps the search's name filter intact alongside the exclusion (a spread
      // would overwrite one name condition with the other).
      tailQueues = await this._replica.taskQueue.findMany({
        where: { AND: [where, { name: { notIn: boundedIn(excludedNames) } }] },
        select: queueListSelect,
        orderBy: {
          orderableName: "asc",
        },
        skip: Math.max(0, offset - ranked),
        take: tailNeeded,
      });
    }

    return {
      queues: await this.enrichQueues(environment, [...rankedPageQueues, ...tailQueues]),
      pagination: {
        mode: "unfiltered" as const,
        currentPage: page,
        totalPages: Math.max(1, Math.ceil(totalQueues / this.perPage)),
        count: totalQueues,
      },
      totalQueues,
      hasFilters: Boolean(query?.trim()) || type !== undefined,
    };
  }

  private async findQueuesByNames(
    where: Prisma.TaskQueueWhereInput,
    names: string[]
  ): Promise<QueueListRow[]> {
    if (names.length === 0) {
      return [];
    }
    const queues = await this._replica.taskQueue.findMany({
      where: { AND: [where, { name: { in: boundedIn(names) } }] },
      select: queueListSelect,
    });
    const byName = new Map(queues.map((queue) => [queue.name, queue]));
    return names.flatMap((name) => byName.get(name) ?? []);
  }

  private async getFilteredQueues(
    environment: AuthenticatedEnvironment,
    query: string | undefined,
    page: number,
    type: "task" | "custom" | undefined
  ) {
    const queues = await this._replica.taskQueue.findMany({
      where: buildQueueListWhere(environment.id, query, type),
      select: queueListSelect,
      orderBy: {
        orderableName: "asc",
      },
      skip: (page - 1) * this.perPage,
      take: this.perPage + 1,
    });

    const hasMore = queues.length > this.perPage;

    return {
      queues: await this.enrichQueues(environment, queues.slice(0, this.perPage)),
      hasMore,
    };
  }

  private async getUnfilteredQueues(
    environment: AuthenticatedEnvironment,
    page: number,
    type: "task" | "custom" | undefined
  ) {
    const queues = await this._replica.taskQueue.findMany({
      where: buildQueueListWhere(environment.id, undefined, type),
      select: queueListSelect,
      orderBy: {
        orderableName: "asc",
      },
      skip: (page - 1) * this.perPage,
      take: this.perPage,
    });

    return this.enrichQueues(environment, queues);
  }

  private async enrichQueues(
    environment: AuthenticatedEnvironment,
    queues: {
      friendlyId: string;
      name: string;
      orderableName: string | null;
      concurrencyLimit: number | null;
      concurrencyLimitBase: number | null;
      concurrencyLimitOverriddenAt: Date | null;
      concurrencyLimitOverriddenBy: string | null;
      concurrencyLimitOverridePercent: Prisma.Decimal | null;
      type: TaskQueueType;
      paused: boolean;
    }[]
  ): Promise<QueueListItem[]> {
    const [queuedByQueue, runningByQueue] = await Promise.all([
      this.engineClient.lengthOfQueues(
        environment,
        queues.map((q) => q.name)
      ),
      this.engineClient.currentConcurrencyOfQueues(
        environment,
        queues.map((q) => q.name)
      ),
    ]);

    // Manually "join" the overridden users because there is no way to implement the relationship
    // in prisma without adding a foreign key constraint
    const overriddenByIds = queues.map((q) => q.concurrencyLimitOverriddenBy).filter(Boolean);
    const overriddenByUsers = await this._replica.user.findMany({
      where: {
        id: { in: boundedIn(overriddenByIds) },
      },
    });

    const overriddenByMap = new Map(overriddenByUsers.map((u) => [u.id, u]));

    return queues.map((queue) => ({
      ...toQueueItem({
        friendlyId: queue.friendlyId,
        name: queue.name,
        type: queue.type,
        running: runningByQueue[queue.name] ?? 0,
        queued: queuedByQueue[queue.name] ?? 0,
        concurrencyLimit: queue.concurrencyLimit ?? null,
        concurrencyLimitBase: queue.concurrencyLimitBase ?? null,
        concurrencyLimitOverriddenAt: queue.concurrencyLimitOverriddenAt ?? null,
        concurrencyLimitOverriddenBy: queue.concurrencyLimitOverriddenBy
          ? (overriddenByMap.get(queue.concurrencyLimitOverriddenBy) ?? null)
          : null,
        paused: queue.paused,
      }),
      // Prisma returns Decimal; the client only needs a plain number (null for absolute overrides).
      concurrencyLimitOverridePercent:
        queue.concurrencyLimitOverridePercent !== null
          ? Number(queue.concurrencyLimitOverridePercent)
          : null,
    }));
  }
}
