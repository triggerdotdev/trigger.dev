import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction, type TaskTriggerSource } from "@trigger.dev/database";
import { $replica, sqlDatabaseSchema } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import {
  ClickHouseEnvironmentMetricsRepository,
  DailyTaskActivity,
  EnvironmentMetricsRepository,
  PostgrestEnvironmentMetricsRepository,
} from "~/services/environmentMetricsRepository.server";
import { singleton } from "~/utils/singleton";

export type TaskListItem = {
  slug: string;
  filePath: string;
  createdAt: Date;
  triggerSource: TaskTriggerSource;
};

export type TaskActivity = DailyTaskActivity[string];

export class TaskListPresenter {
  constructor(
    private readonly environmentMetricsRepository: EnvironmentMetricsRepository,
    private readonly _replica: PrismaClientOrTransaction
  ) {}

  public async call({ environmentId, projectId }: { environmentId: string; projectId: string }) {
    const tasks = await this._replica.$queryRaw<
      {
        id: string;
        slug: string;
        filePath: string;
        createdAt: Date;
        triggerSource: TaskTriggerSource;
      }[]
    >`
    WITH non_dev_workers AS (
      SELECT wd."workerId" AS id
      FROM ${sqlDatabaseSchema}."WorkerDeploymentPromotion" wdp
      INNER JOIN ${sqlDatabaseSchema}."WorkerDeployment" wd
        ON wd.id = wdp."deploymentId"
      WHERE wdp."environmentId" = ${environmentId}
        AND wdp."label" = ${CURRENT_DEPLOYMENT_LABEL}
    ),
    workers AS (
      SELECT DISTINCT ON ("runtimeEnvironmentId") id, "runtimeEnvironmentId", version
      FROM ${sqlDatabaseSchema}."BackgroundWorker"
      WHERE "runtimeEnvironmentId" = ${environmentId}
        OR id IN (SELECT id FROM non_dev_workers)
      ORDER BY "runtimeEnvironmentId", "createdAt" DESC
    )
    SELECT tasks.id, slug, "filePath", "triggerSource", tasks."runtimeEnvironmentId", tasks."createdAt"
    FROM workers
    JOIN ${sqlDatabaseSchema}."BackgroundWorkerTask" tasks ON tasks."workerId" = workers.id
    ORDER BY slug ASC;`;

    //then get the activity for each task
    const activity = this.#getActivity(
      tasks.map((t) => t.slug),
      environmentId
    );

    const runningStats = this.#getRunningStats(
      tasks.map((t) => t.slug),
      environmentId
    );

    const durations = this.#getAverageDurations(
      tasks.map((t) => t.slug),
      environmentId
    );

    return { tasks, activity, runningStats, durations };
  }

  async #getActivity(tasks: string[], environmentId: string) {
    return this.environmentMetricsRepository.getDailyTaskActivity({
      environmentId,
      days: 6,
      tasks,
    });
  }

  async #getRunningStats(tasks: string[], environmentId: string) {
    return this.environmentMetricsRepository.getCurrentRunningStats({
      environmentId,
      days: 6,
      tasks,
    });
  }

  async #getAverageDurations(tasks: string[], environmentId: string) {
    return this.environmentMetricsRepository.getAverageDurations({
      environmentId,
      days: 6,
      tasks,
    });
  }
}

export const taskListPresenter = singleton("taskListPresenter", setupTaskListPresenter);

function setupTaskListPresenter() {
  const environmentMetricsRepository = clickhouseClient
    ? new ClickHouseEnvironmentMetricsRepository({
        clickhouse: clickhouseClient,
      })
    : new PostgrestEnvironmentMetricsRepository({
        prisma: $replica,
      });

  return new TaskListPresenter(environmentMetricsRepository, $replica);
}
