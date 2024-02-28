import { TaskRunAttemptStatus } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";

type TestTaskOptions = {
  userId: string;
  projectSlug: string;
  taskFriendId: string;
};

export type TestTask = Awaited<ReturnType<TestTaskPresenter["call"]>>;

export class TestTaskPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug, taskFriendId }: TestTaskOptions) {
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
        friendlyId: taskFriendId,
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
    SELECT 
      taskr.id,
      taskr.number,
      taskr."friendlyId",
      taskr."createdAt",
      tra.status,
      taskr.payload,
      taskr."payloadType",
      taskr."runtimeEnvironmentId"
    FROM
      (
        SELECT 
            tr.* 
        FROM 
            "TaskRun" as tr
        JOIN
            "BackgroundWorkerTask" as bwt
        ON
          tr."taskIdentifier" = bwt.slug
        WHERE
            bwt."friendlyId" = ${taskFriendId}
        ORDER BY 
            tr."createdAt" DESC
        LIMIT 5
      ) AS taskr
    LEFT JOIN
      "TaskRunAttempt" AS tra
    ON
      taskr.id = tra."taskRunId"
    ORDER BY
      tra."createdAt" DESC
    LIMIT 5;`;

    return {
      task: {
        id: task.id,
        taskIdentifier: task.slug,
        filePath: task.filePath,
        exportName: task.exportName,
        friendlyId: taskFriendId,
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
