/**
 * Default IO wiring for the watch checks — the ONLY place this feature touches a
 * datastore. Kept apart from `dashboardAgentWatchChecks.ts` so the checks stay
 * transport- and IO-independent (tests inject fake readers, never mocks).
 *
 * ClickHouse-first, with Postgres reserved for authoritative point-reads:
 *   - run state: ONE Postgres run row (by friendlyId + environment). Run state is
 *     transactional and must not be read from an analytics rollup.
 *   - queue depth: the LIVE run-queue counter (`engine.lengthOfQueue`) first — the
 *     same seam the queue pages and the waiting-run module use — with the
 *     ClickHouse depth series as fallback.
 *   - queue existence: ONE Postgres `TaskQueue` point-read.
 *   - error recurrence: ClickHouse `error_occurrences_v1` only.
 *   - health: the existing health report (loader + interpreter), unchanged.
 *
 * Readers THROW on failure rather than swallowing it, because `checkWatch` turns a
 * throw into `unavailable`. A reader that returned a made-up zero would fire a
 * watch on a broken data source.
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

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Current pending count for one queue. The live run-queue counter is the truth
 * ("is it drained RIGHT NOW"); ClickHouse is the fallback and reports the most
 * recent bucket's PEAK depth, which can only over-report — so a fallback zero
 * still means "nothing was queued in that bucket", never a false drain.
 */
export async function readWatchQueueDepth(
  environment: AuthenticatedEnvironment,
  queueName: string,
  now: Date = new Date()
): Promise<WatchQueueDepth | null> {
  const live = await engine.lengthOfQueue(environment, queueName).catch(() => null);
  if (typeof live === "number" && Number.isFinite(live)) {
    return { depth: live, source: "live_queue" };
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

  // Newest bucket wins — the closest thing the rollup has to "now".
  const newest = rows.reduce((best, row) => (row.bucket > best.bucket ? row : best), rows[0]!);
  return { depth: newest.depth, source: "queue_metrics" };
}

/**
 * The first occurrence of an error fingerprint after `since`, from the per-minute
 * `error_occurrences_v1` rollup.
 *
 * Buckets are filtered with `minute > since`, i.e. STRICTLY after, so an
 * occurrence in the same minute the watch was created can't be read as a
 * recurrence. That under-counts by at most the creation minute — the conservative
 * direction, since a watch must never fire on the error that prompted it.
 * `occurredAt` is therefore minute-granular by construction.
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

  const queryBuilder = clickhouse.errors.createOccurrencesQueryBuilder("INTERVAL 1 MINUTE");
  queryBuilder.where("organization_id = {organizationId: String}", {
    organizationId: environment.organizationId,
  });
  queryBuilder.where("project_id = {projectId: String}", { projectId: environment.projectId });
  queryBuilder.where("environment_id = {environmentId: String}", { environmentId: environment.id });
  queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
  queryBuilder.where("minute > toStartOfMinute(fromUnixTimestamp64Milli({sinceMs: Int64}))", {
    sinceMs: since.getTime(),
  });
  queryBuilder.groupBy("error_fingerprint, bucket_epoch");
  queryBuilder.orderBy("bucket_epoch ASC");

  const [error, rows] = await queryBuilder.execute();
  if (error) throw error;
  if (!rows || rows.length === 0) return null;

  let earliest = rows[0]!.bucket_epoch;
  let countSince = 0;
  for (const row of rows) {
    if (row.bucket_epoch < earliest) earliest = row.bucket_epoch;
    countSince += row.count;
  }

  return { occurredAt: new Date(earliest * 1000), countSince };
}

const HEALTH_SEVERITIES = new Set<string>(["ok", "warn", "crit"]);

/**
 * The health report's current verdict, straight from the existing interpreter —
 * the same `summary.severity` the dashboard and `get_report` show, and the same
 * `facts.trustworthy` trust marker. No health reasoning is re-implemented here.
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
    // Absent trust marker is treated as untrustworthy: recovery must never fire
    // off a report that didn't state it was trustworthy.
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
    readErrorRecurrence: (fingerprint, since) =>
      readWatchErrorRecurrence(environment, fingerprint, since),
    readHealth: () => readWatchHealth(environment),
  };
}
