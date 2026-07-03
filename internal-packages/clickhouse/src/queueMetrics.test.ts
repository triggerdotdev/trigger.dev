import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickHouse } from "./index.js";
import type { QueueMetricsRawV1Input } from "./queueMetrics.js";

const ORG = "org_qm";
const PROJECT = "project_qm";
const ENV = "env_qm";
const EVENT_TIME = "2026-06-30 12:00:05"; // all rows land in the 10s bucket starting 12:00:00

function base(op: QueueMetricsRawV1Input["op"], queue: string): QueueMetricsRawV1Input {
  return {
    organization_id: ORG,
    project_id: PROJECT,
    environment_id: ENV,
    queue_name: queue,
    event_time: EVENT_TIME,
    op,
  };
}

// Cumulative counters: each op keeps a monotonic per-(queue,op) odometer, so a counter row
// carries the running total in `cumulative`. deltaSumTimestamp reconstructs the increase
// (last - first) from a seeded cum=0 baseline; order_key orders readings within an op.
let orderKey = 0;
function counter(
  op: QueueMetricsRawV1Input["op"],
  queue: string,
  total: number,
  waits?: number[]
): QueueMetricsRawV1Input[] {
  const rows: QueueMetricsRawV1Input[] = [
    { ...base(op, queue), cumulative: 0, order_key: orderKey++ },
  ];
  for (let cum = 1; cum <= total; cum++) {
    rows.push({
      ...base(op, queue),
      cumulative: cum,
      order_key: orderKey++,
      ...(waits ? { wait_ms: waits[cum - 1] } : {}),
    });
  }
  return rows;
}

const aggregatedRow = z.object({
  enqueue_count: z.coerce.number(),
  started_count: z.coerce.number(),
  ack_count: z.coerce.number(),
  nack_count: z.coerce.number(),
  dlq_count: z.coerce.number(),
  throttled_count: z.coerce.number(),
  max_running: z.coerce.number(),
  max_queued: z.coerce.number(),
  max_limit: z.coerce.number(),
  max_env_running: z.coerce.number(),
  max_env_queued: z.coerce.number(),
  max_env_limit: z.coerce.number(),
  wait_ms_sum: z.coerce.number(),
  wait_ms_count: z.coerce.number(),
  wait_p50: z.coerce.number(),
  wait_p90: z.coerce.number(),
  wait_p95: z.coerce.number(),
  wait_p99: z.coerce.number(),
});

function readAggregated(ch: ClickHouse) {
  return ch.reader.query({
    name: "read-queue-metrics-aggregated",
    query: `SELECT
        deltaSumTimestampMerge(enqueue_delta) AS enqueue_count,
        deltaSumTimestampMerge(started_delta) AS started_count,
        deltaSumTimestampMerge(ack_delta) AS ack_count,
        deltaSumTimestampMerge(nack_delta) AS nack_count,
        deltaSumTimestampMerge(dlq_delta) AS dlq_count,
        sum(throttled_count) AS throttled_count,
        max(max_running) AS max_running,
        max(max_queued) AS max_queued,
        max(max_limit) AS max_limit,
        max(max_env_running) AS max_env_running,
        max(max_env_queued) AS max_env_queued,
        max(max_env_limit) AS max_env_limit,
        sum(wait_ms_sum) AS wait_ms_sum,
        sum(wait_ms_count) AS wait_ms_count,
        quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles) AS wait_arr,
        wait_arr[1] AS wait_p50,
        wait_arr[2] AS wait_p90,
        wait_arr[3] AS wait_p95,
        wait_arr[4] AS wait_p99
      FROM trigger_dev.queue_metrics_v1
      WHERE queue_name = {queueName: String}
      GROUP BY organization_id, project_id, environment_id, queue_name, bucket_start`,
    schema: aggregatedRow,
    params: z.object({ queueName: z.string() }),
  });
}

// Synchronous insert so the MV-populated rows are queryable immediately.
const SYNC = { params: { clickhouse_settings: { async_insert: 0 as const } } };

