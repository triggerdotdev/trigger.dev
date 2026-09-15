import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickHouse } from "./index.js";
import type { QueueMetricsRawV1Input } from "./queueMetrics.js";

const ORG = "org_qm";
const PROJECT = "project_qm";
const ENV = "env_qm";

function clickhouseDateTime(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

// Keep fixtures within the tables' TTLs while preserving deterministic bucket
// relationships. Subtract a minute before rounding so no fixture lands in the future.
const TEST_MINUTE = Math.floor((Date.now() - 60_000) / 60_000) * 60_000;
const EVENT_TIME = clickhouseDateTime(TEST_MINUTE + 5_000);
const NEXT_BUCKET_EVENT_TIME = clickhouseDateTime(TEST_MINUTE + 15_000);
const RANKING_START_TIME = clickhouseDateTime(TEST_MINUTE - 10 * 60_000);

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
  max_ck_backlogged: z.coerce.number(),
  max_ck_wait_ms: z.coerce.number(),
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
        max(max_ck_backlogged) AS max_ck_backlogged,
        max(max_ck_wait_ms) AS max_ck_wait_ms,
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
          ck_backlogged: 3,
          ck_max_wait_ms: 2500,
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
          ck_backlogged: 2,
          ck_max_wait_ms: 1500,
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
      expect(row.max_ck_backlogged).toBe(3);
      expect(row.max_ck_wait_ms).toBe(2500);

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

  clickhouseTest(
    "5m and env rollups agree with the 10s tier, and env buckets are 10s",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });

      // Own org so the env-level read (no queue filter) stays isolated from other tests.
      const rollOrg = "org_qm_roll";
      const rows: QueueMetricsRawV1Input[] = [
        ...counter("started", "roll-a", 7, [100, 150, 200, 250, 300, 350, 400]),
        ...counter("started", "roll-b", 3, [500, 600, 700]),
        {
          ...base("gauge", "roll-a"),
          running: 4,
          queued: 9,
          env_running: 30,
          env_limit: 50,
          ck_backlogged: 5,
          ck_max_wait_ms: 9000,
        },
        { ...base("gauge", "roll-b"), running: 2, queued: 1, env_running: 45, env_limit: 50 },
        {
          ...base("gauge", "roll-a"),
          event_time: NEXT_BUCKET_EVENT_TIME,
          running: 1,
          queued: 2,
          env_running: 20,
          env_limit: 50,
          ck_backlogged: 2,
          ck_max_wait_ms: 3000,
        },
      ].map((row) => ({ ...row, organization_id: rollOrg }));
      const [insertError] = await ch.queueMetrics.insertRaw(rows, SYNC);
      expect(insertError).toBeNull();

      const perQueue = (table: string) =>
        ch.reader.query({
          name: "per-queue-both-tiers",
          query: `SELECT queue_name, deltaSumTimestampMerge(started_delta) AS started
          FROM ${table}
          WHERE queue_name IN ('roll-a', 'roll-b')
          GROUP BY queue_name ORDER BY queue_name`,
          schema: z.object({ queue_name: z.string(), started: z.coerce.number() }),
        })({});
      const [e10, rows10] = await perQueue("trigger_dev.queue_metrics_v1");
      const [e5m, rows5m] = await perQueue("trigger_dev.queue_metrics_5m_v1");
      expect(e10).toBeNull();
      expect(e5m).toBeNull();
      expect(rows10).toEqual([
        { queue_name: "roll-a", started: 7 },
        { queue_name: "roll-b", started: 3 },
      ]);
      expect(rows5m).toEqual(rows10);

      // CK-health gauges roll into the 5m mirror too.
      const [ckError, ckRows] = await ch.reader.query({
        name: "ck-5m-read",
        query: `SELECT max(max_ck_backlogged) AS ck_keys, max(max_ck_wait_ms) AS ck_wait
          FROM trigger_dev.queue_metrics_5m_v1
          WHERE queue_name = 'roll-a'`,
        schema: z.object({ ck_keys: z.coerce.number(), ck_wait: z.coerce.number() }),
      })({});
      expect(ckError).toBeNull();
      expect(ckRows![0]).toEqual({ ck_keys: 5, ck_wait: 9000 });

      // Env-wide totals: sum of per-queue merges (a single merge across queues would mix
      // odometers and double-count).
      const [envTotalError, envTotal] = await ch.reader.query({
        name: "env-total-per-queue-sum",
        query: `SELECT sum(started) AS started FROM (
            SELECT queue_name, deltaSumTimestampMerge(started_delta) AS started
            FROM trigger_dev.queue_metrics_5m_v1
            WHERE queue_name IN ('roll-a', 'roll-b')
            GROUP BY queue_name
          )`,
        schema: z.object({ started: z.coerce.number() }),
      })({});
      expect(envTotalError).toBeNull();
      expect(envTotal![0]!.started).toBe(10);

      const [envError, envRows] = await ch.reader.query({
        name: "env-rollup-read",
        query: `SELECT
            max(max_env_running) AS max_env_running,
            max(max_env_limit) AS max_env_limit,
            uniqExact(bucket_start) AS buckets,
            round(quantilesTDigestMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[4]) AS wait_p99
          FROM trigger_dev.env_metrics_v1
          WHERE organization_id = {org: String}`,
        schema: z.object({
          max_env_running: z.coerce.number(),
          max_env_limit: z.coerce.number(),
          buckets: z.coerce.number(),
          wait_p99: z.coerce.number(),
        }),
        params: z.object({ org: z.string() }),
      })({ org: rollOrg });
      expect(envError).toBeNull();
      expect(envRows![0]!.max_env_running).toBe(45);
      expect(envRows![0]!.max_env_limit).toBe(50);
      // 12:00:05 and 12:00:15 land in separate 10s env buckets (12:00:00 and 12:00:10).
      expect(envRows![0]!.buckets).toBe(2);
      expect(envRows![0]!.wait_p99).toBeGreaterThanOrEqual(600);
      expect(envRows![0]!.wait_p99).toBeLessThanOrEqual(1000);

      await ch.close();
    }
  );

  clickhouseTest(
    "merged ranking returns the page and the windowed total in one query",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });

      const gauge = (queue: string, queued: number, running: number): QueueMetricsRawV1Input => ({
        ...base("gauge", queue),
        queued,
        running,
      });
      const [insertError] = await ch.queueMetrics.insertRaw(
        [gauge("rank-low", 1, 0), gauge("rank-high", 50, 3), gauge("rank-mid", 10, 2)],
        SYNC
      );
      expect(insertError).toBeNull();

      const args = {
        organizationId: ORG,
        projectId: PROJECT,
        environmentId: ENV,
        startTime: RANKING_START_TIME,
        nameContains: "rank-",
        byQueuedOnly: 0,
      };
      const [pageError, page] = await ch.queueMetrics.ranking({ ...args, limit: 2, offset: 0 });
      expect(pageError).toBeNull();
      expect(page).toEqual([
        { queue_name: "rank-high", ranked_total: 3 },
        { queue_name: "rank-mid", ranked_total: 3 },
      ]);

      const [countError, count] = await ch.queueMetrics.rankingCount(args);
      expect(countError).toBeNull();
      expect(count![0]!.ranked).toBe(3);

      const [namesError, names] = await ch.queueMetrics.rankingNames({ ...args, limit: 10 });
      expect(namesError).toBeNull();
      expect(names!.map((r) => r.queue_name)).toEqual(["rank-high", "rank-mid", "rank-low"]);

      await ch.close();
    }
  );
});

