import { z } from "zod";
import type { ClickhouseReader, ClickhouseWriter } from "./client/types.js";

export const QueueMetricsRawV1Input = z.object({
  organization_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  queue_name: z.string(),
  concurrency_key: z.string().optional(),
  event_time: z.string(),
  // Exact UInt64 ordering key; a string preserves precision past JS safe-integer range
  // (see entryOrderKey). A plain number is still accepted for small test values.
  order_key: z.union([z.string(), z.number()]).optional(),
  op: z.enum(["gauge", "enqueue", "started", "ack", "nack", "dlq"]),
  running: z.number().optional(),
  queued: z.number().optional(),
  queue_limit: z.number().optional(),
  env_running: z.number().optional(),
  env_queued: z.number().optional(),
  env_limit: z.number().optional(),
  throttled: z.number().optional(),
  ck_backlogged: z.number().optional(),
  ck_max_wait_ms: z.number().optional(),
  wait_ms: z.number().optional(),
  cumulative: z.number().optional(),
});

export type QueueMetricsRawV1Input = z.input<typeof QueueMetricsRawV1Input>;

export function insertQueueMetricsRaw(ch: ClickhouseWriter) {
  return ch.insertUnsafe<QueueMetricsRawV1Input>({
    name: "insertQueueMetricsRaw",
    table: "trigger_dev.queue_metrics_raw_v1",
  });
}

// --- Reads (Queues list metrics + health) ---

const QueueMetricsListParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  queueNames: z.array(z.string()),
  startTime: z.string(),
  endTime: z.string(),
});

const QueueMetricsSummaryRow = z.object({
  queue_name: z.string(),
  p50_wait_ms: z.coerce.number(),
  p95_wait_ms: z.coerce.number(),
  peak_queued: z.coerce.number(),
  started_count: z.coerce.number(),
  throttled_count: z.coerce.number(),
});

// Callers align window bounds to the bucket grid so repeated loads share cache entries.
const QUEUE_METRICS_CACHE_SETTINGS = {
  use_query_cache: 1,
  query_cache_ttl: 30,
} as const;

/** Per-queue rollups over a window, for a fixed set of queues (the visible page). */
export function getQueueListMetricsSummary(reader: ClickhouseReader) {
  return reader.query({
    name: "getQueueListMetricsSummary",
    query: `SELECT
        queue_name,
        round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[1]) AS p50_wait_ms,
        round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[3]) AS p95_wait_ms,
        max(max_queued) AS peak_queued,
        deltaSumTimestampMerge(started_delta) AS started_count,
        sum(throttled_count) AS throttled_count
      FROM trigger_dev.queue_metrics_v1
      WHERE organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND queue_name IN {queueNames: Array(String)}
        AND bucket_start >= {startTime: DateTime}
        AND bucket_start < {endTime: DateTime}
      GROUP BY queue_name`,
    params: QueueMetricsListParams,
    schema: QueueMetricsSummaryRow,
    settings: QUEUE_METRICS_CACHE_SETTINGS,
  });
}

const QueueDepthSparklineParams = QueueMetricsListParams.extend({
  bucketSeconds: z.number(),
});

const QueueDepthSparklineRow = z.object({
  queue_name: z.string(),
  bucket: z.string(),
  depth: z.coerce.number(),
  throttled: z.coerce.number(),
});

/**
 * Per-queue, per-bucket peak depth (carry-forward filled by the caller) plus the throttled
 * count in each bucket, so the sparkline can tint the exact buckets where throttling occurred.
 * The extra aggregate rides the same scan as the depth series — no additional round trip.
 */
export function getQueueDepthSparklines(reader: ClickhouseReader) {
  return reader.query({
    name: "getQueueDepthSparklines",
    query: `SELECT
        queue_name,
        toStartOfInterval(bucket_start, toIntervalSecond({bucketSeconds: UInt32})) AS bucket,
        max(max_queued) AS depth,
        sum(throttled_count) AS throttled
      FROM trigger_dev.queue_metrics_v1
      WHERE organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND queue_name IN {queueNames: Array(String)}
        AND bucket_start >= {startTime: DateTime}
        AND bucket_start < {endTime: DateTime}
      GROUP BY queue_name, bucket
      ORDER BY bucket`,
    params: QueueDepthSparklineParams,
    schema: QueueDepthSparklineRow,
    settings: QUEUE_METRICS_CACHE_SETTINGS,
  });
}

const QueueRankingParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  startTime: z.string(),
  /** 1 = rank by peak backlog only; 0 = backlog + running ("busiest"). */
  byQueuedOnly: z.number(),
  nameContains: z.string(),
  limit: z.number(),
  offset: z.number(),
});

const QueueRankingRow = z.object({
  queue_name: z.string(),
  ranked_total: z.coerce.number(),
});

// Ranking reads the 5m rollup: a 15-minute window there costs ~30x fewer rows than the
// 10s table.
const RANKING_WHERE = `organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND bucket_start >= {startTime: DateTime}
        AND queue_name != '__overflow__'
        AND ({nameContains: String} = '' OR positionCaseInsensitive(queue_name, {nameContains: String}) > 0)`;

/**
 * One page of queue names ranked by recent activity, with the total ranked count on
 * every row (window function), so page + count cost a single scan.
 */
