import { type ClickHouse } from "@internal/clickhouse";
import { type MachinePresetName, RetryOptions } from "@trigger.dev/core/v3";
import {
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type TaskTriggerSource,
} from "@trigger.dev/database";
import { z } from "zod";
import { machinePresetFromConfig } from "~/v3/machinePresets.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import {
  chooseBucketSeconds,
  groupRunStatus,
  RUN_STATUS_GROUPS,
  zeroFillGroupedSeries,
} from "./activitySeries.server";

export type TaskDetailQueue = {
  friendlyId: string;
  name: string;
  concurrencyLimit: number | null;
  paused: boolean;
};

export type TaskDetailRetry = {
  maxAttempts?: number;
  factor?: number;
  minTimeoutInMs?: number;
  maxTimeoutInMs?: number;
  randomize?: boolean;
};

export type TaskDetail = {
  slug: string;
  filePath: string;
  exportName: string | null;
  description: string | null;
  triggerSource: TaskTriggerSource;
  createdAt: Date;
  config: unknown;
  workerVersion: string | null;
  queue: TaskDetailQueue | null;
  machinePreset: MachinePresetName;
  maxDurationInSeconds: number | null;
  ttl: string | null;
  retry: TaskDetailRetry | null;
  hasPayloadSchema: boolean;
};

export type TaskActivityPoint = {
  bucket: number;
} & Record<string, number>;

export type TaskActivity = {
  data: TaskActivityPoint[];
  statuses: string[];
};

export class TaskDetailPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  async findTask({
    environmentId,
    environmentType,
    taskSlug,
    expectedTriggerSource,
  }: {
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
    taskSlug: string;
    expectedTriggerSource?: TaskTriggerSource;
  }): Promise<TaskDetail | null> {
    const currentWorker = await findCurrentWorkerFromEnvironment(
      { id: environmentId, type: environmentType },
      this.replica
    );

    if (!currentWorker) return null;

    const task = await this.replica.backgroundWorkerTask.findFirst({
      where: {
        workerId: currentWorker.id,
        slug: taskSlug,
        ...(expectedTriggerSource ? { triggerSource: expectedTriggerSource } : {}),
      },
      select: {
        slug: true,
        filePath: true,
        exportName: true,
        description: true,
        triggerSource: true,
        config: true,
        createdAt: true,
        machineConfig: true,
        retryConfig: true,
        maxDurationInSeconds: true,
        ttl: true,
        payloadSchema: true,
        queue: {
          select: {
            friendlyId: true,
            name: true,
            concurrencyLimit: true,
            paused: true,
          },
        },
      },
    });

    if (!task) return null;

    const retryParsed = RetryOptions.safeParse(task.retryConfig ?? undefined);
    const retry: TaskDetailRetry | null = retryParsed.success
      ? {
          maxAttempts: retryParsed.data.maxAttempts,
          factor: retryParsed.data.factor,
          minTimeoutInMs: retryParsed.data.minTimeoutInMs,
          maxTimeoutInMs: retryParsed.data.maxTimeoutInMs,
          randomize: retryParsed.data.randomize,
        }
      : null;

    return {
      slug: task.slug,
      filePath: task.filePath,
      exportName: task.exportName,
      description: task.description,
      triggerSource: task.triggerSource,
      createdAt: task.createdAt,
      config: task.config,
      workerVersion: currentWorker.version,
      queue: task.queue,
      machinePreset: machinePresetFromConfig(task.machineConfig ?? {}).name,
      maxDurationInSeconds: task.maxDurationInSeconds,
      ttl: task.ttl,
      retry,
      hasPayloadSchema: task.payloadSchema !== null && task.payloadSchema !== undefined,
    };
  }

  async getActivity({
    organizationId,
    projectId,
    environmentId,
    taskSlug,
    from,
    to,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    taskSlug: string;
    from: Date;
    to: Date;
  }): Promise<TaskActivity> {
    const rangeMs = Math.max(1, to.getTime() - from.getTime());
    const bucketSeconds = chooseBucketSeconds(rangeMs);

    // FINAL + _is_deleted = 0 because task_runs_v2 is a ReplacingMergeTree;
    // org/project filters engage the sort-key prefix for partition pruning.
    const queryFn = this.clickhouse.reader.query({
      name: "taskRunStatusActivity",
      query: `SELECT
          toUnixTimestamp(toStartOfInterval(created_at, INTERVAL {bucketSeconds: UInt32} SECOND)) AS bucket,
          status,
          count() AS val
        FROM trigger_dev.task_runs_v2 FINAL
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND task_identifier = {taskSlug: String}
          AND created_at >= {fromTime: DateTime64(3, 'UTC')}
          AND created_at < {toTime: DateTime64(3, 'UTC')}
          AND _is_deleted = 0
        GROUP BY bucket, status
        ORDER BY bucket`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        taskSlug: z.string(),
        bucketSeconds: z.number(),
        fromTime: z.string(),
        toTime: z.string(),
      }),
      schema: z.object({
        bucket: z.coerce.number(),
        status: z.string(),
        val: z.coerce.number(),
      }),
    });

    const [error, rows] = await queryFn({
      organizationId,
      projectId,
      environmentId,
      taskSlug,
      bucketSeconds,
      // ClickHouse's DateTime64(3, 'UTC') parser rejects the trailing `Z` from
      // JS toISOString() ("only 23 of 24 bytes was parsed"). Strip it.
      fromTime: from.toISOString().slice(0, -1),
      toTime: to.toISOString().slice(0, -1),
    });

    if (error) {
      console.error("Task activity query failed:", error);
      return { data: [], statuses: [] };
    }

    // Always emit every status group so the chart legend is stable across time
    // ranges (even when a group has no runs in the current window).
    const points = zeroFillGroupedSeries({
      rows,
      from,
      to,
      bucketSeconds,
      orderedKeys: RUN_STATUS_GROUPS,
      groupFn: groupRunStatus,
      fallbackKey: "RUNNING",
    });

    return { data: points, statuses: [...RUN_STATUS_GROUPS] };
  }
}
