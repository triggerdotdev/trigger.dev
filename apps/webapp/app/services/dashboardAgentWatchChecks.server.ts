/**
 * Default IO wiring for the watch checks. Kept apart from
 * `dashboardAgentWatchChecks.ts` so the checks stay IO-independent.
 *
 * ClickHouse-first, with Postgres reserved for authoritative point-reads: run state is
 * transactional and must not come from an analytics rollup, and queue existence is one
 * Postgres read. Queue depth prefers the live run-queue counter with the ClickHouse
 * depth series as fallback. Error recurrence combines `errors_v1` for whether it
 * recurred with the per-minute rollup for the count.
 *
 * Readers throw on failure rather than swallowing it, because `checkWatch` turns a
 * throw into `unavailable`. A reader returning a made-up zero would fire a watch on a
 * broken data source.
 */

import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { $replica } from "~/db.server";
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

/** How far back the ClickHouse depth fallback looks when the live counter is down. */
const DEPTH_FALLBACK_MINUTES = 10;
const DEPTH_FALLBACK_BUCKET_SECONDS = 60;
/**
 * How far behind `now` the newest analytics bucket may end and still be read as "the
 * queue right now". One bucket of slack: anything older leaves a gap the rollup hasn't
 * covered, and runs queued in that gap would be invisible.
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
 * Current pending count for one queue. The live run-queue counter is the truth;
 * ClickHouse is the fallback and reports the most recent bucket's peak depth, which can
 * only over-report within that bucket.
 *
 * The fallback's `current` is false unless the newest bucket reaches the present: a
 * rollup minutes behind may hold an empty bucket while runs piled up after it, and
 * `checkBacklogDrain` turns such a stale zero into `unavailable`.
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

  // Newest bucket wins: the closest thing the rollup has to "now".
  const newest = rows.reduce((best, row) => (row.bucket > best.bucket ? row : best), rows[0]!);
  const bucketEnd = new Date(parseClickhouseDateTime(newest.bucket).getTime() + bucketMs);
  const current = bucketEnd.getTime() >= now.getTime() - DEPTH_FRESH_TOLERANCE_MS;

  return { depth: newest.depth, source: "queue_metrics", current, asOf: bucketEnd };
}

/**
 * How long the oldest run still waiting in one queue has been waiting, composed the
 * same way the queue detail page's oldest-wait block does it: for a concurrency-keyed
 * queue the worst across keys with a live backlog (a lingering index entry whose
 * subqueue drained would over-report), otherwise the queue's own oldest message.
 *
 * Live-only on purpose. The analytics rollup has no general oldest-wait gauge, and an
 * age is the reading staleness corrupts in both directions, so a failure here is
 * `unavailable` and the reading is always `current`.
 *
 * Returns `null` when the queue can't be read at all, `ageMs: null` when it is empty.
 */
export async function readWatchQueueOldestAge(
  environment: AuthenticatedEnvironment,
  queueName: string,
  now: Date = new Date()
): Promise<WatchQueueOldestAge | null> {
  const [breakdown, oldestQueuedAt] = await Promise.all([
    engine.concurrencyKeyBreakdown(environment, queueName, { limit: OLDEST_AGE_CK_LIMIT }),
    engine.oldestMessageInQueue(environment, queueName),
  ]);

  const waitingKeys = breakdown.keys.filter((key) => key.queued > 0);
  const ageMs =
    waitingKeys.length > 0
      ? waitingKeys.reduce((max, key) => Math.max(max, now.getTime() - key.oldestEnqueuedAt), 0)
      : typeof oldestQueuedAt === "number"
        ? Math.max(0, now.getTime() - oldestQueuedAt)
        : null;

  return { ageMs, source: "live_queue", current: true, asOf: now };
}

/** Same cap the queue detail page reads keys with. */
const OLDEST_AGE_CK_LIMIT = 50;

const MINUTE_MS = 60_000;

type OrganizationClickhouse = Awaited<
  ReturnType<typeof clickhouseFactory.getClickhouseForOrganization>
>;

/**
 * The fingerprint's most recent occurrence at millisecond precision, from the
 * `errors_v1` aggregate.
 *
 * This is what makes "has it come back?" answerable exactly. The per-minute rollup can
 * only place an error in a minute, and the minute a watch is created in holds both the
 * error that prompted the watch and any recurrence seconds later, so the rollup alone
 * can neither confirm nor deny a recurrence in that first minute.
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
 * What we know about an error fingerprint relative to `since`, from two reads:
 *
 * - `errors_v1` decides whether it recurred, to the millisecond, so an occurrence 40
 *   seconds after the watch was created still counts.
 * - `error_occurrences_v1` supplies the count and, for minutes after the creation
 *   minute, when. Its creation-minute bucket can't be split between the original error
 *   and a recurrence, so those occurrences only make `countSince` a lower bound.
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

  // Something landed after `since`. The rollup fills in the count and the minute.
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

  // The earliest time we can prove an occurrence at: a bucket that starts after the
  // creation minute, or the exact `last_seen` when that is the only evidence.
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
 * The health report's current verdict, straight from the existing interpreter: the same
 * `summary.severity` the dashboard and `get_report` show, and the same
 * `facts.trustworthy` marker. No health reasoning is re-implemented here.
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
    // An absent trust marker counts as untrustworthy: recovery must never fire off a
    // report that didn't state it was trustworthy.
    trustworthy: trustworthy === true,
    severity: severity as WatchHealthSeverity,
  };
}

/** Wire the real readers for one environment. */
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
