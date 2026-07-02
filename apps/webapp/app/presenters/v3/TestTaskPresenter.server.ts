import type { ClickHouse } from "@internal/clickhouse";
import { ScheduledTaskPayload, parsePacket, prettyPrintPacket } from "@trigger.dev/core/v3";
import {
  type Prisma,
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type TaskRunStatus,
  type TaskRunTemplate,
} from "@trigger.dev/database";
import { inferSchema } from "@jsonhero/schema-infer";
import parse from "parse-duration";
import { type RunStore } from "@internal/run-store";
import { type PrismaClient } from "~/db.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { getTimezones } from "~/utils/timezones.server";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";
import { queueTypeFromType } from "./QueueRetrievePresenter.server";

// Optional run-ops read-through wiring for the recent-payloads hydrate. Omitted
// => passthrough on `this.replica` (single-DB / self-host). `legacyReplica` is a
// READ REPLICA handle only — there is no legacy-primary field.
type TestTaskReadThroughDeps = {
  newClient?: PrismaClientOrTransaction;
  legacyReplica?: PrismaClientOrTransaction;
  // Resolved boot constant; when false the split branch is never entered.
  splitEnabled?: boolean;
};

// The byte-identical select the recent-payloads hydrate has always used; `id` is
// included so the split merge can key set-membership.
const RECENT_RUNS_SELECT = {
  id: true,
  queue: true,
  friendlyId: true,
  taskIdentifier: true,
  createdAt: true,
  status: true,
  payload: true,
  payloadType: true,
  seedMetadata: true,
  seedMetadataType: true,
  runtimeEnvironmentId: true,
  concurrencyKey: true,
  maxAttempts: true,
  maxDurationInSeconds: true,
  machinePreset: true,
  ttl: true,
  runTags: true,
} as const;

type RecentRunRow = Prisma.TaskRunGetPayload<{ select: typeof RECENT_RUNS_SELECT }>;

export type RunTemplate = TaskRunTemplate & {
  scheduledTaskPayload?: ScheduledRun["payload"];
};

type TestTaskOptions = {
  userId: string;
  projectId: string;
  environment: {
    id: string;
    type: RuntimeEnvironmentType;
    projectId: string;
    organizationId: string;
  };
  taskIdentifier: string;
};

