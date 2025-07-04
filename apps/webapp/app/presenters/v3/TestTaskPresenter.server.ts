import { ScheduledTaskPayload, parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3";
import { type RuntimeEnvironmentType, type TaskRunStatus } from "@trigger.dev/database";
import { type PrismaClient, prisma, sqlDatabaseSchema } from "~/db.server";
import { getTimezones } from "~/utils/timezones.server";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";
import { queueTypeFromType } from "./QueueRetrievePresenter.server";

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
      queue?: {
        id: string;
        name: string;
        type: "custom" | "task";
        paused: boolean;
      };
      task: Task;
      runs: StandardRun[];
      latestVersions: string[];
    }
  | {
      triggerSource: "SCHEDULED";
      queue?: {
        id: string;
        name: string;
        type: "custom" | "task";
        paused: boolean;
      };
      task: Task;
      possibleTimezones: string[];
      runs: ScheduledRun[];
      latestVersions: string[];
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
  queue: string;
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
    const task =
      environment.type !== "DEVELOPMENT"
        ? (
            await findCurrentWorkerDeployment({ environmentId: environment.id })
          )?.worker?.tasks.find((t) => t.slug === taskIdentifier)
        : await this.#prismaClient.backgroundWorkerTask.findFirst({
            where: {
              slug: taskIdentifier,
              runtimeEnvironmentId: environment.id,
            },
            orderBy: {
              createdAt: "desc",
            },
          });

    if (!task) {
      return {
        foundTask: false,
      };
    }

    const taskQueue = task.queueId
      ? await this.#prismaClient.taskQueue.findFirst({
          where: {
            runtimeEnvironmentId: environment.id,
            id: task.queueId,
          },
          select: {
            id: true,
            name: true,
            type: true,
            paused: true,
          },
        })
      : undefined;

    // last 20 versions should suffice
    const latestVersions = (
      await this.#prismaClient.backgroundWorker.findMany({
        where: {
          runtimeEnvironmentId: environment.id,
        },
        select: {
          version: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        // only the latest version has active workers in development,
        // so we hide the older versions to avoid runs getting stuck
        take: environment.type === "DEVELOPMENT" ? 1 : 20,
      })
    ).map((v) => v.version);

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
        taskr."queue",
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
            queue: taskQueue
              ? {
                  id: taskQueue.id,
                  name: taskQueue.name.replace(/^task\//, ""),
                  type: queueTypeFromType(taskQueue.type),
                  paused: taskQueue.paused,
                }
              : undefined,
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
            latestVersions,
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
            latestVersions,
          },
        };
    }
  }
}

async function getScheduleTaskRunPayload(run: RawRun) {
  const payload = await parsePacket({ data: run.payload, dataType: run.payloadType });
  if (!payload.timezone) {
    payload.timezone = "UTC";
  }
  const parsed = ScheduledTaskPayload.safeParse(payload);
  return parsed;
}
