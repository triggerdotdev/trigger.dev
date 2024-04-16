import { TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";

type TestTaskOptions = {
  userId: string;
  projectSlug: string;
  taskFriendlyId: string;
};

export type TestTask = Awaited<ReturnType<TestTaskPresenter["call"]>>;

export class TestTaskPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug, taskFriendlyId }: TestTaskOptions) {
    const task = await this.#prismaClient.backgroundWorkerTask.findFirstOrThrow({
      select: {
        id: true,
        filePath: true,
        exportName: true,
        slug: true,
        triggerSource: true,
        runtimeEnvironment: {
          select: {
            id: true,
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
        friendlyId: taskFriendlyId,
      },
    });

    const latestRuns = await this.#prismaClient.$queryRaw<
      {
        id: string;
        number: BigInt;
        friendlyId: string;
        createdAt: Date;
        status: TaskRunStatus;
        payload: string;
        payloadType: string;
        runtimeEnvironmentId: string;
      }[]
    >`
    WITH taskruns AS (
      SELECT 
          tr.* 
      FROM 
          "TaskRun" as tr
      JOIN
          "BackgroundWorkerTask" as bwt
      ON
          tr."taskIdentifier" = bwt.slug
      WHERE
          bwt."friendlyId" = ${taskFriendlyId} AND
          tr."runtimeEnvironmentId" = ${task.runtimeEnvironment.id}
      ORDER BY 
          tr."createdAt" DESC
      LIMIT 5
    )
    SELECT 
        taskr.id,
        taskr.number,
        taskr."friendlyId",
        taskr."taskIdentifier",
        taskr."createdAt",
        taskr.status,
        taskr.payload,
        taskr."payloadType",
        taskr."runtimeEnvironmentId"
    FROM 
        taskruns AS taskr
    WHERE
        taskr."payloadType" = 'application/json' OR taskr."payloadType" = 'application/super+json'
    ORDER BY
        taskr."createdAt" DESC;`;

    return {
      task: {
        id: task.id,
        taskIdentifier: task.slug,
        filePath: task.filePath,
        exportName: task.exportName,
        friendlyId: taskFriendlyId,
        triggerSource: task.triggerSource,
        environment: {
          id: task.runtimeEnvironment.id,
          type: task.runtimeEnvironment.type,
          userId: task.runtimeEnvironment.orgMember?.user.id,
          userName: getUsername(task.runtimeEnvironment.orgMember?.user),
        },
      },
      runs: latestRuns.map((r) => {
        return { ...r, number: Number(r.number) };
      }),
    };
  }
}
