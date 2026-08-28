/**
 * Default IO wiring for the watch checks. Run state and queue existence are authoritative
 * Postgres point-reads, and readers throw rather than invent a zero on a broken source.
 */

import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { $replica, prisma } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { ReportPresenter } from "~/presenters/v3/reports/ReportPresenter.server";
import { engine } from "~/v3/runEngine.server";
import { runStore } from "~/v3/runStore.server";
import type {
  WatchCheckDeps,
  WatchErrorRecurrence,
  WatchHealthSeverity,
  WatchHealthSnapshot,
  WatchQueueDepth,
  WatchQueueOldestAge,
  WatchRunRow,
} from "./dashboardAgentWatchChecks";

const WATCH_RUN_SELECT = {
  friendlyId: true,
  status: true,
  queue: true,
  createdAt: true,
  queuedAt: true,
  startedAt: true,
  completedAt: true,
  delayUntil: true,
} as const;

/** The single Postgres point-read: one run, scoped to the watch's environment. */
export async function readWatchRun(
  runFriendlyId: string,
  environmentId: string
): Promise<WatchRunRow | null> {
  const run = await runStore.findRun(
    { friendlyId: runFriendlyId, runtimeEnvironmentId: environmentId },
    { select: WATCH_RUN_SELECT },
    $replica
  );
  return run ?? null;
}

/** One Postgres point-read: does this queue exist in the environment? */
export async function watchQueueExists(environmentId: string, queueName: string): Promise<boolean> {
  const queue = await $replica.taskQueue.findFirst({
    where: { runtimeEnvironmentId: environmentId, name: queueName },
    select: { id: true },
  });
  return queue !== null;
}

/** The same run read on the primary, for a target that may have been created a moment ago. */
export async function readWatchRunOnPrimary(
  runFriendlyId: string,
  environmentId: string
): Promise<WatchRunRow | null> {
  const run = await runStore.findRunOnPrimary(
    { friendlyId: runFriendlyId, runtimeEnvironmentId: environmentId },
    { select: WATCH_RUN_SELECT }
  );
  return run ?? null;
}

/** The same queue read on the primary. */
export async function watchQueueExistsOnPrimary(
  environmentId: string,
  queueName: string
): Promise<boolean> {
  const queue = await prisma.taskQueue.findFirst({
    where: { runtimeEnvironmentId: environmentId, name: queueName },
    select: { id: true },
  });
  return queue !== null;
}

/** How far back the ClickHouse depth fallback looks when the live counter is down. */
const DEPTH_FALLBACK_MINUTES = 10;
const DEPTH_FALLBACK_BUCKET_SECONDS = 60;
/**
 * How far behind `now` the newest analytics bucket may end and still count as current.
 * One bucket of slack: anything older leaves runs queued in the gap invisible.
 */
const DEPTH_FRESH_TOLERANCE_MS = DEPTH_FALLBACK_BUCKET_SECONDS * 1000;

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** ClickHouse renders DateTime without a zone; the column is UTC. */
function parseClickhouseDateTime(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

/**
 * Current pending count for one queue. The live counter is the truth; the ClickHouse fallback
 * reports the newest bucket's peak depth and is `current` only if it reaches the present.
 */
export async function readWatchQueueDepth(
  environment: AuthenticatedEnvironment,
  queueName: string,
  now: Date = new Date()
): Promise<WatchQueueDepth | null> {
  const live = await engine.lengthOfQueue(environment, queueName).catch(() => null);
  if (typeof live === "number" && Number.isFinite(live)) {
    return { depth: live, source: "live_queue", current: true, asOf: now };
  }

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    environment.organizationId,
    "query"
  );

  const bucketMs = DEPTH_FALLBACK_BUCKET_SECONDS * 1000;
  const endMs = Math.ceil(now.getTime() / bucketMs) * bucketMs;
  const startMs = endMs - DEPTH_FALLBACK_MINUTES * 60_000;

  const [error, rows] = await clickhouse.queueMetrics.depthSparklines({
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    environmentId: environment.id,
    queueNames: [queueName],
    startTime: formatClickhouseDateTime(new Date(startMs)),
    endTime: formatClickhouseDateTime(new Date(endMs)),
    bucketSeconds: DEPTH_FALLBACK_BUCKET_SECONDS,
  });

  if (error) throw error;
  if (!rows || rows.length === 0) return null;

  // Newest bucket wins: the closest the rollup gets to now.
  const newest = rows.reduce((best, row) => (row.bucket > best.bucket ? row : best), rows[0]!);
  const bucketEnd = new Date(parseClickhouseDateTime(newest.bucket).getTime() + bucketMs);
  const current = bucketEnd.getTime() >= now.getTime() - DEPTH_FRESH_TOLERANCE_MS;

  return { depth: newest.depth, source: "queue_metrics", current, asOf: bucketEnd };
}

