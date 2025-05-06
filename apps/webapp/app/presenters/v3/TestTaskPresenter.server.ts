import { ScheduledTaskPayload, parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3";
import { type RuntimeEnvironmentType, type TaskRunStatus } from "@trigger.dev/database";
import { type PrismaClient, prisma, sqlDatabaseSchema } from "~/db.server";
import { getTimezones } from "~/utils/timezones.server";
import {
  type BackgroundWorkerTaskSlim,
  findCurrentWorkerDeployment,
} from "~/v3/models/workerDeployment.server";

type TestTaskOptions = {
  userId: string;
  projectId: string;
  environment: {
    id: string;
    type: RuntimeEnvironmentType;
  };
  taskIdentifier: string;
};

type Task = {
  id: string;
  taskIdentifier: string;
  filePath: string;
  friendlyId: string;
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
      possibleTimezones: string[];
      runs: ScheduledRun[];
    };

export type TestTaskResult =
  | {
      foundTask: true;
      task: TestTask;
    }
  | {
      foundTask: false;
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
  seedMetadata?: string;
  seedMetadataType?: string;
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
    timezone: string;
  };
};

export class TestTaskPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectId,
    environment,
    taskIdentifier,
  }: TestTaskOptions): Promise<TestTaskResult> {
    let task: BackgroundWorkerTaskSlim | null = null;
    if (environment.type !== "DEVELOPMENT") {
      const deployment = await findCurrentWorkerDeployment({ environmentId: environment.id });
      if (deployment) {
        task = deployment.worker?.tasks.find((t) => t.slug === taskIdentifier) ?? null;
      }
    } else {
      task = await this.#prismaClient.backgroundWorkerTask.findFirst({
        where: {
          slug: taskIdentifier,
          runtimeEnvironmentId: environment.id,
        },
        orderBy: {
          createdAt: "desc",
        },
      });
    }

    if (!task) {
      return {
        foundTask: false,
      };
    }

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
          bwt."friendlyId" = ${task.friendlyId} AND
          tr."runtimeEnvironmentId" = ${environment.id}
      ORDER BY
          tr."createdAt" DESC
      LIMIT 10
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
        taskr."seedMetadata",
        taskr."seedMetadataType",
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
      friendlyId: task.friendlyId,
    };

    switch (task.triggerSource) {
      case "STANDARD":
        return {
          foundTask: true,
          task: {
            triggerSource: "STANDARD",
            task: taskWithEnvironment,
            runs: await Promise.all(
              latestRuns.map(async (r) => {
                const number = Number(r.number);

                return {
                  ...r,
                  number,
                  payload: await prettyPrintPacket(r.payload, r.payloadType),
                  metadata: r.seedMetadata
                    ? await prettyPrintPacket(r.seedMetadata, r.seedMetadataType)
                    : undefined,
                };
              })
            ),
          },
        };
      case "SCHEDULED":
        const possibleTimezones = getTimezones();
        return {
          foundTask: true,
          task: {
            triggerSource: "SCHEDULED",
            task: taskWithEnvironment,
            possibleTimezones,
            runs: (
              await Promise.all(
                latestRuns.map(async (r) => {
                  const number = Number(r.number);

                  const payload = await getScheduleTaskRunPayload(r);

                  if (payload.success) {
                    return {
                      ...r,
                      number,
                      payload: payload.data,
                    };
                  }
                })
              )
            ).filter(Boolean),
          },
        };
    }
  }
}

export async function getScheduleTaskRunPayload(run: Pick<RawRun, "payload" | "payloadType">) {
  const payload = await parsePacket({ data: run.payload, dataType: run.payloadType });
  if (!payload.timezone) {
    payload.timezone = "UTC";
  }
  const parsed = ScheduledTaskPayload.safeParse(payload);
  return parsed;
}
