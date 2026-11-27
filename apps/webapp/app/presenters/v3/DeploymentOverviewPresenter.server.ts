import type { ClickHouse } from "@internal/clickhouse";
import type {
  Prisma,
  TaskQueueRole,
  TaskRunStatus,
  TaskTriggerSource,
} from "@trigger.dev/database";
import { z } from "zod";
import { type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { CONCURRENCY_LIMIT_QUEUE_PREFIX } from "~/v3/services/concurrencyLimitNames.server";
import {
  type ActivitySeriesPoint,
  chooseBucketSeconds,
  groupRunStatus,
  RUN_STATUS_GROUPS,
  zeroFillGroupedSeries,
} from "./activitySeries.server";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** The runs chart looks at a version's first week at most. */
const MAX_WINDOW_MS = 7 * DAY_MS;
/** Runs queued before a deploy can still run on it, so each window reaches back this far. */
const QUEUED_BEFORE_MS = DAY_MS;

type DeploymentTaskRow = {
  slug: string;
  filePath: string;
  triggerSource: TaskTriggerSource;
  /** Not in the previous deploy. */
  added: boolean;
};

/** One hour of a task's runs on this version: the total and the count per status. */
type VersionTaskActivityBucket = { date: Date; total: number } & Partial<
  Record<TaskRunStatus, number>
>;

/** The tasks list's stats, scoped to one version. */
export type VersionTaskActivity = {
  /** The last 24 hours, hourly, per task slug. */
  hourly: Record<string, VersionTaskActivityBucket[]>;
  /** Runs executing now, per task slug. */
  running: Record<string, number>;
};

/** What a version registered when it was indexed, by kind. */
type DeploymentCounts = {
  tasks: number;
  scheduled: number;
  agents: number;
  webhookTasks: number;
  queues: number;
  concurrencyLimits: number;
  declaredSchedules: number;
  webhookEndpoints: number;
  webhookSubscribers: number;
  machinePresets: number;
  files: number;
};

type WorkerTask = {
  slug: string;
  filePath: string;
  triggerSource: TaskTriggerSource;
  machineConfig: Prisma.JsonValue;
  retryConfig: Prisma.JsonValue;
  maxDurationInSeconds: number | null;
  gates: Prisma.JsonValue;
  queue: { id: string; name: string } | null;
};

type WorkerQueue = {
  id: string;
  name: string;
  role: TaskQueueRole;
  concurrencyLimit: number | null;
  totalConcurrencyLimit: number | null;
};

type WorkerResources = {
  metadata: Prisma.JsonValue;
  tasks: WorkerTask[];
  queues: WorkerQueue[];
  _count: { files: number };
};

/** Against the previous deploy: new in this one, gone from it, or neither. */
export type ResourceChange = "added" | "removed" | null;

/** Each kind's items, for the expanded rows of the Resources table. */
export type DeploymentResourceItems = {
  tasks: {
    slug: string;
    filePath: string;
    triggerSource: TaskTriggerSource;
    queue: string | null;
    /** null: the project's default machine. */
    machine: string | null;
    maxDurationSeconds: number | null;
    maxAttempts: number | null;
    change: ResourceChange;
  }[];
  queues: {
    name: string;
    concurrencyLimit: number | null;
    tasks: string[];
    change: ResourceChange;
  }[];
  concurrencyLimits: {
    name: string;
    concurrencyLimit: number | null;
    tasks: string[];
    change: ResourceChange;
  }[];
  schedules: { taskId: string; cron: string; timezone: string; change: ResourceChange }[];
  webhookEndpoints: {
    id: string;
    source: string | null;
    filePath: string | null;
    subscribers: string[];
    change: ResourceChange;
  }[];
  machines: { name: string | null; tasks: number }[];
};

/** Prompt versions a deploy created: the prompts whose content, model or config changed in it. */
export type DeploymentPrompts = { slug: string; version: number; model: string | null }[];

/** The parts of the stored worker metadata we count (stripBackgroundWorkerMetadataForStorage). */
const StoredWorkerMetadata = z
  .object({
    tasks: z.array(z.unknown()).catch([]),
    webhookEndpoints: z.array(z.unknown()).catch([]),
    webhookSubscribers: z.array(z.unknown()).catch([]),
  })
  .partial()
  .catch({});

const MachineConfig = z.object({ preset: z.string().optional() }).nullable().catch(null);
const RetryConfig = z.object({ maxAttempts: z.number().optional() }).nullable().catch(null);
const Gates = z
  .array(z.object({ queue: z.string() }))
  .nullable()
  .catch(null);
const DeclaredSchedule = z.object({
  id: z.string(),
  schedule: z.object({ cron: z.string(), timezone: z.string().optional() }),
});
const DeclaredEndpoint = z.object({
  id: z.string(),
  source: z.string().optional(),
  filePath: z.string().optional(),
});
const DeclaredSubscriber = z.object({
  endpointId: z.string(),
  target: z.union([
    z.object({ type: z.literal("task"), taskId: z.string() }),
    z.object({ type: z.literal("session"), taskIdentifier: z.string() }),
  ]),
});

function machineOf(task: WorkerTask) {
  return MachineConfig.parse(task.machineConfig ?? null)?.preset ?? null;
}

function parseEach<T>(schema: z.ZodType<T>, items: unknown[] | undefined): T[] {
  return (items ?? []).flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Items of this version, then the previous version's items that are gone, each marked. */
function withChanges<T>(
  current: T[],
  previous: T[] | undefined,
  key: (item: T) => string
): (T & { change: ResourceChange })[] {
  if (!previous) return current.map((item) => ({ ...item, change: null }));
  const before = new Set(previous.map(key));
  const now = new Set(current.map(key));
  return [
    ...current.map((item) => ({
      ...item,
      change: before.has(key(item)) ? null : ("added" as const),
    })),
    ...previous
      .filter((item) => !now.has(key(item)))
      .map((item) => ({ ...item, change: "removed" as const })),
  ];
}

// queue({ concurrencyLimit }) sets concurrencyLimit; the `concurrency` option (an inline
// { total } or a concurrencyLimit()) sets totalConcurrencyLimit.
function limitOf(queue: WorkerQueue) {
  return queue.concurrencyLimit ?? queue.totalConcurrencyLimit;
}

function isNamedLimit(queue: WorkerQueue) {
  return queue.role === "LIMIT" && !queue.name.startsWith(`${CONCURRENCY_LIMIT_QUEUE_PREFIX}task/`);
}

/** One worker's items, unmarked. */
function itemsOf(worker: WorkerResources) {
  const metadata = StoredWorkerMetadata.parse(worker.metadata ?? {});
  const tasks = worker.tasks.map((task) => ({
    slug: task.slug,
    filePath: task.filePath,
    triggerSource: task.triggerSource,
    queue: task.queue?.name ?? null,
    machine: machineOf(task),
    maxDurationSeconds: task.maxDurationInSeconds,
    maxAttempts: RetryConfig.parse(task.retryConfig ?? null)?.maxAttempts ?? null,
  }));
  const queues = worker.queues
    .filter((q) => q.role === "QUEUE")
    .map((q) => ({
      name: q.name,
      concurrencyLimit: limitOf(q),
      tasks: worker.tasks.filter((t) => t.queue?.id === q.id).map((t) => t.slug),
    }));
  const concurrencyLimits = worker.queues.filter(isNamedLimit).map((q) => ({
    name: q.name.slice(CONCURRENCY_LIMIT_QUEUE_PREFIX.length),
    concurrencyLimit: limitOf(q),
    tasks: worker.tasks
      .filter((t) => Gates.parse(t.gates ?? null)?.some((g) => g.queue === q.name))
      .map((t) => t.slug),
  }));
  const schedules = parseEach(DeclaredSchedule, metadata.tasks).map((t) => ({
    taskId: t.id,
    cron: t.schedule.cron,
    timezone: t.schedule.timezone ?? "UTC",
  }));
  const subscribers = parseEach(DeclaredSubscriber, metadata.webhookSubscribers);
  const endpoints = parseEach(DeclaredEndpoint, metadata.webhookEndpoints).map((e) => ({
    id: e.id,
    source: e.source ?? null,
    filePath: e.filePath ?? null,
  }));
  // Subscribers of an endpoint another version declared still get a row.
  for (const subscriber of subscribers) {
    if (!endpoints.some((e) => e.id === subscriber.endpointId)) {
      endpoints.push({ id: subscriber.endpointId, source: null, filePath: null });
    }
  }
  const webhookEndpoints = endpoints.map((e) => ({
    ...e,
    subscribers: subscribers
      .filter((s) => s.endpointId === e.id)
      .map((s) => (s.target.type === "task" ? s.target.taskId : s.target.taskIdentifier)),
  }));
  return { tasks, queues, concurrencyLimits, schedules, webhookEndpoints };
}

function resourceItems(
  current: WorkerResources,
  previous: WorkerResources | undefined
): DeploymentResourceItems {
  const now = itemsOf(current);
  const before = previous ? itemsOf(previous) : undefined;
  const machines = new Map<string | null, number>();
  for (const task of current.tasks) {
    const machine = machineOf(task);
    machines.set(machine, (machines.get(machine) ?? 0) + 1);
  }
  return {
    tasks: withChanges(now.tasks, before?.tasks, (t) => t.slug),
    queues: withChanges(now.queues, before?.queues, (q) => q.name),
    concurrencyLimits: withChanges(now.concurrencyLimits, before?.concurrencyLimits, (q) => q.name),
    schedules: withChanges(now.schedules, before?.schedules, (s) => `${s.taskId} ${s.cron}`),
    webhookEndpoints: withChanges(now.webhookEndpoints, before?.webhookEndpoints, (e) => e.id),
    machines: [...machines.entries()]
      .map(([name, tasks]) => ({ name, tasks }))
      .sort((a, b) => b.tasks - a.tasks),
  };
}

function countsFor(worker: WorkerResources): DeploymentCounts {
  const { tasks } = worker;
  const metadata = StoredWorkerMetadata.parse(worker.metadata ?? {});
  const presets = new Set(tasks.flatMap((t) => machineOf(t) ?? []));
  return {
    tasks: tasks.length,
    scheduled: tasks.filter((t) => t.triggerSource === "SCHEDULED").length,
    agents: tasks.filter((t) => t.triggerSource === "AGENT").length,
    webhookTasks: tasks.filter((t) => t.triggerSource === "WEBHOOK").length,
    queues: worker.queues.filter((q) => q.role === "QUEUE").length,
    // Named limits only; a task's inline limit lives on a limit/task/ row.
    concurrencyLimits: worker.queues.filter(isNamedLimit).length,
    // Stored metadata keeps only the tasks that declare a schedule in code.
    declaredSchedules: metadata.tasks?.length ?? 0,
    webhookEndpoints: metadata.webhookEndpoints?.length ?? 0,
    webhookSubscribers: metadata.webhookSubscribers?.length ?? 0,
    machinePresets: presets.size,
    files: worker._count.files,
  };
}

const workerTaskSelect = {
  slug: true,
  filePath: true,
  triggerSource: true,
  machineConfig: true,
  retryConfig: true,
  maxDurationInSeconds: true,
  gates: true,
  queue: { select: { id: true, name: true } },
} as const;

/** Everything counted per worker, in one read (the relations go through the join tables' indexes). */
const workerResourcesSelect = {
  id: true,
  metadata: true,
  queues: {
    select: {
      id: true,
      name: true,
      role: true,
      concurrencyLimit: true,
      totalConcurrencyLimit: true,
    },
    orderBy: { name: "asc" },
  },
  _count: { select: { files: true } },
} as const;

/**
 * What a deployed version contains and what has run on it. Resources are diffed against the deploy
 * before it in the same environment (the code that changed). The runs chart covers the version's
 * first week at most; the tasks' activity is the last 24 hours, like the tasks list.
 */
export class DeploymentOverviewPresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {}

  async call({
    organizationId,
    projectId,
    environmentId,
    deploymentId,
    now = new Date(),
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    deploymentId: string;
    now?: Date;
  }) {
    const deployment = await this.replica.workerDeployment.findFirst({
      where: { id: deploymentId, environmentId },
      select: {
        version: true,
        createdAt: true,
        deployedAt: true,
        worker: {
          select: {
            ...workerResourcesSelect,
            tasks: { select: workerTaskSelect, orderBy: { slug: "asc" } },
          },
        },
      },
    });
    if (!deployment?.worker) return null;

    // Uses @@index([environmentId, createdAt]).
    const previous = await this.replica.workerDeployment.findFirst({
      where: { environmentId, status: "DEPLOYED", createdAt: { lt: deployment.createdAt } },
      orderBy: { createdAt: "desc" },
      select: {
        version: true,
        shortCode: true,
        createdAt: true,
        deployedAt: true,
        worker: {
          select: {
            ...workerResourcesSelect,
            tasks: { select: workerTaskSelect, orderBy: { slug: "asc" } },
          },
        },
      },
    });

    const start = deployment.deployedAt ?? deployment.createdAt;
    const windowMs = Math.max(60_000, Math.min(MAX_WINDOW_MS, now.getTime() - start.getTime()));
    const current = { version: deployment.version, from: start, to: addMs(start, windowMs) };

    // The slow parts, which the route defers so the page renders without them: ClickHouse, and
    // the prompt versions (their table has no index on the worker).
    const prompts = this.#promptVersions(environmentId, deployment.worker.id).catch((error) => {
      logger.error("Deployment prompt versions query threw", { error, version: current.version });
      return [];
    });
    const chart = this.#chart(organizationId, projectId, environmentId, current).catch((error) => {
      logger.error("Deployment run activity query threw", { error, version: current.version });
      return { data: [], statuses: [] };
    });
    const slugs = deployment.worker.tasks.map((task) => task.slug);
    const taskActivity: Promise<VersionTaskActivity> = this.#taskActivity(
      organizationId,
      projectId,
      environmentId,
      deployment.version,
      slugs,
      start,
      now
    ).catch((error) => {
      logger.error("Deployment task activity query threw", { error, version: current.version });
      return { hourly: {}, running: {} };
    });

    const tasks = deployment.worker.tasks;
    const previousTasks = previous?.worker?.tasks ?? [];
    const previousSlugs = new Set(previousTasks.map((t) => t.slug));

    return {
      overview: {
        windowMs,
        previous: previous
          ? {
              version: previous.version,
              shortCode: previous.shortCode,
              counts: previous.worker ? countsFor(previous.worker) : undefined,
            }
          : undefined,
        counts: countsFor(deployment.worker),
        resources: resourceItems(deployment.worker, previous?.worker ?? undefined),
        tasks: tasks.map((task): DeploymentTaskRow => ({
          slug: task.slug,
          filePath: task.filePath,
          triggerSource: task.triggerSource,
          added: !!previous && !previousSlugs.has(task.slug),
        })),
      },
      chart,
      taskActivity,
      prompts,
    };
  }

  /**
   * Prompt versions the worker created, at most one per prompt. prompt_versions has no workerId
   * index, so this goes through the environment's prompts (@@index([runtimeEnvironmentId])) and
   * @@index([promptId]), and its cost follows the environment's prompt versions.
   */
  async #promptVersions(environmentId: string, workerId: string): Promise<DeploymentPrompts> {
    const rows = await this.replica.promptVersion.findMany({
      where: { workerId, prompt: { runtimeEnvironmentId: environmentId } },
      select: { version: true, model: true, prompt: { select: { slug: true } } },
      orderBy: { prompt: { slug: "asc" } },
    });
    return rows.map((row) => ({ slug: row.prompt.slug, version: row.version, model: row.model }));
  }

  /** Runs on this version by status group over its window, the task page's chart buckets. */
  async #chart(
    organizationId: string,
    projectId: string,
    environmentId: string,
    current: VersionWindow
  ): Promise<{ data: ActivitySeriesPoint[]; statuses: string[] }> {
    const bucketSeconds = chooseBucketSeconds(current.to.getTime() - current.from.getTime(), {
      targetBuckets: 48,
      maxBuckets: 96,
    });
    const queryFn = this.clickhouse.reader.query({
      name: "deploymentVersionRunActivity",
      // Runs queued before the deploy land in the first bucket.
      query: `SELECT
          toUnixTimestamp(toStartOfInterval(greatest(created_at, {fromTime: DateTime64(3, 'UTC')}), INTERVAL {bucketSeconds: UInt32} SECOND)) AS bucket,
          status,
          count() AS val
        FROM trigger_dev.task_runs_v2 FINAL
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND task_version = {version: String}
          AND created_at >= {scanFrom: DateTime64(3, 'UTC')}
          AND created_at < {toTime: DateTime64(3, 'UTC')}
          AND _is_deleted = 0
        GROUP BY bucket, status
        ORDER BY bucket`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        version: z.string(),
        bucketSeconds: z.number(),
        fromTime: z.string(),
        scanFrom: z.string(),
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
      version: current.version,
      bucketSeconds,
      fromTime: chTime(current.from),
      scanFrom: chTime(addMs(current.from, -QUEUED_BEFORE_MS)),
      toTime: chTime(current.to),
    });

    if (error) {
      logger.error("Deployment run activity query failed", { error, version: current.version });
      return { data: [], statuses: [] };
    }

    return {
      data: zeroFillGroupedSeries({
        rows,
        from: current.from,
        to: current.to,
        bucketSeconds,
        orderedKeys: RUN_STATUS_GROUPS,
        groupFn: groupRunStatus,
        fallbackKey: "RUNNING",
      }),
      statuses: [...RUN_STATUS_GROUPS],
    };
  }

  /**
   * The tasks list's Running and Activity (24h) columns for this version: one query for the hourly
   * runs by status, one for the runs executing now. Both filter on task_version under the
   * (organization_id, project_id, environment_id, created_at) sort key prefix.
   */
  async #taskActivity(
    organizationId: string,
    projectId: string,
    environmentId: string,
    version: string,
    slugs: string[],
    deployedAt: Date,
    now: Date
  ): Promise<VersionTaskActivity> {
    if (slugs.length === 0) return { hourly: {}, running: {} };

    const hourlyQuery = this.clickhouse.reader.query({
      name: "deploymentVersionTaskActivity",
      query: `SELECT
          task_identifier,
          toStartOfHour(created_at) AS bucket,
          status,
          count() AS val
        FROM trigger_dev.task_runs_v2 FINAL
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND task_version = {version: String}
          AND created_at >= {from: DateTime64(3, 'UTC')}
          AND _is_deleted = 0
        GROUP BY task_identifier, bucket, status`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        version: z.string(),
        from: z.string(),
      }),
      schema: z.object({
        task_identifier: z.string(),
        bucket: z.string(),
        status: z.string(),
        val: z.coerce.number(),
      }),
    });
    // A run still executing started on this version, at most a week ago (the longest window).
    const runningQuery = this.clickhouse.reader.query({
      name: "deploymentVersionTaskRunning",
      query: `SELECT task_identifier, count() AS running
        FROM trigger_dev.task_runs_v2 FINAL
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND task_version = {version: String}
          AND created_at >= {from: DateTime64(3, 'UTC')}
          AND status = 'EXECUTING'
          AND _is_deleted = 0
        GROUP BY task_identifier`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        version: z.string(),
        from: z.string(),
      }),
      schema: z.object({ task_identifier: z.string(), running: z.coerce.number() }),
    });

    // 24 hourly buckets ending at the current hour, keyed like ClickHouse's toStartOfHour().
    const firstHour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
    const buckets = Array.from({ length: 24 }, (_, i) => {
      const date = new Date(firstHour + i * HOUR_MS);
      return { key: date.toISOString().slice(0, 13).replace("T", " ") + ":00:00", date };
    });
    const runningFrom = new Date(
      Math.max(deployedAt.getTime() - QUEUED_BEFORE_MS, now.getTime() - MAX_WINDOW_MS)
    );
    const base = { organizationId, projectId, environmentId, version };

    const [[hourlyError, hourlyRows], [runningError, runningRows]] = await Promise.all([
      hourlyQuery({ ...base, from: chTime(new Date(firstHour)) }),
      runningQuery({ ...base, from: chTime(runningFrom) }),
    ]);
    if (hourlyError) logger.error("Deployment task activity query failed", { error: hourlyError });
    if (runningError) logger.error("Deployment task running query failed", { error: runningError });

    const bySlug = new Map<string, Map<string, VersionTaskActivityBucket>>();
    for (const row of hourlyRows ?? []) {
      const perSlug = bySlug.get(row.task_identifier) ?? new Map();
      bySlug.set(row.task_identifier, perSlug);
      const bucket = perSlug.get(row.bucket) ?? { date: new Date(0), total: 0 };
      perSlug.set(row.bucket, bucket);
      const status = row.status as TaskRunStatus;
      bucket[status] = (bucket[status] ?? 0) + row.val;
      bucket.total += row.val;
    }

    return {
      hourly: Object.fromEntries(
        slugs.map((slug) => [
          slug,
          buckets.map(({ key, date }) => ({
            ...(bySlug.get(slug)?.get(key) ?? { total: 0 }),
            date,
          })),
        ])
      ),
      running: Object.fromEntries(
        (runningRows ?? []).map((row) => [row.task_identifier, row.running])
      ),
    };
  }
}

type VersionWindow = { version: string; from: Date; to: Date };

function addMs(date: Date, ms: number) {
  return new Date(date.getTime() + ms);
}

/** ClickHouse's DateTime64(3, 'UTC') parser rejects the trailing `Z` of toISOString(). */
function chTime(date: Date) {
  return date.toISOString().slice(0, -1);
}
