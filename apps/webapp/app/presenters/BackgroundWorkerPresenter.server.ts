import { Prisma, TaskRunAttemptStatus } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
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
    const tasks = await this.#prismaClient.backgroundWorkerTask.findMany({
      select: {
        id: true,
        slug: true,
        filePath: true,
        exportName: true,
        friendlyId: true,
        createdAt: true,
        worker: {
          select: {
            id: true,
            version: true,
            sdkVersion: true,
            cliVersion: true,
            createdAt: true,
            updatedAt: true,
            friendlyId: true,
          },
        },
        runtimeEnvironment: {
          select: {
            id: true,
            slug: true,
            type: true,
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
        project: {
          slug: projectSlug,
        },
      },
      orderBy: [{ createdAt: "desc" }],
    });

    let latestRuns = [] as {
      updatedAt: Date;
      status: TaskRunAttemptStatus;
      backgroundWorkerTaskId: string;
    }[];

    if (tasks.length > 0) {
      latestRuns = await this.#prismaClient.$queryRaw<
        {
          updatedAt: Date;
          status: TaskRunAttemptStatus;
          backgroundWorkerTaskId: string;
        }[]
      >`
      SELECT * FROM (
        SELECT
          "updatedAt",
          "status",
          "backgroundWorkerTaskId",
          ROW_NUMBER() OVER (PARTITION BY "backgroundWorkerTaskId" ORDER BY "updatedAt" DESC) AS rn
        FROM
          "TaskRunAttempt"
        WHERE
          "backgroundWorkerTaskId" IN(${Prisma.join(tasks.map((t) => t.id))})
            ) t
            WHERE rn = 1;`;
    }

    return tasks.map((task) => {
      const latestRun = latestRuns.find((r) => r.backgroundWorkerTaskId === task.id);

      return {
        ...task,
        environment: {
          type: task.runtimeEnvironment.type,
          slug: task.runtimeEnvironment.slug,
          userId: task.runtimeEnvironment.orgMember?.user.id,
          userName: getUsername(task.runtimeEnvironment.orgMember?.user),
        },
        latestRun,
      };
    });
  }
}
