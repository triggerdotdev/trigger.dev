import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "~/v3/marqs/index.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";

export type Environment = Awaited<ReturnType<QueueListPresenter["environmentConcurrency"]>>;

export class QueueListPresenter extends BasePresenter {
  private readonly ITEMS_PER_PAGE = 10;

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

    // Return the environment data immediately and defer the queues
    return {
      environment: this.environmentConcurrency(environment),
      queues: this.getQueuesWithPagination(
        environment,

        page
      ),
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

  async environmentConcurrency(environment: AuthenticatedEnvironment) {
    //executing
    const engineV1Executing = await marqs.currentConcurrencyOfEnvironment(environment);
    const engineV2Executing = await engine.concurrencyOfEnvQueue(environment);
    const running = (engineV1Executing ?? 0) + (engineV2Executing ?? 0);

    //queued
    const engineV1Queued = await marqs.lengthOfEnvQueue(environment);
    const engineV2Queued = await engine.lengthOfEnvQueue(environment);
    const queued = (engineV1Queued ?? 0) + (engineV2Queued ?? 0);

    return {
      running,
      queued,
      concurrencyLimit: environment.maximumConcurrencyLimit,
    };
  }
}
