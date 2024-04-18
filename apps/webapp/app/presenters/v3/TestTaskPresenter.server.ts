import { ScheduledTaskPayload, parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3";
import {
  RuntimeEnvironmentType,
  TaskRunAttemptStatus,
  TaskRunStatus,
  TaskTriggerSource,
} from "@trigger.dev/database";
import { sqlDatabaseSchema, PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";

type TestTaskOptions = {
  userId: string;
  projectSlug: string;
  taskFriendlyId: string;
};

type Task = {
  id: string;
  taskIdentifier: string;
  filePath: string;
  exportName: string;
  friendlyId: string;
  environment: {
    id: string;
    type: RuntimeEnvironmentType;
    userId?: string;
    userName?: string;
  };
};

export type TestTask =
  | {
      triggerSource: "STANDARD";
      task: Task;
      runs: StandardRun[];
    }
  | {
      triggerSource: "SCHEDULED";
      task: Task;
      runs: ScheduledRun[];
    };

type RawRun = {
  id: string;
  number: BigInt;
  friendlyId: string;
  createdAt: Date;
  status: TaskRunStatus;
  payload: string;
  payloadType: string;
  runtimeEnvironmentId: string;
};

export type StandardRun = Omit<RawRun, "number"> & {
  number: number;
};

export type ScheduledRun = Omit<RawRun, "number" | "payload"> & {
  number: number;
  payload: {
    timestamp: Date;
    lastTimestamp?: Date;
    externalId?: string;
  };
};

export class TestTaskPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug, taskFriendlyId }: TestTaskOptions): Promise<TestTask> {
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

    const latestRuns = await this.#prismaClient.$queryRaw<RawRun[]>`
    WITH taskruns AS (
      SELECT 
          tr.* 
      FROM 
          ${sqlDatabaseSchema}."TaskRun" as tr
      JOIN
          ${sqlDatabaseSchema}."BackgroundWorkerTask" as bwt
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

    const taskWithEnvironment = {
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
    };

    switch (task.triggerSource) {
      case "STANDARD":
        return {
          triggerSource: "STANDARD",
          task: taskWithEnvironment,
          runs: await Promise.all(
            latestRuns.map(async (r) => {
              const number = Number(r.number);

              return {
                ...r,
                number,
                payload: await prettyPrintPacket(r.payload, r.payloadType),
              };
            })
          ),
        };
      case "SCHEDULED":
        return {
          triggerSource: "SCHEDULED",
          task: taskWithEnvironment,
          runs: await Promise.all(
            latestRuns.map(async (r) => {
              const number = Number(r.number);

              return {
                ...r,
                number,
                payload: await getScheduleTaskRunPayload(r),
              };
            })
          ),
        };
    }
  }
}

async function getScheduleTaskRunPayload(run: RawRun) {
  const payload = await parsePacket({ data: run.payload, dataType: run.payloadType });
  const parsed = ScheduledTaskPayload.parse(payload);
  return parsed;
}
