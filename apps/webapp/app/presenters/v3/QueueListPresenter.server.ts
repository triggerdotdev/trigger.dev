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
      queues: this.getQueuesWithPagination(environment.id, page),
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalQueues / this.ITEMS_PER_PAGE),
        totalItems: totalQueues,
        itemsPerPage: this.ITEMS_PER_PAGE,
      },
    };
  }

  private async getQueuesWithPagination(environmentId: string, page: number) {
    const queues = await this._replica.taskQueue.findMany({
      where: {
        runtimeEnvironmentId: environmentId,
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

    // Transform queues to include running and queued counts
    return queues.map((queue) => ({
      name: queue.name,
      concurrencyLimit: queue.concurrencyLimit ?? null,
      type: queue.type,
      queued: 0, // Placeholder
      running: 0, // Placeholder
    }));
  }

  async environmentConcurrency(
    organizationId: string,
    projectId: string,
    userId: string,
    environment: { id: string; type: RuntimeEnvironmentType; maximumConcurrencyLimit: number }
  ) {
    const engineV1Concurrency = await concurrencyTracker.environmentConcurrentRunCounts(projectId, [
      environment.id,
    ]);

    const engineV2Concurrency = await engine.currentConcurrencyOfEnvQueue({
      ...environment,
      project: {
        id: projectId,
      },
      organization: {
        id: organizationId,
      },
    });

    const executing = (engineV1Concurrency[environment.id] ?? 0) + engineV2Concurrency;

    const queued = await this._replica.$queryRaw<
      {
        count: BigInt;
      }[]
    >`
SELECT
    COUNT(*)
FROM
    ${sqlDatabaseSchema}."TaskRun" as tr
WHERE
    tr."projectId" = ${projectId}
    AND tr."runtimeEnvironmentId" = ${environment.id}
    AND tr."status" = ANY(ARRAY[${Prisma.join(QUEUED_STATUSES)}]::\"TaskRunStatus\"[])
GROUP BY
    tr."runtimeEnvironmentId";`;

    return {
      concurrency: executing,
      queued: Number(queued.at(0)?.count ?? 0),
      concurrencyLimit: environment.maximumConcurrencyLimit,
    };
  }
}
