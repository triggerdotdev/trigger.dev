import { type ClickHouse } from "@internal/clickhouse";
import {
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type TaskRunStatus,
  type TaskTriggerSource,
} from "@trigger.dev/database";
import { z } from "zod";
import { $replica } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { agentListPresenter, type AgentActiveState } from "./AgentListPresenter.server";
import { taskListPresenter, type TaskListItem } from "./TaskListPresenter.server";

export type UnifiedTaskKind = "STANDARD" | "SCHEDULED" | "AGENT";

export type UnifiedTaskListItem = {
  kind: UnifiedTaskKind;
  slug: string;
  filePath: string;
  triggerSource: TaskTriggerSource;
  createdAt: Date;
  /** Agent-only: parsed `config.type` used for the Type badge. */
  agentType?: string;
};

export type UnifiedRunningState =
  | { kind: "task"; running: number }
  | { kind: "agent"; running: number; suspended: number };

export type UnifiedRunningStates = Record<string, UnifiedRunningState>;

/** One hour bucket: the bucket start date, a total count for axis scaling,
 *  and per-status counts (sparse — only statuses that occurred are present). */
export type HourlyTaskActivityBucket = {
  date: Date;
  total: number;
} & Partial<Record<TaskRunStatus, number>>;

/** 24h hourly stacked-by-status series keyed by task slug. */
export type HourlyTaskActivity = Record<string, HourlyTaskActivityBucket[]>;

export class UnifiedTaskListPresenter {
  constructor(private readonly _replica: PrismaClientOrTransaction) {}

  public async call(args: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
  }): Promise<{
    items: UnifiedTaskListItem[];
    hourlyActivity: Promise<HourlyTaskActivity>;
    runningStates: Promise<UnifiedRunningStates>;
  }> {
    // Share the current-worker lookup across both inner presenters — without
    // this they'd each do an independent Postgres round-trip for the same row.
    const currentWorker = await findCurrentWorkerFromEnvironment(
      { id: args.environmentId, type: args.environmentType },
      this._replica
    );

    const [taskResult, agentResult] = await Promise.all([
      taskListPresenter.call({ ...args, currentWorker }),
      agentListPresenter.call({ ...args, currentWorker }),
    ]);

    const items = toUnifiedItems(taskResult.tasks, agentResult.agents);
    const allSlugs = items.map((item) => item.slug);

    const hourlyActivity: Promise<HourlyTaskActivity> =
      allSlugs.length === 0
        ? Promise.resolve({})
        : (async () => {
            const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
              args.organizationId,
              "standard"
            );
            return getHourlyTaskActivity(clickhouse, {
              organizationId: args.organizationId,
              projectId: args.projectId,
              environmentId: args.environmentId,
              slugs: allSlugs,
            });
          })();

    const runningStates: Promise<UnifiedRunningStates> = Promise.all([
      taskResult.runningStats,
      agentResult.activeStates,
    ]).then(([runningStats, activeStates]) => mergeRunningStates(runningStats, activeStates));

    return { items, hourlyActivity, runningStates };
  }
}

/** Query trigger_dev.task_runs_v2 for run counts per (hour, status) over the
 *  past 24h, grouped by task slug.
 *
 *  Uses FINAL + _is_deleted = 0 because task_runs_v2 is a ReplacingMergeTree;
 *  org/project filters engage the sort-key prefix for partition pruning. */
