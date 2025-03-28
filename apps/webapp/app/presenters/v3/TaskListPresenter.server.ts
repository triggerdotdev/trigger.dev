import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import {
  Prisma,
  type TaskRunStatus as DBTaskRunStatus,
  type TaskRunStatus as TaskRunStatusType,
  type TaskTriggerSource,
} from "@trigger.dev/database";
import { QUEUED_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { TaskRunStatus } from "~/database-types";
import { sqlDatabaseSchema } from "~/db.server";
import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";

export type TaskListItem = {
  slug: string;
  filePath: string;
  createdAt: Date;
  triggerSource: TaskTriggerSource;
};

type Return = Awaited<ReturnType<TaskListPresenter["call"]>>;

export type TaskActivity = Awaited<Return["activity"]>[string];

export class TaskListPresenter extends BasePresenter {
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
      projectId,
      environmentId
    );

    const runningStats = this.#getRunningStats(
      tasks.map((t) => t.slug),
      projectId,
      environmentId
    );

    const durations = this.#getAverageDurations(
      tasks.map((t) => t.slug),
      projectId,
      environmentId
    );

    return { tasks, activity, runningStats, durations };
  }

  async #getActivity(tasks: string[], projectId: string, environmentId: string) {
    if (tasks.length === 0) {
      return {};
    }

    const activity = await this._replica.$queryRaw<
      {
        taskIdentifier: string;
        status: TaskRunStatusType;
        day: Date;
        count: BigInt;
      }[]
    >`
    SELECT
    tr."taskIdentifier",
    tr."status",
    DATE(tr."createdAt") as day,
    COUNT(*)
  FROM
    ${sqlDatabaseSchema}."TaskRun" as tr
  WHERE
    tr."taskIdentifier" IN (${Prisma.join(tasks)})
    AND tr."projectId" = ${projectId}
    AND tr."runtimeEnvironmentId" = ${environmentId}
    AND tr."createdAt" >= (current_date - interval '6 days')
  GROUP BY
    tr."taskIdentifier",
    tr."status",
    day
  ORDER BY
    tr."taskIdentifier" ASC,
    day ASC,
    tr."status" ASC;`;

    //today with no time
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    return activity.reduce((acc, a) => {
      let existingTask = acc[a.taskIdentifier];

      if (!existingTask) {
        existingTask = [];
        //populate the array with the past 7 days
        for (let i = 6; i >= 0; i--) {
          const day = new Date(today);
          day.setUTCDate(today.getDate() - i);
          day.setUTCHours(0, 0, 0, 0);

          existingTask.push({
            day: day.toISOString(),
            [TaskRunStatus.COMPLETED_SUCCESSFULLY]: 0,
          } as { day: string } & Record<TaskRunStatusType, number>);
        }

        acc[a.taskIdentifier] = existingTask;
      }

      const dayString = a.day.toISOString();
      const day = existingTask.find((d) => d.day === dayString);

      if (!day) {
        logger.warn(`Day not found for TaskRun`, {
          day: dayString,
          taskIdentifier: a.taskIdentifier,
          existingTask,
        });
        return acc;
      }

      day[a.status] = Number(a.count);

      return acc;
    }, {} as Record<string, ({ day: string } & Record<TaskRunStatusType, number>)[]>);
  }

  async #getRunningStats(tasks: string[], projectId: string, environmentId: string) {
    if (tasks.length === 0) {
      return {};
    }

    const stats = await this._replica.$queryRaw<
      {
        taskIdentifier: string;
        status: DBTaskRunStatus;
        count: BigInt;
      }[]
    >`
    SELECT
    tr."taskIdentifier",
    tr.status,
    COUNT(*)
  FROM
    ${sqlDatabaseSchema}."TaskRun" as tr
  WHERE
    tr."taskIdentifier" IN (${Prisma.join(tasks)})
    AND tr."projectId" = ${projectId}
    AND tr."runtimeEnvironmentId" = ${environmentId}
    AND tr."status" = ANY(ARRAY[${Prisma.join([
      ...QUEUED_STATUSES,
      "EXECUTING",
    ])}]::\"TaskRunStatus\"[])
  GROUP BY
    tr."taskIdentifier",
    tr.status
  ORDER BY
    tr."taskIdentifier" ASC`;

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

  async #getAverageDurations(tasks: string[], projectId: string, environmentId: string) {
    if (tasks.length === 0) {
      return {};
    }

    const durations = await this._replica.$queryRaw<
      {
        taskIdentifier: string;
        duration: Number;
      }[]
    >`
    SELECT
      tr."taskIdentifier",
      AVG(EXTRACT(EPOCH FROM (tr."updatedAt" - COALESCE(tr."startedAt", tr."lockedAt")))) as duration
      FROM
      ${sqlDatabaseSchema}."TaskRun" as tr
    WHERE
      tr."taskIdentifier" IN (${Prisma.join(tasks)})
      AND tr."projectId" = ${projectId}
      AND tr."runtimeEnvironmentId" = ${environmentId}
      AND tr."createdAt" >= (current_date - interval '6 days')
      AND tr."status" IN ('COMPLETED_SUCCESSFULLY', 'COMPLETED_WITH_ERRORS')
    GROUP BY
      tr."taskIdentifier";`;

    return Object.fromEntries(durations.map((s) => [s.taskIdentifier, Number(s.duration)]));
  }
}
