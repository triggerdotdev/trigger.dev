/**
 * Default IO wiring for `computeWaitingRunDiagnosis`, and the only place this feature touches a
 * datastore. Kept apart so the diagnosis stays IO-independent and tests can inject fake readers.
 *
 * The read budget per call is one Postgres run-row point-read, the existing `queue_metrics` readers
 * scoped to this single queue, and best-effort live counters from the run-queue.
 */

import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { $replica } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { engine } from "~/v3/runEngine.server";
import { runStore } from "~/v3/runStore.server";
import type { WaitingRunDeps, WaitingRunQueueSignals, WaitingRunRow } from "./waitingRunDiagnosis";

/** Recent window the rate/depth/throttling evidence is read over. */
const WINDOW_MINUTES = 15;
const BUCKET_SECONDS = 60;

export const WAITING_RUN_SELECT = {
  friendlyId: true,
  status: true,
  queue: true,
  concurrencyKey: true,
  createdAt: true,
  queuedAt: true,
  startedAt: true,
  delayUntil: true,
} as const;

/** One run, scoped to the authenticated environment. */
export async function findWaitingRun(
  runFriendlyId: string,
  environmentId: string
): Promise<WaitingRunRow | null> {
  const run = await runStore.findRun(
    { friendlyId: runFriendlyId, runtimeEnvironmentId: environmentId },
    { select: WAITING_RUN_SELECT },
    $replica
  );

  return run ?? null;
}

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Queue signals for one queue, enriched with the live run-queue counters. Every source degrades to
 * null independently: a ClickHouse outage still yields live depth, a Redis outage the series.
 */
export async function readQueueSignals(
  environment: AuthenticatedEnvironment,
  queueName: string,
  now: Date = new Date()
): Promise<WaitingRunQueueSignals | null> {
  const bucketMs = BUCKET_SECONDS * 1000;
  // Snap both bounds to the bucket grid so repeated calls share ClickHouse query-cache entries.
  const endMs = Math.ceil(now.getTime() / bucketMs) * bucketMs;
  const startMs = endMs - WINDOW_MINUTES * 60_000;
  const numBuckets = (WINDOW_MINUTES * 60) / BUCKET_SECONDS;

  const [metrics, live] = await Promise.all([
    readClickhouseSignals(environment, queueName, startMs, endMs, numBuckets),
    readLiveSignals(environment, queueName),
  ]);

  if (!metrics && !live) return null;

  return {
    queueName,
    windowMinutes: WINDOW_MINUTES,
    sampleBuckets: metrics?.sampleBuckets ?? 0,
    depthSeries: metrics?.depthSeries ?? [],
    throttledSeries: metrics?.throttledSeries ?? [],
    startedCount: metrics?.startedCount ?? null,
    waitP50Ms: metrics?.waitP50Ms ?? null,
    waitP95Ms: metrics?.waitP95Ms ?? null,
    liveDepth: live?.depth ?? null,
    envRunning: live?.envRunning ?? null,
    envLimit: environment.maximumConcurrencyLimit ?? null,
    queueRunning: live?.queueRunning ?? null,
  };
}

async function readClickhouseSignals(
  environment: AuthenticatedEnvironment,
  queueName: string,
  startMs: number,
  endMs: number,
  numBuckets: number
): Promise<{
  sampleBuckets: number;
  depthSeries: number[];
  throttledSeries: number[];
  startedCount: number | null;
  waitP50Ms: number | null;
  waitP95Ms: number | null;
} | null> {
  try {
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      environment.organizationId,
      "query"
    );

    const ids = {
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
      queueNames: [queueName],
      startTime: formatClickhouseDateTime(new Date(startMs)),
      endTime: formatClickhouseDateTime(new Date(endMs)),
    };

    const [summaryResult, sparklineResult] = await Promise.all([
      clickhouse.queueMetrics.listSummary(ids),
      clickhouse.queueMetrics.depthSparklines({ ...ids, bucketSeconds: BUCKET_SECONDS }),
    ]);

    const [summaryError, summaryRows] = summaryResult;
    const [sparklineError, sparklineRows] = sparklineResult;

    if (summaryError || sparklineError) {
      logger.warn("waitingRun: clickhouse query failed", {
        summaryError: summaryError?.message,
        sparklineError: sparklineError?.message,
      });
      return null;
    }

    // Depth is carry-forward filled, since a bucket with no emission means unchanged rather than
    // zero. Throttled is not filled: only real counts count as throttling.
    const byIndex = new Map<number, { depth: number; throttled: number }>();
    for (const row of sparklineRows ?? []) {
      const bucketMs = Date.parse(row.bucket.replace(" ", "T") + "Z");
      if (Number.isNaN(bucketMs)) continue;
      const index = Math.round((bucketMs - startMs) / (BUCKET_SECONDS * 1000));
      if (index < 0 || index >= numBuckets) continue;
      byIndex.set(index, { depth: row.depth, throttled: row.throttled });
    }

    const depthSeries: number[] = [];
    const throttledSeries: number[] = [];
    let last = 0;
    for (let i = 0; i < numBuckets; i++) {
      const bucket = byIndex.get(i);
      if (bucket !== undefined) last = bucket.depth;
      depthSeries.push(last);
      throttledSeries.push(bucket?.throttled ?? 0);
    }

    const summary = summaryRows?.[0];

    return {
      // Buckets that reported, which is the ETA's sample size rather than the grid width.
      sampleBuckets: byIndex.size,
      depthSeries,
      throttledSeries,
      startedCount: finiteOrNull(summary?.started_count),
      waitP50Ms: finiteOrNull(summary?.p50_wait_ms),
      waitP95Ms: finiteOrNull(summary?.p95_wait_ms),
    };
  } catch (error) {
    logger.warn("waitingRun: failed to read queue metrics", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function readLiveSignals(
  environment: AuthenticatedEnvironment,
  queueName: string
): Promise<{
  depth: number | null;
  envRunning: number | null;
  queueRunning: number | null;
} | null> {
  try {
    const [depth, envRunning, queueRunning] = await Promise.all([
      engine.lengthOfQueue(environment, queueName).catch(() => null),
      engine.concurrencyOfEnvQueue(environment).catch(() => null),
      engine.currentConcurrencyOfQueue(environment, queueName).catch(() => null),
    ]);

    if (depth === null && envRunning === null && queueRunning === null) return null;

    return { depth, envRunning, queueRunning };
  } catch (error) {
    logger.warn("waitingRun: failed to read live queue counters", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function waitingRunDeps(
  environment: AuthenticatedEnvironment,
  runFriendlyId: string,
  now: Date = new Date()
): WaitingRunDeps {
  return {
    readRun: () => findWaitingRun(runFriendlyId, environment.id),
    readQueueSignals: (queueName) => readQueueSignals(environment, queueName, now),
  };
}