/**
 * How long the oldest still-waiting run in a queue has waited: for a concurrency-keyed queue the
 * worst across keys with a live backlog. `null` can't be read, `ageMs: null` is empty.
 */
export async function readWatchQueueOldestAge(
  environment: AuthenticatedEnvironment,
  queueName: string,
  now: Date = new Date()
): Promise<WatchQueueOldestAge | null> {
  const [breakdown, oldestQueuedAt] = await Promise.all([
    engine
      .concurrencyKeyBreakdown(environment, queueName, { limit: OLDEST_AGE_CK_LIMIT })
      .catch(() => null),
    engine.oldestMessageInQueue(environment, queueName).catch(() => null),
  ]);

  // A partial read would under-report the wait and silently miss the SLA, so either read
  // failing makes the whole reading unavailable rather than a healthy zero.
  if (breakdown === null || oldestQueuedAt === null) return null;

  const waitingKeys = breakdown.keys.filter((key) => key.queued > 0);
  const ageMs =
    waitingKeys.length > 0
      ? waitingKeys.reduce((max, key) => Math.max(max, now.getTime() - key.oldestEnqueuedAt), 0)
      : typeof oldestQueuedAt === "number"
        ? Math.max(0, now.getTime() - oldestQueuedAt)
        : null;

  return { ageMs, source: "live_queue", current: true, asOf: now };
}

/**
 * Same cap the queue detail page reads keys with. It cannot under-report the wait: the ckIndex
 * is scored by each key's oldest enqueue time and read ascending, so the oldest key is the first
 * of the page whatever the cardinality.
 */
const OLDEST_AGE_CK_LIMIT = 50;

const MINUTE_MS = 60_000;

type OrganizationClickhouse = Awaited<
  ReturnType<typeof clickhouseFactory.getClickhouseForOrganization>
>;

/**
 * The fingerprint's most recent occurrence at millisecond precision, from `errors_v1`. The
 * per-minute rollup can't separate the prompting error from a recurrence in the same minute.
 */
async function readErrorLastSeen(
  clickhouse: OrganizationClickhouse,
  environment: AuthenticatedEnvironment,
  fingerprint: string
): Promise<Date | null> {
  const builder = clickhouse.errors.activeErrorsSinceQueryBuilder();
  builder.where("organization_id = {organizationId: String}", {
    organizationId: environment.organizationId,
  });
  builder.where("project_id = {projectId: String}", { projectId: environment.projectId });
  builder.where("environment_id = {environmentId: String}", { environmentId: environment.id });
  builder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
  builder.groupBy("environment_id, task_identifier, error_fingerprint");

  const [error, rows] = await builder.execute();
  if (error) throw error;
  if (!rows || rows.length === 0) return null;

  let lastSeenMs = 0;
  for (const row of rows) {
    const ms = Number(row.last_seen);
    if (Number.isFinite(ms) && ms > lastSeenMs) lastSeenMs = ms;
  }

  return lastSeenMs > 0 ? new Date(lastSeenMs) : null;
}

/**
 * What we know about a fingerprint relative to `since`. `errors_v1` decides whether it
 * recurred; the rollup's count is a lower bound when the creation-minute bucket has hits.
 */