describe("consumer retry idempotency", () => {
  clickhouseTest(
    "re-inserting a batch with the same dedup token does not inflate any tier",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });

      const dedupOrg = "org_qm_dedup";
      const rows: QueueMetricsRawV1Input[] = [
        ...counter("started", "dedup-q", 3, [100, 200, 300]),
        { ...base("gauge", "dedup-q"), running: 2, queued: 1, env_running: 5, env_limit: 10 },
      ].map((row) => ({ ...row, organization_id: dedupOrg }));

      const retrySettings = {
        params: {
          clickhouse_settings: {
            async_insert: 0 as const,
            insert_deduplication_token: "qm-test-retry-batch",
            deduplicate_blocks_in_dependent_materialized_views: 1 as const,
          },
        },
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const [error] = await ch.queueMetrics.insertRaw(rows, retrySettings);
        expect(error).toBeNull();
      }

      const [tiersError, tiers] = await ch.reader.query({
        name: "dedup-tier-counts",
        query: `SELECT
            (SELECT count() FROM trigger_dev.queue_metrics_v1 WHERE organization_id = {org: String}) AS rows_10s,
            (SELECT count() FROM trigger_dev.queue_metrics_5m_v1 WHERE organization_id = {org: String}) AS rows_5m,
            (SELECT count() FROM trigger_dev.env_metrics_v1 WHERE organization_id = {org: String}) AS rows_env,
            (SELECT sum(wait_ms_count) FROM trigger_dev.env_metrics_v1 WHERE organization_id = {org: String}) AS wait_count,
            (SELECT deltaSumTimestampMerge(started_delta) FROM trigger_dev.queue_metrics_v1 WHERE organization_id = {org: String}) AS started`,
        schema: z.object({
          rows_10s: z.coerce.number(),
          rows_5m: z.coerce.number(),
          rows_env: z.coerce.number(),
          wait_count: z.coerce.number(),
          started: z.coerce.number(),
        }),
        params: z.object({ org: z.string() }),
      })({ org: dedupOrg });
      expect(tiersError).toBeNull();
      const t = tiers![0]!;
      // Without dedup windows on the MV targets, retries append copies: rows and sums triple.
      expect(t.rows_10s).toBe(1);
      expect(t.rows_5m).toBe(1);
      expect(t.rows_env).toBe(1);
      expect(t.wait_count).toBe(3);
      expect(t.started).toBe(3);

      await ch.close();
    }
  );
});

