import {
  Prisma,
  RuntimeEnvironmentType,
  TaskRunStatus,
  TaskTriggerSource,
} from "@trigger.dev/database";
import { PrismaClient, prisma, sqlDatabaseSchema } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { sortEnvironments } from "~/services/environmentSort.server";
import { getUsername } from "~/utils/username";

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
  latestRun?: {
    createdAt: Date;
    status: TaskRunStatus;
  };
};

export class TaskListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
  }) {
    const project = await this.#prismaClient.project.findFirstOrThrow({
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

    const tasks = await this.#prismaClient.$queryRaw<
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

    let latestRuns = [] as {
      createdAt: Date;
      status: TaskRunStatus;
      taskIdentifier: string;
    }[];

    if (tasks.length > 0) {
      const uniqueTaskSlugs = new Set(tasks.map((t) => t.slug));
      latestRuns = await this.#prismaClient.$queryRaw<
        {
          createdAt: Date;
          status: TaskRunStatus;
          taskIdentifier: string;
        }[]
      >`
      SELECT * FROM (
        SELECT
          "createdAt",
          "status",
          "taskIdentifier",
          ROW_NUMBER() OVER (PARTITION BY "taskIdentifier" ORDER BY "updatedAt" DESC) AS rn
        FROM
          ${sqlDatabaseSchema}."TaskRun"
        WHERE
          "taskIdentifier" IN(${Prisma.join(Array.from(uniqueTaskSlugs))})
          AND "projectId" = ${project.id}
      ) t
      WHERE rn = 1;`;
    }

    //group by the task identifier (task.slug). Add the latestRun and add all the environments.
    const outputTasks = tasks.reduce((acc, task) => {
      const latestRun = latestRuns.find((r) => r.taskIdentifier === task.slug);
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

      existingTask.environments.push({
        id: environment.id,
        type: environment.type,
        userName: getUsername(environment.orgMember?.user),
      });

      //order the environments
      existingTask.environments = sortEnvironments(existingTask.environments);

      existingTask.latestRun = latestRun
        ? {
            createdAt: latestRun.createdAt,
            status: latestRun.status,
          }
        : undefined;

      return acc;
    }, [] as Task[]);

    return outputTasks;
  }
}
