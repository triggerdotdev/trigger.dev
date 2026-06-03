import { type ClickHouse } from "@internal/clickhouse";
import {
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { z } from "zod";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";

export type AgentDetail = {
  slug: string;
  filePath: string;
  triggerSource: "AGENT";
  createdAt: Date;
  config: unknown;
};

export type AgentActivityPoint = {
  bucket: number; // epoch ms
} & Record<string, number>;

export type AgentActivity = {
  data: AgentActivityPoint[];
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

export class AgentDetailPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  async findAgent({
    environmentId,
    environmentType,
    agentSlug,
  }: {
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
    agentSlug: string;
  }): Promise<AgentDetail | null> {
    const currentWorker = await findCurrentWorkerFromEnvironment(
      { id: environmentId, type: environmentType },
      this.replica
    );

    if (!currentWorker) return null;

    const task = await this.replica.backgroundWorkerTask.findFirst({
      where: {
        workerId: currentWorker.id,
        slug: agentSlug,
        triggerSource: "AGENT",
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
      triggerSource: "AGENT",
      createdAt: task.createdAt,
      config: task.config,
    };
  }

  async getActivity({
    environmentId,
    agentSlug,
    from,
    to,
  }: {
    environmentId: string;
    agentSlug: string;
    from: Date;
    to: Date;
  }): Promise<AgentActivity> {
    const rangeMs = Math.max(1, to.getTime() - from.getTime());
    const oneHour = 60 * 60 * 1000;
    const sixHours = 6 * oneHour;
    const oneDay = 24 * oneHour;

    // Pick a sensible bucket interval based on the range
    const bucketSeconds =
      rangeMs <= oneDay
        ? 60 * 60 // 1h buckets
        : rangeMs <= 7 * oneDay
        ? 6 * 60 * 60 // 6h buckets
        : 24 * 60 * 60; // 1d buckets

    // NOTE: We intentionally don't filter by `task_kind = 'AGENT'` here:
    // ClickHouse stores `task_kind = ""` for pre-migration rows and rows
    // whose taskKind annotation was never set, even for AGENT tasks. We've
    // already verified this task is an agent via `findAgent` (Postgres), so
    // matching on environment_id + task_identifier is sufficient.
    const queryFn = this.clickhouse.reader.query({
      name: "agentRunStatusActivity",
      query: `SELECT
          toUnixTimestamp(toStartOfInterval(created_at, INTERVAL {bucketSeconds: UInt32} SECOND)) AS bucket,
          status,
          count() AS val
        FROM trigger_dev.task_runs_v2
        WHERE environment_id = {environmentId: String}
          AND task_identifier = {agentSlug: String}
          AND created_at >= {fromTime: DateTime64(3, 'UTC')}
          AND created_at < {toTime: DateTime64(3, 'UTC')}
        GROUP BY bucket, status
        ORDER BY bucket`,
      params: z.object({
        environmentId: z.string(),
        agentSlug: z.string(),
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
      agentSlug,
      bucketSeconds,
      // ClickHouse's DateTime64(3, 'UTC') parser rejects the trailing `Z` from
      // JS toISOString() ("only 23 of 24 bytes was parsed"). Strip it.
      fromTime: from.toISOString().slice(0, -1),
      toTime: to.toISOString().slice(0, -1),
    });

    if (error) {
      console.error("Agent activity query failed:", error);
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

    // Build zero-filled time series. We always emit every status group so
    // the chart legend is stable across time ranges (even when a group has
    // no runs in the current window).
    const bucketMs = bucketSeconds * 1000;
    const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
    const end = Math.ceil(to.getTime() / bucketMs) * bucketMs;
    const points: AgentActivityPoint[] = [];
    const orderedStatuses = [...GROUP_LABEL];
    for (let ts = start; ts < end; ts += bucketMs) {
      const existing = bucketMap.get(ts) ?? {};
      const point: AgentActivityPoint = { bucket: ts };
      for (const g of orderedStatuses) {
        point[g] = existing[g] ?? 0;
      }
      points.push(point);
    }

    return { data: points, statuses: orderedStatuses };
  }
}
