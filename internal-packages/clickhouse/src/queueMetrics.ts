import { z } from "zod";
import type { ClickhouseReader, ClickhouseWriter } from "./client/types.js";

export const QueueMetricsRawV1Input = z.object({
  organization_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  queue_name: z.string(),
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
});

/** Per-queue rollups over a window, for a fixed set of queues (the visible page). */
export function getQueueListMetricsSummary(reader: ClickhouseReader) {
  return reader.query({
    name: "getQueueListMetricsSummary",
    query: `SELECT
        queue_name,
        round(quantilesMerge(0.5, 0.95)(wait_quantiles)[1]) AS p50_wait_ms,
        round(quantilesMerge(0.5, 0.95)(wait_quantiles)[2]) AS p95_wait_ms,
        max(max_queued) AS peak_queued,
        deltaSumTimestampMerge(started_delta) AS started_count
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
  });
}

const QueueDepthSparklineParams = QueueMetricsListParams.extend({
  bucketSeconds: z.number(),
});

const QueueDepthSparklineRow = z.object({
  queue_name: z.string(),
  bucket: z.string(),
  depth: z.coerce.number(),
});

/** Per-queue, per-bucket peak depth for inline sparklines (carry-forward filled by the caller). */
export function getQueueDepthSparklines(reader: ClickhouseReader) {
  return reader.query({
    name: "getQueueDepthSparklines",
    query: `SELECT
        queue_name,
        toStartOfInterval(bucket_start, toIntervalSecond({bucketSeconds: UInt32})) AS bucket,
        max(max_queued) AS depth
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
  });
}

// (per-queue detail series is now fetched via TRQL + fillGaps from the metric resource route)