describe("queue_metrics_v1", () => {
  clickhouseTest(
    "buckets counters, gauges and wait percentiles via the MV",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const queue = "queue-a";

      const rows: QueueMetricsRawV1Input[] = [
        ...counter("enqueue", queue, 3),
        ...counter("started", queue, 10, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]),
        ...counter("ack", queue, 2),
        ...counter("nack", queue, 1),
        ...counter("dlq", queue, 1),
        {
          ...base("gauge", queue),
          running: 8,
          queued: 4,
          queue_limit: 10,
          env_running: 40,
          env_queued: 10,
          env_limit: 50,
          throttled: 0,
        },
        {
          ...base("gauge", queue),
          running: 10,
          queued: 6,
          queue_limit: 10,
          env_running: 50,
          env_queued: 20,
          env_limit: 50,
          throttled: 1, // running >= limit AND queued > 0
        },
      ];

      const [insertError] = await ch.queueMetrics.insertRaw(rows, SYNC);
      expect(insertError).toBeNull();

      const [queryError, result] = await readAggregated(ch)({ queueName: queue });
      expect(queryError).toBeNull();
      expect(result).toHaveLength(1);
      const row = result![0]!;

      expect(row.enqueue_count).toBe(3);
      expect(row.started_count).toBe(10);
      expect(row.ack_count).toBe(2);
      expect(row.nack_count).toBe(1);
      expect(row.dlq_count).toBe(1);
      expect(row.throttled_count).toBe(1);

      expect(row.max_running).toBe(10);
      expect(row.max_queued).toBe(6);
      expect(row.max_limit).toBe(10);
      expect(row.max_env_running).toBe(50);
      expect(row.max_env_queued).toBe(20);
      expect(row.max_env_limit).toBe(50);

      expect(row.wait_ms_sum).toBe(5500);
      expect(row.wait_ms_count).toBe(10);

      // Percentiles over [100..1000]: monotonic and within the value range.
      expect(row.wait_p50).toBeGreaterThanOrEqual(400);
      expect(row.wait_p50).toBeLessThanOrEqual(650);
      expect(row.wait_p90).toBeGreaterThanOrEqual(row.wait_p50);
      expect(row.wait_p95).toBeGreaterThanOrEqual(row.wait_p90);
      expect(row.wait_p99).toBeGreaterThanOrEqual(row.wait_p95);
      expect(row.wait_p99).toBeLessThanOrEqual(1000);

      await ch.close();
    }
  );

  clickhouseTest(
    "merges wait-quantile state across separate insert blocks",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const queue = "queue-b";

      // Cumulative odometer continues across the two insert blocks (baseline 0, then 1..10);
      // deltaSumTimestamp state and quantile state merge across the parts into one bucket.
      const startedRow = (cum: number, wait_ms?: number): QueueMetricsRawV1Input => ({
        ...base("started", queue),
        cumulative: cum,
        order_key: orderKey++,
        ...(wait_ms !== undefined ? { wait_ms } : {}),
      });

      const [e1] = await ch.queueMetrics.insertRaw(
        [startedRow(0), ...[100, 200, 300, 400, 500].map((w, i) => startedRow(i + 1, w))],
        SYNC
      );
      expect(e1).toBeNull();
      const [e2] = await ch.queueMetrics.insertRaw(
        [600, 700, 800, 900, 1000].map((w, i) => startedRow(i + 6, w)),
        SYNC
      );
      expect(e2).toBeNull();

      const [queryError, result] = await readAggregated(ch)({ queueName: queue });
      expect(queryError).toBeNull();
      expect(result).toHaveLength(1);
      const row = result![0]!;

      // Both blocks contribute to one bucket: counts and sums add, quantile state merges.
      expect(row.started_count).toBe(10);
      expect(row.wait_ms_sum).toBe(5500);
      expect(row.wait_ms_count).toBe(10);
      expect(row.wait_p50).toBeGreaterThanOrEqual(400);
      expect(row.wait_p50).toBeLessThanOrEqual(650);
      expect(row.wait_p99).toBeGreaterThanOrEqual(row.wait_p50);
      expect(row.wait_p99).toBeLessThanOrEqual(1000);

      await ch.close();
    }
  );
});
