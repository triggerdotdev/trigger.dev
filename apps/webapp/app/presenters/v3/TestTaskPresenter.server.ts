import { TaskRunAttemptStatus } from "@trigger.dev/database";
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
        status: TaskRunAttemptStatus;
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
          bwt."friendlyId" = ${taskFriendlyId}
      ORDER BY 
          tr."createdAt" DESC
      LIMIT 5
    ), latestattempts AS (
        SELECT
            "taskRunId",
            status,
            ROW_NUMBER() OVER(PARTITION BY "taskRunId" ORDER BY "createdAt" DESC) AS rank
        FROM
            "TaskRunAttempt"
    )
    SELECT 
        taskr.id,
        taskr.number,
        taskr."friendlyId",
        taskr."taskIdentifier",
        taskr."createdAt",
        tra.status,
        taskr.payload,
        taskr."payloadType",
        taskr."runtimeEnvironmentId"
    FROM 
        taskruns AS taskr
    LEFT JOIN
        latestattempts AS tra
        ON taskr.id = tra."taskRunId"
    WHERE
        tra.rank = 1
    ORDER BY
        taskr."createdAt" DESC;`;

    return {
      task: {
        id: task.id,
        taskIdentifier: task.slug,
        filePath: task.filePath,
        exportName: task.exportName,
        friendlyId: taskFriendlyId,
        environment: {
          id: task.runtimeEnvironment.id,
          type: task.runtimeEnvironment.type,
          userId: task.runtimeEnvironment.orgMember?.user.id,
          userName: getUsername(task.runtimeEnvironment.orgMember?.user),
        },
      },
      runs: latestRuns.map((r) => {
        //we need to format the code on the server, because we detect if the sample has been edited by comparing the contents
        try {
          r.payload = JSON.stringify(JSON.parse(r.payload ?? ""), null, 2);
        } catch (e) {}

        return { ...r, number: Number(r.number) };
      }),
    };
  }
}
