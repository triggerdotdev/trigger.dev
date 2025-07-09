import { ScheduledTaskPayload, parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3";
import {
  type TaskRunTemplate,
  type RuntimeEnvironmentType,
  type TaskRunStatus,
} from "@trigger.dev/database";
import { type PrismaClient, prisma, sqlDatabaseSchema } from "~/db.server";
import { getTimezones } from "~/utils/timezones.server";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";
import { queueTypeFromType } from "./QueueRetrievePresenter.server";
import parse from "parse-duration";

export type RunTemplate = TaskRunTemplate & {
  scheduledTaskPayload?: ScheduledRun["payload"];
};

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

type Queue = {
  id: string;
  name: string;
  type: "custom" | "task";
  paused: boolean;
};

export type TestTaskResult =
  | {
      foundTask: true;
      triggerSource: "STANDARD";
      queue?: Queue;
      task: Task;
      runs: StandardRun[];
      latestVersions: string[];
      disableVersionSelection: boolean;
      allowArbitraryQueues: boolean;
      taskRunTemplates: TaskRunTemplate[];
    }
  | {
      foundTask: true;
      triggerSource: "SCHEDULED";
      queue?: Queue;
      task: Task;
      possibleTimezones: string[];
      runs: ScheduledRun[];
      latestVersions: string[];
      disableVersionSelection: boolean;
      allowArbitraryQueues: boolean;
      taskRunTemplates: TaskRunTemplate[];
    }
  | {
      foundTask: false;
    };

export type StandardTaskResult = Extract<
  TestTaskResult,
  { foundTask: true; triggerSource: "STANDARD" }
>;
export type ScheduledTaskResult = Extract<
  TestTaskResult,
  { foundTask: true; triggerSource: "SCHEDULED" }
>;

type RawRun = {
  id: string;
  queue: string;
  friendlyId: string;
  createdAt: Date;
  status: TaskRunStatus;
  payload: string;
  payloadType: string;
  runtimeEnvironmentId: string;
  seedMetadata?: string;
  seedMetadataType?: string;
  concurrencyKey?: string;
  maxAttempts?: number;
  maxDurationInSeconds?: number;
  machinePreset?: string;
  ttl?: string;
  idempotencyKey?: string;
  runTags: string[];
};

export type StandardRun = Omit<RawRun, "ttl"> & {
  metadata?: string;
  ttlSeconds?: number;
};

export type ScheduledRun = Omit<RawRun, "payload" | "ttl"> & {
  payload: {
    timestamp: Date;
    lastTimestamp?: Date;
    externalId?: string;
    timezone: string;
  };
  ttlSeconds?: number;
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
            friendlyId: true,
            name: true,
            type: true,
            paused: true,
          },
        })
      : undefined;

    const backgroundWorkers = await this.#prismaClient.backgroundWorker.findMany({
      where: {
        runtimeEnvironmentId: environment.id,
      },
      select: {
        version: true,
        engine: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20, // last 20 versions should suffice
    });

    const taskRunTemplates = await this.#prismaClient.taskRunTemplate.findMany({
      where: {
        projectId,
        taskSlug: task.slug,
        triggerSource: task.triggerSource,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 50,
    });

    const latestVersions = backgroundWorkers.map((v) => v.version);

    const disableVersionSelection = environment.type === "DEVELOPMENT";
    const allowArbitraryQueues = backgroundWorkers[0]?.engine === "V1";

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
        taskr."queue",
        taskr."friendlyId",
        taskr."taskIdentifier",
        taskr."createdAt",
        taskr.status,
        taskr.payload,
        taskr."payloadType",
        taskr."seedMetadata",
        taskr."seedMetadataType",
        taskr."runtimeEnvironmentId",
        taskr."concurrencyKey",
        taskr."maxAttempts",
        taskr."maxDurationInSeconds",
        taskr."machinePreset",
        taskr."ttl",
        taskr."runTags"
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
          triggerSource: "STANDARD",
          queue: taskQueue
            ? {
                id: taskQueue.friendlyId,
                name: taskQueue.name.replace(/^task\//, ""),
                type: queueTypeFromType(taskQueue.type),
                paused: taskQueue.paused,
              }
            : undefined,
          task: taskWithEnvironment,
          runs: await Promise.all(
            latestRuns.map(
              async (r) =>
                ({
                  ...r,
                  payload: await prettyPrintPacket(r.payload, r.payloadType),
                  metadata: r.seedMetadata
                    ? await prettyPrintPacket(r.seedMetadata, r.seedMetadataType)
                    : undefined,
                  ttlSeconds: r.ttl ? parse(r.ttl, "s") ?? undefined : undefined,
                } satisfies StandardRun)
            )
          ),
          latestVersions,
          disableVersionSelection,
          allowArbitraryQueues,
          taskRunTemplates: await Promise.all(
            taskRunTemplates.map(async (t) => ({
              ...t,
              payload: await prettyPrintPacket(t.payload, t.payloadType),
              metadata: t.metadata ? await prettyPrintPacket(t.metadata, t.metadataType) : null,
            }))
          ),
        };
      case "SCHEDULED": {
        const possibleTimezones = getTimezones();
        return {
          foundTask: true,
          triggerSource: "SCHEDULED",
          queue: taskQueue
            ? {
                id: taskQueue.friendlyId,
                name: taskQueue.name.replace(/^task\//, ""),
                type: queueTypeFromType(taskQueue.type),
                paused: taskQueue.paused,
              }
            : undefined,
          task: taskWithEnvironment,
          possibleTimezones,
          runs: (
            await Promise.all(
              latestRuns.map(async (r) => {
                const payload = await getScheduleTaskRunPayload(r.payload, r.payloadType);

                if (payload.success) {
                  return {
                    ...r,
                    payload: payload.data,
                    ttlSeconds: r.ttl ? parse(r.ttl, "s") ?? undefined : undefined,
                  } satisfies ScheduledRun;
                }
              })
            )
          ).filter(Boolean),
          latestVersions,
          disableVersionSelection,
          allowArbitraryQueues,
          taskRunTemplates: await Promise.all(
            taskRunTemplates.map(async (t) => {
              const scheduledTaskPayload = t.payload
                ? await getScheduleTaskRunPayload(t.payload, t.payloadType)
                : undefined;

              return {
                ...t,
                scheduledTaskPayload:
                  scheduledTaskPayload && scheduledTaskPayload.success
                    ? scheduledTaskPayload.data
                    : undefined,
              };
            })
          ),
        };
      }
      default: {
        return task.triggerSource satisfies never;
      }
    }
  }
}

async function getScheduleTaskRunPayload(payload: string, payloadType: string) {
  const packet = await parsePacket({ data: payload, dataType: payloadType });
  if (!packet.timezone) {
    packet.timezone = "UTC";
  }
  const parsed = ScheduledTaskPayload.safeParse(packet);
  return parsed;
}
