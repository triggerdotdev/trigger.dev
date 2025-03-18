import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "~/v3/marqs/index.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";
import { EnvironmentQueuePresenter, type Environment } from "./EnvironmentQueuePresenter.server";

export class QueueListPresenter extends BasePresenter {
  private readonly ITEMS_PER_PAGE = 25;

  public async call({
    environment,
    page,
  }: {
    environment: AuthenticatedEnvironment;
    page: number;
  }) {
    // Get total count for pagination
    const totalQueues = await this._replica.taskQueue.count({
      where: {
        runtimeEnvironmentId: environment.id,
      },
    });

    return {
      queues: this.getQueuesWithPagination(environment, page),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalQueues / this.ITEMS_PER_PAGE),
        totalItems: totalQueues,
        itemsPerPage: this.ITEMS_PER_PAGE,
      },
    };
  }

  private async getQueuesWithPagination(environment: AuthenticatedEnvironment, page: number) {
    const queues = await this._replica.taskQueue.findMany({
      where: {
        runtimeEnvironmentId: environment.id,
      },
      select: {
        name: true,
        concurrencyLimit: true,
        type: true,
      },
      orderBy: {
        name: "asc",
      },
      skip: (page - 1) * this.ITEMS_PER_PAGE,
      take: this.ITEMS_PER_PAGE,
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
    return queues.map((queue) => ({
      name: queue.name.replace(/^task\//, ""),
      type: queue.type,
      running: results[1][queue.name] ?? 0,
      queued: results[0][queue.name] ?? 0,
      concurrencyLimit: queue.concurrencyLimit ?? null,
    }));
  }
}
