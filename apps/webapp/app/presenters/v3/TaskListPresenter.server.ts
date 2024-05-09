import {
  Prisma,
  RuntimeEnvironmentType,
  TaskRunStatus,
  TaskTriggerSource,
} from "@trigger.dev/database";
import { QUEUED_STATUSES, RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { sqlDatabaseSchema } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { displayableEnvironments } from "~/models/runtimeEnvironment.server";
import { User } from "~/models/user.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";

export type Task = {
  slug: string;
  exportName: string;
  filePath: string;
  createdAt: Date;
  triggerSource: TaskTriggerSource;
  environments: {
    id: string;
    type: RuntimeEnvironmentType;
    userName?: string;
  }[];
};

type Return = Awaited<ReturnType<TaskListPresenter["call"]>>;

export type TaskActivity = Awaited<Return["activity"]>[string];

export class TaskListPresenter extends BasePresenter {
  public async call({
    userId,
    projectSlug,
    organizationSlug,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
  }) {
    const project = await this._replica.project.findFirstOrThrow({
      select: {
        id: true,
        environments: {
          select: {
            id: true,
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
      },
      where: {
        slug: projectSlug,
        organization: {
          slug: organizationSlug,
        },
      },
    });

    const tasks = await this._replica.$queryRaw<
      {
        id: string;
        slug: string;
        exportName: string;
        filePath: string;
        runtimeEnvironmentId: string;
        createdAt: Date;
        triggerSource: TaskTriggerSource;
      }[]
    >`
    WITH workers AS (
      SELECT DISTINCT ON ("runtimeEnvironmentId") id, "runtimeEnvironmentId", version
      FROM ${sqlDatabaseSchema}."BackgroundWorker"
      WHERE "runtimeEnvironmentId" IN (${Prisma.join(project.environments.map((e) => e.id))})
      ORDER BY "runtimeEnvironmentId", "createdAt" DESC
    )
    SELECT tasks.id, slug, "filePath", "exportName", "triggerSource", tasks."runtimeEnvironmentId", tasks."createdAt"
    FROM workers
    JOIN ${sqlDatabaseSchema}."BackgroundWorkerTask" tasks ON tasks."workerId" = workers.id
    ORDER BY slug ASC;`;

    //group by the task identifier (task.slug). Add the latestRun and add all the environments.
    const outputTasks = tasks.reduce((acc, task) => {
      const environment = project.environments.find((env) => env.id === task.runtimeEnvironmentId);
      if (!environment) {
        throw new Error(`Environment not found for TaskRun ${task.id}`);
      }

      let existingTask = acc.find((t) => t.slug === task.slug);

      if (!existingTask) {
        existingTask = {
          ...task,
          environments: [],
        };
        acc.push(existingTask);
      }

      existingTask.environments.push(displayableEnvironments(environment, userId));

      //order the environments
      existingTask.environments = sortEnvironments(existingTask.environments);

      return acc;
    }, [] as Task[]);

    //then get the activity for each task
    const activity = this.#getActivity(
      outputTasks.map((t) => t.slug),
      project.id
    );

    const runningStats = this.#getRunningStats(
      outputTasks.map((t) => t.slug),
      project.id
    );

    const durations = this.#getAverageDurations(
      outputTasks.map((t) => t.slug),
      project.id
    );

    const userEnvironment = project.environments.find((e) => e.orgMember?.user.id === userId);
    const userHasTasks = userEnvironment
      ? outputTasks.some((t) => t.environments.some((e) => e.id === userEnvironment.id))
      : false;

    return { tasks: outputTasks, userHasTasks, activity, runningStats, durations };
  }

  async #getActivity(tasks: string[], projectId: string) {
    if (tasks.length === 0) {
      return {};
    }

    const activity = await this._replica.$queryRaw<
      {
        taskIdentifier: string;
        status: TaskRunStatus;
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
          } as { day: string } & Record<TaskRunStatus, number>);
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
    }, {} as Record<string, ({ day: string } & Record<TaskRunStatus, number>)[]>);
  }

  async #getRunningStats(tasks: string[], projectId: string) {
    if (tasks.length === 0) {
      return {};
    }

    const statuses = await this._replica.$queryRaw<
      {
        taskIdentifier: string;
        status: TaskRunStatus;
        count: BigInt;
      }[]
    >`
    SELECT 
    tr."taskIdentifier", 
    tr."status",
    COUNT(*) 
  FROM 
    ${sqlDatabaseSchema}."TaskRun" as tr
  WHERE 
    tr."taskIdentifier" IN (${Prisma.join(tasks)})
    AND tr."projectId" = ${projectId}
    AND tr."status" IN ('PENDING', 'WAITING_FOR_DEPLOY', 'EXECUTING', 'RETRYING_AFTER_FAILURE', 'WAITING_TO_RESUME')
  GROUP BY 
    tr."taskIdentifier", 
    tr."status"
  ORDER BY 
    tr."taskIdentifier" ASC,
    tr."status" ASC;`;

    return statuses.reduce((acc, a) => {
      let existingTask = acc[a.taskIdentifier];

      if (!existingTask) {
        existingTask = {
          queued: 0,
          running: 0,
        };

        acc[a.taskIdentifier] = existingTask;
      }

      if (QUEUED_STATUSES.includes(a.status)) {
        existingTask.queued += Number(a.count);
      }
      if (RUNNING_STATUSES.includes(a.status)) {
        existingTask.running += Number(a.count);
      }

      return acc;
    }, {} as Record<string, { queued: number; running: number }>);
  }

  async #getAverageDurations(tasks: string[], projectId: string) {
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
      AVG(EXTRACT(EPOCH FROM (tr."updatedAt" - tr."lockedAt"))) as duration
      FROM 
      ${sqlDatabaseSchema}."TaskRun" as tr
    WHERE 
      tr."taskIdentifier" IN (${Prisma.join(tasks)})
      AND tr."projectId" = ${projectId}
      AND tr."createdAt" >= (current_date - interval '6 days')
      AND tr."status" IN ('COMPLETED_SUCCESSFULLY', 'COMPLETED_WITH_ERRORS')
    GROUP BY 
      tr."taskIdentifier";`;

    return Object.fromEntries(durations.map((s) => [s.taskIdentifier, Number(s.duration)]));
  }
}
