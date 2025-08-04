import { type ClickHouse } from "@internal/clickhouse";
import type { TaskRunStatus } from "@trigger.dev/database";
import { QUEUED_STATUSES } from "~/components/runs/v3/TaskRunStatus";

export type DailyTaskActivity = Record<string, ({ day: string } & Record<TaskRunStatus, number>)[]>;
export type CurrentRunningStats = Record<string, { queued: number; running: number }>;
export type AverageDurations = Record<string, number>;

export interface EnvironmentMetricsRepository {
  getDailyTaskActivity(options: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    days: number;
    tasks: string[];
  }): Promise<DailyTaskActivity>;

  getCurrentRunningStats(options: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    days: number;
    tasks: string[];
  }): Promise<CurrentRunningStats>;

  getAverageDurations(options: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    days: number;
    tasks: string[];
  }): Promise<AverageDurations>;
}

export type ClickHouseEnvironmentMetricsRepositoryOptions = {
  clickhouse: ClickHouse;
};

export class ClickHouseEnvironmentMetricsRepository implements EnvironmentMetricsRepository {
  constructor(private readonly options: ClickHouseEnvironmentMetricsRepositoryOptions) {}

  public async getDailyTaskActivity({
    organizationId,
    projectId,
    environmentId,
    days,
    tasks,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    days: number;
    tasks: string[];
  }): Promise<DailyTaskActivity> {
    if (tasks.length === 0) {
      return {};
    }

    const [queryError, activity] = await this.options.clickhouse.taskRuns.getTaskActivity({
      organizationId,
      projectId,
      environmentId,
      days,
    });

    if (queryError) {
      throw queryError;
    }

    return fillInDailyTaskActivity(
      activity.map((a) => ({
        taskIdentifier: a.task_identifier,
        status: a.status as TaskRunStatus,
        day: new Date(a.day),
        count: BigInt(a.count),
      })),
      days
    );
  }

  public async getCurrentRunningStats({
    organizationId,
    projectId,
    environmentId,
    days,
    tasks,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    days: number;
    tasks: string[];
  }): Promise<CurrentRunningStats> {
    if (tasks.length === 0) {
      return {};
    }

    const [queryError, stats] = await this.options.clickhouse.taskRuns.getCurrentRunningStats({
      organizationId,
      projectId,
      environmentId,
      days,
    });

    if (queryError) {
      throw queryError;
    }

    return fillInCurrentRunningStats(
      stats.map((s) => ({
        taskIdentifier: s.task_identifier,
        status: s.status as TaskRunStatus,
        count: BigInt(s.count),
      })),
      tasks
    );
  }

  public async getAverageDurations({
    organizationId,
    projectId,
    environmentId,
    days,
    tasks,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    days: number;
    tasks: string[];
  }): Promise<AverageDurations> {
    if (tasks.length === 0) {
      return {};
    }

    const [queryError, durations] = await this.options.clickhouse.taskRuns.getAverageDurations({
      organizationId,
      projectId,
      environmentId,
      days,
    });

    if (queryError) {
      throw queryError;
    }

    return Object.fromEntries(durations.map((d) => [d.task_identifier, Number(d.duration)]));
  }
}

type TaskActivityResults = Array<{
  taskIdentifier: string;
  status: TaskRunStatus;
  day: Date;
  count: BigInt;
}>;

function fillInDailyTaskActivity(activity: TaskActivityResults, days: number): DailyTaskActivity {
  //today with no time
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  return activity.reduce((acc, a) => {
    let existingTask = acc[a.taskIdentifier];

    if (!existingTask) {
      existingTask = [];
      //populate the array with the past 7 days
      for (let i = days; i >= 0; i--) {
        const day = new Date(today);
        day.setUTCDate(today.getDate() - i);
        day.setUTCHours(0, 0, 0, 0);

        existingTask.push({
          day: day.toISOString(),
          ["COMPLETED_SUCCESSFULLY"]: 0,
        } as { day: string } & Record<TaskRunStatus, number>);
      }

      acc[a.taskIdentifier] = existingTask;
    }

    const dayString = a.day.toISOString();
    const day = existingTask.find((d) => d.day === dayString);

    if (!day) {
      return acc;
    }

    day[a.status] = Number(a.count);

    return acc;
  }, {} as DailyTaskActivity);
}

type CurrentRunningStatsResults = Array<{
  taskIdentifier: string;
  status: TaskRunStatus;
  count: BigInt;
}>;

function fillInCurrentRunningStats(
  stats: CurrentRunningStatsResults,
  tasks: string[]
): CurrentRunningStats {
  //create an object combining the queued and concurrency counts
  const result: Record<string, { queued: number; running: number }> = {};
  for (const task of tasks) {
    const queued = stats.filter(
      (q) => q.taskIdentifier === task && QUEUED_STATUSES.includes(q.status)
    );
    const queuedCount =
      queued.length === 0
        ? 0
        : queued.reduce((acc, q) => {
            return acc + Number(q.count);
          }, 0);

    const running = stats.filter((r) => r.taskIdentifier === task && r.status === "EXECUTING");
    const runningCount =
      running.length === 0
        ? 0
        : running.reduce((acc, r) => {
            return acc + Number(r.count);
          }, 0);

    result[task] = {
      queued: queuedCount,
      running: runningCount,
    };
  }
  return result;
}
