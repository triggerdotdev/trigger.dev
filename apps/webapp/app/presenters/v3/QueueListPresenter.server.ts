import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";
import { toQueueItem } from "./QueueRetrievePresenter.server";

const DEFAULT_ITEMS_PER_PAGE = 25;
const MAX_ITEMS_PER_PAGE = 100;
export class QueueListPresenter extends BasePresenter {
  private readonly perPage: number;

  constructor(perPage: number = DEFAULT_ITEMS_PER_PAGE) {
    super();
    this.perPage = Math.min(perPage, MAX_ITEMS_PER_PAGE);
  }

  public async call({
    environment,
    query,
    page,
  }: {
    environment: AuthenticatedEnvironment;
    query?: string;
    page: number;
    perPage?: number;
  }) {
    const hasFilters = query !== undefined && query.length > 0;

    // Get total count for pagination
    const totalQueues = await this._replica.taskQueue.count({
      where: {
        runtimeEnvironmentId: environment.id,
        version: "V2",
        name: query
          ? {
              contains: query,
              mode: "insensitive",
            }
          : undefined,
      },
    });

    //check the engine is the correct version
    const engineVersion = await determineEngineVersion({ environment });
    if (engineVersion === "V1") {
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

    return {
      success: true as const,
      queues: await this.getQueuesWithPagination(environment, query, page),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalQueues / this.perPage),
        count: totalQueues,
      },
      totalQueues,
      hasFilters,
    };
  }

  private async getQueuesWithPagination(
    environment: AuthenticatedEnvironment,
    query: string | undefined,
    page: number
  ) {
    const queues = await this._replica.taskQueue.findMany({
      where: {
        runtimeEnvironmentId: environment.id,
        version: "V2",
        name: query
          ? {
              contains: query,
              mode: "insensitive",
            }
          : undefined,
      },
      select: {
        friendlyId: true,
        name: true,
        orderableName: true,
        concurrencyLimit: true,
        type: true,
        paused: true,
        releaseConcurrencyOnWaitpoint: true,
      },
      orderBy: {
        orderableName: "asc",
      },
      skip: (page - 1) * this.perPage,
      take: this.perPage,
    });

    const results = await Promise.all([
      engine.lengthOfQueues(
        environment,
        queues.map((q) => q.name)
      ),
      engine.currentConcurrencyOfQueues(
        environment,
        queues.map((q) => q.name)
      ),
    ]);

    // Transform queues to include running and queued counts
    return queues.map((queue) =>
      toQueueItem({
        friendlyId: queue.friendlyId,
        name: queue.name,
        type: queue.type,
        running: results[1][queue.name] ?? 0,
        queued: results[0][queue.name] ?? 0,
        concurrencyLimit: queue.concurrencyLimit ?? null,
        paused: queue.paused,
        releaseConcurrencyOnWaitpoint: queue.releaseConcurrencyOnWaitpoint,
      })
    );
  }
}
