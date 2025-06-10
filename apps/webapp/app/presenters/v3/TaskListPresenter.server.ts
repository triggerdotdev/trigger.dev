import {
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  type TaskTriggerSource,
} from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import {
  AverageDurations,
  ClickHouseEnvironmentMetricsRepository,
  CurrentRunningStats,
  DailyTaskActivity,
  EnvironmentMetricsRepository,
  PostgrestEnvironmentMetricsRepository,
} from "~/services/environmentMetricsRepository.server";
import { singleton } from "~/utils/singleton";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";

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

  public async call({
    environmentId,
    environmentType,
  }: {
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
  }) {
    const currentWorker = await findCurrentWorkerFromEnvironment(
      {
        id: environmentId,
        type: environmentType,
      },
      this._replica
    );

    if (!currentWorker) {
      return {
        tasks: [],
        activity: Promise.resolve({} as DailyTaskActivity),
        runningStats: Promise.resolve({} as CurrentRunningStats),
        durations: Promise.resolve({} as AverageDurations),
      };
    }

    const tasks = await this._replica.backgroundWorkerTask.findMany({
      where: {
        workerId: currentWorker.id,
      },
      select: {
        id: true,
        slug: true,
        filePath: true,
        triggerSource: true,
        createdAt: true,
      },
      orderBy: {
        slug: "asc",
      },
    });

    const slugs = tasks.map((t) => t.slug);

    // IMPORTANT: Don't await these, we want to return the promises
    // so we can defer the loading of the data
    const activity = this.environmentMetricsRepository.getDailyTaskActivity({
      environmentId,
      days: 6, // This actually means 7 days, because we want to show the current day too
      tasks: slugs,
    });

    const runningStats = this.environmentMetricsRepository.getCurrentRunningStats({
      environmentId,
      days: 6,
      tasks: slugs,
    });

    const durations = this.environmentMetricsRepository.getAverageDurations({
      environmentId,
      days: 6,
      tasks: slugs,
    });

    return { tasks, activity, runningStats, durations };
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
