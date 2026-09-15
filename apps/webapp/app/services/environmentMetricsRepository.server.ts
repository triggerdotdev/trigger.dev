import { type ClickHouse } from "@internal/clickhouse";
import type { TaskRunStatus } from "@trigger.dev/database";
import { QUEUED_STATUSES } from "~/components/runs/v3/TaskRunStatus";

export type CurrentRunningStats = Record<string, { queued: number; running: number }>;

interface EnvironmentMetricsRepository {
  getCurrentRunningStats(options: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    days: number;
    tasks: string[];
  }): Promise<CurrentRunningStats>;
}

export type ClickHouseEnvironmentMetricsRepositoryOptions = {
  clickhouse: ClickHouse;
};

export class ClickHouseEnvironmentMetricsRepository implements EnvironmentMetricsRepository {
  constructor(private readonly options: ClickHouseEnvironmentMetricsRepositoryOptions) {}

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
}

type CurrentRunningStatsResults = Array<{
  taskIdentifier: string;
  status: TaskRunStatus;
  count: bigint;
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
