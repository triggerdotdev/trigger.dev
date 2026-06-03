import { type ClickHouse } from "@internal/clickhouse";
import {
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type TaskTriggerSource,
} from "@trigger.dev/database";
import { z } from "zod";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";

export type TaskDetail = {
  slug: string;
  filePath: string;
  triggerSource: TaskTriggerSource;
  createdAt: Date;
  config: unknown;
};

export type TaskActivityPoint = {
  bucket: number;
} & Record<string, number>;

export type TaskActivity = {
  data: TaskActivityPoint[];
  statuses: string[];
};

const TERMINAL_GROUPS = {
  COMPLETED: ["COMPLETED_SUCCESSFULLY"],
  FAILED: [
    "COMPLETED_WITH_ERRORS",
    "SYSTEM_FAILURE",
    "CRASHED",
    "INTERRUPTED",
    "TIMED_OUT",
  ],
  CANCELED: ["CANCELED", "EXPIRED"],
  RUNNING: [
    "EXECUTING",
    "DEQUEUED",
    "PENDING_EXECUTING",
    "WAITING_TO_RESUME",
    "QUEUED_EXECUTING",
    "PENDING",
    "PENDING_VERSION",
    "DELAYED",
    "WAITING_FOR_DEPLOY",
  ],
} as const;

const GROUP_LABEL = ["COMPLETED", "FAILED", "CANCELED", "RUNNING"] as const;
type GroupLabel = (typeof GROUP_LABEL)[number];

function groupForStatus(status: string): GroupLabel | undefined {
  for (const label of GROUP_LABEL) {
    if ((TERMINAL_GROUPS[label] as readonly string[]).includes(status)) return label;
  }
  return undefined;
}

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
        triggerSource: true,
        config: true,
        createdAt: true,
      },
    });

    if (!task) return null;
    return {
      slug: task.slug,
      filePath: task.filePath,
      triggerSource: task.triggerSource,
      createdAt: task.createdAt,
      config: task.config,
    };
  }

  async getActivity({
    environmentId,
    taskSlug,
    from,
    to,
  }: {
    environmentId: string;
    taskSlug: string;
    from: Date;
    to: Date;
  }): Promise<TaskActivity> {
    const rangeMs = Math.max(1, to.getTime() - from.getTime());
    const oneHour = 60 * 60 * 1000;
    const oneDay = 24 * oneHour;

    const bucketSeconds =
      rangeMs <= oneDay
        ? 60 * 60
        : rangeMs <= 7 * oneDay
        ? 6 * 60 * 60
        : 24 * 60 * 60;

    const queryFn = this.clickhouse.reader.query({
      name: "taskRunStatusActivity",
      query: `SELECT
          toUnixTimestamp(toStartOfInterval(created_at, INTERVAL {bucketSeconds: UInt32} SECOND)) AS bucket,
          status,
          count() AS val
        FROM trigger_dev.task_runs_v2
        WHERE environment_id = {environmentId: String}
          AND task_identifier = {taskSlug: String}
          AND created_at >= {fromTime: DateTime64(3, 'UTC')}
          AND created_at < {toTime: DateTime64(3, 'UTC')}
        GROUP BY bucket, status
        ORDER BY bucket`,
      params: z.object({
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

    const bucketMap = new Map<number, Record<string, number>>();
    for (const row of rows) {
      const group = groupForStatus(row.status) ?? "RUNNING";
      const ts = row.bucket * 1000;
      const existing = bucketMap.get(ts) ?? {};
      existing[group] = (existing[group] ?? 0) + row.val;
      bucketMap.set(ts, existing);
    }

    // Always emit every status group so the chart legend is stable across
    // time ranges (even when a group has no runs in the current window).
    const bucketMs = bucketSeconds * 1000;
    const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
    const end = Math.ceil(to.getTime() / bucketMs) * bucketMs;
    const points: TaskActivityPoint[] = [];
    const orderedStatuses = [...GROUP_LABEL];
    for (let ts = start; ts < end; ts += bucketMs) {
      const existing = bucketMap.get(ts) ?? {};
      const point: TaskActivityPoint = { bucket: ts };
      for (const g of orderedStatuses) {
        point[g] = existing[g] ?? 0;
      }
      points.push(point);
    }

    return { data: points, statuses: orderedStatuses };
  }
}