export function getQueueRanking(reader: ClickhouseReader) {
  return reader.query({
    name: "getQueueRanking",
    query: `SELECT queue_name, count() OVER () AS ranked_total
      FROM (
        SELECT queue_name
        FROM trigger_dev.queue_metrics_5m_v1
        WHERE ${RANKING_WHERE}
        GROUP BY queue_name
        ORDER BY
          if({byQueuedOnly: UInt8} = 1, max(max_queued), max(max_queued) + max(max_running)) DESC,
          queue_name ASC
      )
      LIMIT {limit: UInt32} OFFSET {offset: UInt32}`,
    params: QueueRankingParams,
    schema: QueueRankingRow,
    settings: QUEUE_METRICS_CACHE_SETTINGS,
  });
}

const QueueRankingNamesParams = QueueRankingParams.omit({ byQueuedOnly: true, offset: true });

const QueueRankingNameRow = z.object({
  queue_name: z.string(),
});

/** All ranked queue names (activity order), used to exclude them from the alphabetical tail. */
export function getQueueRankingNames(reader: ClickhouseReader) {
  return reader.query({
    name: "getQueueRankingNames",
    query: `SELECT queue_name
      FROM trigger_dev.queue_metrics_5m_v1
      WHERE ${RANKING_WHERE}
      GROUP BY queue_name
      ORDER BY max(max_queued) + max(max_running) DESC, queue_name ASC
      LIMIT {limit: UInt32}`,
    params: QueueRankingNamesParams,
    schema: QueueRankingNameRow,
    settings: QUEUE_METRICS_CACHE_SETTINGS,
  });
}

const QueueRankingCountParams = QueueRankingParams.omit({
  byQueuedOnly: true,
  limit: true,
  offset: true,
});

const QueueRankingCountRow = z.object({
  ranked: z.coerce.number(),
});

/** Ranked-queue count alone, for pages past the ranked head (approximate uniq is fine). */
export function getQueueRankingCount(reader: ClickhouseReader) {
  return reader.query({
    name: "getQueueRankingCount",
    query: `SELECT uniq(queue_name) AS ranked
      FROM trigger_dev.queue_metrics_5m_v1
      WHERE ${RANKING_WHERE}`,
    params: QueueRankingCountParams,
    schema: QueueRankingCountRow,
    settings: QUEUE_METRICS_CACHE_SETTINGS,
  });
}

// --- Per-concurrency-key ranking (the queue detail "Concurrency keys" table) ---

const ConcurrencyKeyRankingParams = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  queueName: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  /** Case-insensitive substring filter on the key ('' = no filter). */
  nameContains: z.string(),
  limit: z.number(),
  offset: z.number(),
});

const ConcurrencyKeyRankingRow = z.object({
  concurrency_key: z.string(),
  started: z.coerce.number(),
  peak_backlog: z.coerce.number(),
  peak_running: z.coerce.number(),
  mean_wait_ms: z.coerce.number(),
  ranked_total: z.coerce.number(),
});

// The per-key table (queue_metrics_ck_v1) is activity-bound and its ORDER BY starts with the
// tenant + queue, so filtering to one queue prunes to a contiguous index range — the aggregate
// is bounded by real activity, never by total key cardinality. There is no per-key 5m rollup,
// so this reads the 10s tier directly (the pre-existing LIMIT-50 query did the same).
const CK_RANKING_WHERE = `organization_id = {organizationId: String}
        AND project_id = {projectId: String}
        AND environment_id = {environmentId: String}
        AND queue_name = {queueName: String}
        AND bucket_start >= {startTime: DateTime}
        AND bucket_start < {endTime: DateTime}
        AND ({nameContains: String} = '' OR positionCaseInsensitive(concurrency_key, {nameContains: String}) > 0)`;

/**
 * One page of a queue's concurrency keys ranked by peak backlog over the window, with the total
 * ranked-key count on every row (window function) so page + count cost a single scan — the same
 * shape as getQueueRanking. The `concurrency_key ASC` tiebreak makes OFFSET paging stable across
 * keys that share a peak. Range stats (started/peak_backlog/peak_running/mean wait) come back on
 * the same rows; live "now" counts are enriched per page from Redis by the caller.
 */
export function getConcurrencyKeyRanking(reader: ClickhouseReader) {
  return reader.query({
    name: "getConcurrencyKeyRanking",
    query: `SELECT
        concurrency_key,
        started,
        peak_backlog,
        peak_running,
        mean_wait_ms,
        count() OVER () AS ranked_total
      FROM (
        SELECT
          concurrency_key,
          deltaSumTimestampMerge(started_delta) AS started,
          max(max_queued) AS peak_backlog,
          max(max_running) AS peak_running,
          if(sum(wait_ms_count) > 0, round(sum(wait_ms_sum) / sum(wait_ms_count)), 0) AS mean_wait_ms
        FROM trigger_dev.queue_metrics_ck_v1
        WHERE ${CK_RANKING_WHERE}
        GROUP BY concurrency_key
        ORDER BY peak_backlog DESC, concurrency_key ASC
      )
      LIMIT {limit: UInt32} OFFSET {offset: UInt32}`,
    params: ConcurrencyKeyRankingParams,
    schema: ConcurrencyKeyRankingRow,
    settings: QUEUE_METRICS_CACHE_SETTINGS,
  });
}

// (per-queue detail series is now fetched via TRQL + fillGaps from the metric resource route)
