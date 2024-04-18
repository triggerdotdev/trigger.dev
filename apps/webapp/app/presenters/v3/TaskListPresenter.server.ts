import { Prisma, TaskRunStatus, TaskTriggerSource } from "@trigger.dev/database";
import { PrismaClient, prisma, sqlDatabaseSchema } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { getUsername } from "~/utils/username";

export type Task = Awaited<ReturnType<TaskListPresenter["call"]>>[0];

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
    SELECT DISTINCT ON(bwt.slug, bwt."runtimeEnvironmentId")
      bwt.slug,
      bwt.id,
      bwt."exportName",
      bwt."filePath",
      bwt."runtimeEnvironmentId",
      bwt."createdAt",
      bwt."triggerSource"
    FROM
      ${sqlDatabaseSchema}."BackgroundWorkerTask" as bwt
    WHERE bwt."projectId" = ${project.id}
    ORDER BY
      bwt.slug,
      bwt."runtimeEnvironmentId",
      bwt."createdAt" DESC;`;

    let latestRuns = [] as {
      createdAt: Date;
      status: TaskRunStatus;
      lockedById: string;
    }[];

    if (tasks.length > 0) {
      latestRuns = await this.#prismaClient.$queryRaw<
        {
          createdAt: Date;
          status: TaskRunStatus;
          lockedById: string;
        }[]
      >`
      SELECT * FROM (
        SELECT
          "createdAt",
          "status",
          "lockedById",
          ROW_NUMBER() OVER (PARTITION BY "lockedById" ORDER BY "updatedAt" DESC) AS rn
        FROM
          ${sqlDatabaseSchema}."TaskRun"
        WHERE
          "lockedById" IN(${Prisma.join(tasks.map((t) => t.id))})
            ) t
            WHERE rn = 1;`;
    }

    return tasks.map((task) => {
      const latestRun = latestRuns.find((r) => r.lockedById === task.id);
      const environment = project.environments.find((env) => env.id === task.runtimeEnvironmentId);
      if (!environment) {
        throw new Error(`Environment not found for TaskRun ${task.id}`);
      }

      return {
        ...task,
        environment: {
          id: environment.id,
          type: environment.type,
          slug: environment.slug,
          userId: environment.orgMember?.user.id,
          userName: getUsername(environment.orgMember?.user),
        },
        latestRun: latestRun
          ? {
              createdAt: latestRun.createdAt,
              status: latestRun.status,
            }
          : undefined,
      };
    });
  }
}