async function getHourlyTaskActivity(
  clickhouse: ClickHouse,
  args: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    slugs: string[];
  }
): Promise<HourlyTaskActivity> {
  // Align the lower bound to the start of the hour 23h ago so the query
  // returns exactly 24 distinct hour buckets, matching the JS-side key array.
  // `now() - INTERVAL 24 HOUR` would let a 25th (oldest) bucket slip in for
  // any request made past the top of an hour, and those runs would be
  // silently dropped from the chart.
  const queryFn = clickhouse.reader.query({
    name: "unifiedTaskListHourlyActivity",
    query: `SELECT
        task_identifier,
        toStartOfHour(created_at) AS bucket,
        status,
        count() AS val
      FROM trigger_dev.task_runs_v2 FINAL
      WHERE organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND task_identifier IN {slugs: Array(String)}
        AND created_at >= toStartOfHour(now() - INTERVAL 23 HOUR)
        AND _is_deleted = 0
      GROUP BY task_identifier, bucket, status
      ORDER BY task_identifier, bucket, status`,
    params: z.object({
      organizationId: z.string(),
      projectId: z.string(),
      environmentId: z.string(),
      slugs: z.array(z.string()),
    }),
    schema: z.object({
      task_identifier: z.string(),
      bucket: z.string(),
      status: z.string(),
      val: z.coerce.number(),
    }),
  });

  const [error, rows] = await queryFn(args);
  if (error) {
    console.error("Unified task list hourly activity query failed:", error);
    return {};
  }

  // 24 hourly buckets ending at the current hour. Keys match ClickHouse's
  // `toStartOfHour(created_at)` formatting ("YYYY-MM-DD HH:00:00").
  const now = new Date();
  const startHour = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() - 23,
      0,
      0,
      0
    )
  );

  const buckets: { key: string; date: Date }[] = [];
  for (let i = 0; i < 24; i++) {
    const date = new Date(startHour.getTime() + i * 3_600_000);
    const key = date.toISOString().slice(0, 13).replace("T", " ") + ":00:00";
    buckets.push({ key, date });
  }

  // slug → bucketKey → bucket payload (per-status counts + total)
  const slugBuckets = new Map<string, Map<string, HourlyTaskActivityBucket>>();
  for (const row of rows ?? []) {
    let perSlug = slugBuckets.get(row.task_identifier);
    if (!perSlug) {
      perSlug = new Map();
      slugBuckets.set(row.task_identifier, perSlug);
    }
    let bucket = perSlug.get(row.bucket);
    if (!bucket) {
      bucket = { date: new Date(0), total: 0 };
      perSlug.set(row.bucket, bucket);
    }
    const status = row.status as TaskRunStatus;
    bucket[status] = (bucket[status] ?? 0) + row.val;
    bucket.total += row.val;
  }

  const result: HourlyTaskActivity = {};
  for (const slug of args.slugs) {
    const perSlug = slugBuckets.get(slug);
    result[slug] = buckets.map(({ key, date }) => {
      const existing = perSlug?.get(key);
      if (!existing) return { date, total: 0 };
      return { ...existing, date };
    });
  }
  return result;
}

function toUnifiedItems(
  tasks: TaskListItem[],
  agents: Array<{
    slug: string;
    filePath: string;
    createdAt: Date;
    triggerSource: TaskTriggerSource;
    config: unknown;
  }>
): UnifiedTaskListItem[] {
  const items: UnifiedTaskListItem[] = [];

  for (const task of tasks) {
    items.push({
      kind: task.triggerSource === "SCHEDULED" ? "SCHEDULED" : "STANDARD",
      slug: task.slug,
      filePath: task.filePath,
      triggerSource: task.triggerSource,
      createdAt: task.createdAt,
    });
  }

  for (const agent of agents) {
    items.push({
      kind: "AGENT",
      slug: agent.slug,
      filePath: agent.filePath,
      triggerSource: agent.triggerSource,
      createdAt: agent.createdAt,
      agentType: (agent.config as { type?: string } | null)?.type,
    });
  }

  items.sort((a, b) => a.slug.localeCompare(b.slug));
  return items;
}

function mergeRunningStates(
  runningStats: Record<string, { running: number; queued: number }>,
  activeStates: Record<string, AgentActiveState>
): UnifiedRunningStates {
  const out: UnifiedRunningStates = {};

  for (const [slug, stats] of Object.entries(runningStats)) {
    out[slug] = { kind: "task", running: stats?.running ?? 0 };
  }

  for (const [slug, state] of Object.entries(activeStates)) {
    // Guard against slug collisions: a single BackgroundWorker isn't expected
    // to have both a STANDARD/SCHEDULED task and an AGENT task with the same
    // slug, but nothing in the schema enforces it. If it ever happened, the
    // standard-task running count would be silently dropped and the row would
    // get relabelled as an agent.
    if (slug in out) continue;
    out[slug] = {
      kind: "agent",
      running: state?.running ?? 0,
      suspended: state?.suspended ?? 0,
    };
  }

  return out;
}

function setupUnifiedTaskListPresenter() {
  return new UnifiedTaskListPresenter($replica);
}

export const unifiedTaskListPresenter = singleton(
  "unifiedTaskListPresenter",
  setupUnifiedTaskListPresenter
);
