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
    page,
  }: {
    environment: AuthenticatedEnvironment;
    page: number;
    perPage?: number;
  }) {
    //check the engine is the correct version
    const engineVersion = await determineEngineVersion({ environment });

    if (engineVersion === "V1") {
      return {
        success: false as const,
        code: "engine-version",
      };
    }

    // Get total count for pagination
    const totalQueues = await this._replica.taskQueue.count({
      where: {
        runtimeEnvironmentId: environment.id,
      },
    });

    return {
      success: true as const,
      queues: await this.getQueuesWithPagination(environment, page),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalQueues / this.perPage),
        count: totalQueues,
      },
    };
  }

  private async getQueuesWithPagination(environment: AuthenticatedEnvironment, page: number) {
    const queues = await this._replica.taskQueue.findMany({
      where: {
        runtimeEnvironmentId: environment.id,
      },
      select: {
        friendlyId: true,
        name: true,
        concurrencyLimit: true,
        type: true,
        paused: true,
      },
      orderBy: {
        name: "asc",
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
      })
    );
  }
}