type Task = {
  id: string;
  taskIdentifier: string;
  filePath: string;
  friendlyId: string;
  payloadSchema?: unknown;
  inferredPayloadSchema?: unknown;
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
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse,
    private readonly readThrough?: TestTaskReadThroughDeps,
    private readonly runStore: RunStore = defaultRunStore
  ) {}

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
        : await this.replica.backgroundWorkerTask.findFirst({
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
      ? await this.replica.taskQueue.findFirst({
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

    const backgroundWorkers = await this.replica.backgroundWorker.findMany({
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

    const taskRunTemplates = await this.replica.taskRunTemplate.findMany({
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

    // Get the latest runs, for the payloads
    const runsRepository = new RunsRepository({
      clickhouse: this.clickhouse,
      prisma: this.replica as PrismaClient,
    });

    const { runIds } = await runsRepository.listRunIds({
      organizationId: environment.organizationId,
      environmentId: environment.id,
      projectId: environment.projectId,
      tasks: [task.slug],
      period: "30d",
      page: {
        size: 10,
      },
    });

    const latestRuns = await this.hydrateRecentRuns(runIds);

    // Infer schema from existing run payloads when no explicit schema is defined
    let inferredPayloadSchema: unknown | undefined;
    if (!task.payloadSchema && latestRuns.length > 0 && task.triggerSource === "STANDARD") {
      let inference: ReturnType<typeof inferSchema> | undefined;
      for (const run of latestRuns) {
        try {
          const parsed = await parsePacket({ data: run.payload, dataType: run.payloadType });
          inference = inferSchema(parsed, inference);
        } catch {
          // Skip malformed runs — inference is best-effort
        }
      }
      if (inference) {
        inferredPayloadSchema = inference.toJSONSchema();
      }
    }

    const taskWithEnvironment = {
      id: task.id,
      taskIdentifier: task.slug,
      filePath: task.filePath,
      friendlyId: task.friendlyId,
      payloadSchema: task.payloadSchema ?? undefined,
      inferredPayloadSchema,
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
                  seedMetadata: r.seedMetadata ?? undefined,
                  seedMetadataType: r.seedMetadataType ?? undefined,
                  concurrencyKey: r.concurrencyKey ?? undefined,
                  maxAttempts: r.maxAttempts ?? undefined,
                  maxDurationInSeconds: r.maxDurationInSeconds ?? undefined,
                  machinePreset: r.machinePreset ?? undefined,
                  payload: await prettyPrintPacket(r.payload, r.payloadType),
                  metadata: r.seedMetadata
                    ? await prettyPrintPacket(r.seedMetadata, r.seedMetadataType)
                    : undefined,
                  ttlSeconds: r.ttl ? (parse(r.ttl, "s") ?? undefined) : undefined,
                }) satisfies StandardRun
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
                    seedMetadata: r.seedMetadata ?? undefined,
                    seedMetadataType: r.seedMetadataType ?? undefined,
                    concurrencyKey: r.concurrencyKey ?? undefined,
                    maxAttempts: r.maxAttempts ?? undefined,
                    maxDurationInSeconds: r.maxDurationInSeconds ?? undefined,
                    machinePreset: r.machinePreset ?? undefined,
                    payload: payload.data,
                    ttlSeconds: r.ttl ? (parse(r.ttl, "s") ?? undefined) : undefined,
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
      case "AGENT": {
        // AGENT tasks are filtered out by TestPresenter and shouldn't reach here
        return { foundTask: false };
      }
      default: {
        return task.triggerSource satisfies never;
      }
    }
  }

  // Runs the recent-payloads find on one client, preserving the byte-identical
  // select, the payloadType IN filter, and the createdAt-desc order on every
  // store this hydrate touches.
  private hydrateOnClient(
    client: PrismaClientOrTransaction,
    ids: string[]
  ): Promise<RecentRunRow[]> {
    return this.runStore.findRuns(
      {
        where: {
          id: { in: ids },
          payloadType: { in: ["application/json", "application/super+json"] },
        },
        select: RECENT_RUNS_SELECT,
        orderBy: { createdAt: "desc" },
      },
      client
    );
  }

  // Hydrates the recent-payloads run-id set from the run-ops store. Split on: new
  // client first, then the LEGACY READ REPLICA ONLY for ids that miss on new —
  // never the legacy primary. Split off: one plain findRuns on `this.replica`.
  private async hydrateRecentRuns(runIds: string[]): Promise<RecentRunRow[]> {
    if (runIds.length === 0) {
      return [];
    }

    if (!this.readThrough?.splitEnabled) {
      return this.hydrateOnClient(this.readThrough?.newClient ?? this.replica, runIds);
    }

    const newClient = this.readThrough.newClient ?? this.replica;
    const legacyReplica = this.readThrough.legacyReplica ?? this.replica;

    const newRows = await this.hydrateOnClient(newClient, runIds);
    const foundIds = new Set(newRows.map((r) => r.id));
    // Probe every id that missed on new against the legacy read replica.
    const toProbeLegacy = runIds.filter((id) => !foundIds.has(id));

    const legacyRows = toProbeLegacy.length
      ? await this.hydrateOnClient(legacyReplica, toProbeLegacy)
      : [];

    // Re-impose createdAt-desc across the two finds to match single-DB ordering,
    // with an id-desc tie-break so identical timestamps stay deterministic.
    return [...newRows, ...legacyRows].sort((a, b) => {
      const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
      return byCreatedAt !== 0 ? byCreatedAt : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
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