export async function readWatchErrorRecurrence(
  environment: AuthenticatedEnvironment,
  fingerprint: string,
  since: Date
): Promise<WatchErrorRecurrence | null> {
  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    environment.organizationId,
    "logs"
  );

  const lastSeenAt = await readErrorLastSeen(clickhouse, environment, fingerprint);
  // Never seen in this environment at all.
  if (!lastSeenAt) return null;

  const notRecurred: WatchErrorRecurrence = {
    occurredAt: null,
    occurredAtPrecision: null,
    countSince: 0,
    countApproximate: false,
    lastSeenAt,
  };
  if (lastSeenAt.getTime() <= since.getTime()) return notRecurred;

  // Something landed after `since`; the rollup fills in the count and the minute.
  const sinceMinuteMs = Math.floor(since.getTime() / MINUTE_MS) * MINUTE_MS;
  const queryBuilder = clickhouse.errors.createOccurrencesQueryBuilder("INTERVAL 1 MINUTE");
  queryBuilder.where("organization_id = {organizationId: String}", {
    organizationId: environment.organizationId,
  });
  queryBuilder.where("project_id = {projectId: String}", { projectId: environment.projectId });
  queryBuilder.where("environment_id = {environmentId: String}", { environmentId: environment.id });
  queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
  // The creation minute is included; its occurrences are counted separately below.
  queryBuilder.where("minute >= toStartOfMinute(fromUnixTimestamp64Milli({sinceMs: Int64}))", {
    sinceMs: since.getTime(),
  });
  queryBuilder.groupBy("error_fingerprint, bucket_epoch");
  queryBuilder.orderBy("bucket_epoch ASC");

  const [error, rows] = await queryBuilder.execute();
  if (error) throw error;

  let earliestAfterMs: number | null = null;
  let countAfter = 0;
  let creationMinuteCount = 0;

  for (const row of rows ?? []) {
    const bucketMs = row.bucket_epoch * 1000;
    if (bucketMs <= sinceMinuteMs) {
      creationMinuteCount += row.count;
      continue;
    }
    countAfter += row.count;
    if (earliestAfterMs === null || bucketMs < earliestAfterMs) earliestAfterMs = bucketMs;
  }

  // The earliest provable occurrence: a bucket starting after the creation minute, or the
  // exact `last_seen` when that is the only evidence.
  const useBucket = earliestAfterMs !== null && earliestAfterMs < lastSeenAt.getTime();

  return {
    occurredAt: useBucket ? new Date(earliestAfterMs!) : lastSeenAt,
    occurredAtPrecision: useBucket ? "minute" : "exact",
    // At least the one `errors_v1` proved, even if the rollup lags behind it.
    countSince: Math.max(1, countAfter),
    countApproximate: creationMinuteCount > 0,
    lastSeenAt,
  };
}

const HEALTH_SEVERITIES = new Set<string>(["ok", "warn", "crit"]);

/**
 * The health report's current verdict, from the existing interpreter. No health reasoning
 * is re-implemented here.
 */
export async function readWatchHealth(
  environment: AuthenticatedEnvironment
): Promise<WatchHealthSnapshot | null> {
  const report = await new ReportPresenter().call({ environment, key: "health" });
  if (!report) return null;

  const severity = report.summary.severity;
  if (!HEALTH_SEVERITIES.has(severity)) return null;

  const trustworthy = (report.facts as { trustworthy?: unknown } | undefined)?.trustworthy;
  return {
    // An absent trust marker counts as untrustworthy.
    trustworthy: trustworthy === true,
    severity: severity as WatchHealthSeverity,
  };
}

export function watchCheckDeps(
  environment: AuthenticatedEnvironment,
  now: Date = new Date()
): WatchCheckDeps {
  return {
    readRun: (runId) => readWatchRun(runId, environment.id),
    queueExists: (queue) => watchQueueExists(environment.id, queue),
    readQueueDepth: (queue) => readWatchQueueDepth(environment, queue, now),
    readQueueOldestAge: (queue) => readWatchQueueOldestAge(environment, queue, now),
    readErrorRecurrence: (fingerprint, since) =>
      readWatchErrorRecurrence(environment, fingerprint, since),
    readHealth: () => readWatchHealth(environment),
  };
}

/**
 * Creation-time deps. The target reads go to the primary, so a run or queue created moments
 * ago is visible instead of failing as a non-existent target inside the replication window.
 */
export function watchCreationCheckDeps(
  environment: AuthenticatedEnvironment,
  now: Date = new Date()
): WatchCheckDeps {
  return {
    ...watchCheckDeps(environment, now),
    readRun: (runId) => readWatchRunOnPrimary(runId, environment.id),
    queueExists: (queue) => watchQueueExistsOnPrimary(environment.id, queue),
  };
}
