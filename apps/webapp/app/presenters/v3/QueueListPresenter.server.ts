import type { RunEngine } from "@internal/run-engine";
import { Prisma, TaskQueueType } from "@trigger.dev/database";
import { type PrismaClientOrTransaction } from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";
import { toQueueItem } from "./QueueRetrievePresenter.server";
import type { QueueListPagination } from "./queueListPagination.server";

type QueueListEngine = Pick<RunEngine, "lengthOfQueues" | "currentConcurrencyOfQueues">;

export const QUEUE_LIST_DEFAULT_ITEMS_PER_PAGE = 25;
const MAX_ITEMS_PER_PAGE = 100;

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
  type: true,
  paused: true,
} satisfies Prisma.TaskQueueSelect;

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
  }: {
    environment: AuthenticatedEnvironment;
    query?: string;
    page: number;
    perPage?: number;
    type?: "task" | "custom";
  }) {
    const hasFilters = Boolean(query?.trim()) || type !== undefined;

    const engineVersion = await determineEngineVersion({ environment });
    if (engineVersion === "V1") {
      const totalQueues = await this._replica.taskQueue.count({
        where: buildQueueListWhere(environment.id, query, type),
      });

      if (totalQueues === 0) {
        const oldQueue = await this._replica.taskQueue.findFirst({
          where: {
            runtimeEnvironmentId: environment.id,
            version: "V1",
          },
        });
        if (oldQueue) {
          return {
            success: false as const,
            code: "engine-version",
            totalQueues: 1,
            hasFilters,
          };
        }
      }

      return {
        success: false as const,
        code: "engine-version",
        totalQueues,
        hasFilters,
      };
    }

    if (hasFilters) {
      const { queues, hasMore } = await this.getFilteredQueues(environment, query, page, type);

      return {
        success: true as const,
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
      success: true as const,
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
      type: TaskQueueType;
      paused: boolean;
    }[]
  ) {
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
        id: { in: overriddenByIds },
      },
    });

    const overriddenByMap = new Map(overriddenByUsers.map((u) => [u.id, u]));

    return queues.map((queue) =>
      toQueueItem({
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
      })
    );
  }
}
