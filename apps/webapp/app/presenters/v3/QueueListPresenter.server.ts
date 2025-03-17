import {
  type RuntimeEnvironment,
  type Organization,
  type RuntimeEnvironmentType,
  type TaskQueue,
} from "@trigger.dev/database";
import { QUEUED_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { Prisma, sqlDatabaseSchema } from "~/db.server";
import { type Project } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { type User } from "~/models/user.server";
import { engine } from "~/v3/runEngine.server";
import { concurrencyTracker } from "~/v3/services/taskRunConcurrencyTracker.server";
import { BasePresenter } from "./basePresenter.server";
import { marqs } from "~/v3/marqs/index.server";

export type Environment = Awaited<ReturnType<QueueListPresenter["environmentConcurrency"]>>;

export class QueueListPresenter extends BasePresenter {
  private readonly ITEMS_PER_PAGE = 10;

  public async call({
    userId,
    projectId,
    organizationId,
    environmentSlug,
    page,
  }: {
    userId: User["id"];
    projectId: Project["id"];
    organizationId: Organization["id"];
    environmentSlug: RuntimeEnvironment["slug"];
    page: number;
  }) {
    const environment = await findEnvironmentBySlug(projectId, environmentSlug, userId);
    if (!environment) {
      throw new Error(`Environment not found: ${environmentSlug}`);
    }

    // Get total count for pagination
    const totalQueues = await this._replica.taskQueue.count({
      where: {
        runtimeEnvironmentId: environment.id,
      },
    });

    // Return the environment data immediately and defer the queues
    return {
      environment: this.environmentConcurrency(organizationId, projectId, userId, environment),
      queues: this.getQueuesWithPagination(environment, projectId, organizationId, page),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalQueues / this.ITEMS_PER_PAGE),
        totalItems: totalQueues,
        itemsPerPage: this.ITEMS_PER_PAGE,
      },
    };
  }

  private async getQueuesWithPagination(
    environment: { id: string; type: RuntimeEnvironmentType; maximumConcurrencyLimit: number },
    projectId: string,
    organizationId: string,
    page: number
  ) {
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
        {
          ...environment,
          project: {
            id: projectId,
          },
          organization: {
            id: organizationId,
          },
        },
        queues.map((q) => q.name)
      ),
      engine.currentConcurrencyOfQueues(
        {
          ...environment,
          project: {
            id: projectId,
          },
          organization: {
            id: organizationId,
          },
        },
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

  async environmentConcurrency(
    organizationId: string,
    projectId: string,
    userId: string,
    environment: { id: string; type: RuntimeEnvironmentType; maximumConcurrencyLimit: number }
  ) {
    //executing
    const engineV1Executing = await marqs.currentConcurrencyOfEnvironment({
      ...environment,
      organizationId,
    });
    const engineV2Executing = await engine.concurrencyOfEnvQueue({
      ...environment,
      project: {
        id: projectId,
      },
      organization: {
        id: organizationId,
      },
    });
    const running = (engineV1Executing ?? 0) + (engineV2Executing ?? 0);

    //queued
    const engineV1Queued = await marqs.lengthOfEnvQueue({ ...environment, organizationId });
    const engineV2Queued = await engine.lengthOfEnvQueue({
      ...environment,
      project: {
        id: projectId,
      },
      organization: {
        id: organizationId,
      },
    });
    const queued = (engineV1Queued ?? 0) + (engineV2Queued ?? 0);

    return {
      running,
      queued,
      concurrencyLimit: environment.maximumConcurrencyLimit,
    };
  }
}