describe("per-concurrency-key tier", () => {
  clickhouseTest(
    "per-key rows feed the ck tier without polluting per-queue counters or waits",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const ckOrg = "org_qm_ck";
      const queue = "ck-tier-q";
      const withCk = (row: QueueMetricsRawV1Input, ck: string): QueueMetricsRawV1Input => ({
        ...row,
        concurrency_key: ck,
      });

      // 5 started events on one queue across two keys (t1 x3, t2 x2). Each event lands as
      // a base row (base odometer) + a per-key row (per-key odometer), both carrying wait,
      // exactly like the consumer expansion. Baselines seed each odometer.
      const rows: QueueMetricsRawV1Input[] = [];
      let ok = 0;
      const started = (cum: number, ck: string, ckcum: number, wait: number) => {
        rows.push({ ...base("started", queue), cumulative: cum, order_key: ok, wait_ms: wait });
        rows.push(
          withCk({ ...base("started", queue), cumulative: ckcum, order_key: ok, wait_ms: wait }, ck)
        );
        ok++;
      };
      rows.push({ ...base("started", queue), cumulative: 0, order_key: ok++ });
      rows.push(withCk({ ...base("started", queue), cumulative: 0, order_key: ok++ }, "t1"));
      rows.push(withCk({ ...base("started", queue), cumulative: 0, order_key: ok++ }, "t2"));
      started(1, "t1", 1, 100);
      started(2, "t1", 2, 200);
      started(3, "t2", 1, 300);
      started(4, "t1", 3, 400);
      started(5, "t2", 2, 500);
      // Per-subqueue gauges carry the key.
      rows.push(withCk({ ...base("gauge", queue), queued: 4, running: 1 }, "t1"));
      rows.push(withCk({ ...base("gauge", queue), queued: 2, running: 0 }, "t2"));

      const [insertError] = await ch.queueMetrics.insertRaw(
        rows.map((r) => ({ ...r, organization_id: ckOrg })),
        SYNC
      );
      expect(insertError).toBeNull();

      const [perQueueError, perQueue] = await ch.reader.query({
        name: "ck-per-queue-read",
        query: `SELECT
            deltaSumTimestampMerge(started_delta) AS started,
            sum(wait_ms_sum) AS wait_sum,
            sum(wait_ms_count) AS wait_count,
            max(max_queued) AS peak_queued
          FROM trigger_dev.queue_metrics_v1
          WHERE organization_id = {org: String}`,
        schema: z.object({
          started: z.coerce.number(),
          wait_sum: z.coerce.number(),
          wait_count: z.coerce.number(),
          peak_queued: z.coerce.number(),
        }),
        params: z.object({ org: z.string() }),
      })({ org: ckOrg });
      expect(perQueueError).toBeNull();
      // Base rows only: 5 events (not 10), waits counted once, per-key gauges still max in.
      expect(perQueue![0]).toEqual({ started: 5, wait_sum: 1500, wait_count: 5, peak_queued: 4 });

      const [ckError, ckRows] = await ch.reader.query({
        name: "ck-tier-read",
        query: `SELECT concurrency_key,
            deltaSumTimestampMerge(started_delta) AS started,
            max(max_queued) AS peak_queued,
            sum(wait_ms_sum) AS wait_sum
          FROM trigger_dev.queue_metrics_ck_v1
          WHERE organization_id = {org: String}
          GROUP BY concurrency_key ORDER BY concurrency_key`,
        schema: z.object({
          concurrency_key: z.string(),
          started: z.coerce.number(),
          peak_queued: z.coerce.number(),
          wait_sum: z.coerce.number(),
        }),
        params: z.object({ org: z.string() }),
      })({ org: ckOrg });
      expect(ckError).toBeNull();
      expect(ckRows).toEqual([
        { concurrency_key: "t1", started: 3, peak_queued: 4, wait_sum: 700 },
        { concurrency_key: "t2", started: 2, peak_queued: 2, wait_sum: 800 },
      ]);

      await ch.close();
    }
  );
});
