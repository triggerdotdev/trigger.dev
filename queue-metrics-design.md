# Queue Metrics System Design

## Executive Summary

This document proposes a system that captures real-time queue metrics from the RunQueue's Lua scripts, streams them through Redis Streams, and persists them in ClickHouse for user-facing analytics, dashboards, and alerting.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────┐
│        RunQueue Lua Scripts         │
│  (enqueue, dequeue, ack, nack, dlq) │
└──────────────┬──────────────────────┘
               │ XADD (fire-and-forget in Lua)
               ▼
┌─────────────────────────────────────┐
│       Redis Stream                  │
│   queue_metrics:{shard}             │
│   (MAXLEN ~100000, sharded)         │
└──────────────┬──────────────────────┘
               │ XREADGROUP (consumer group)
               ▼
┌─────────────────────────────────────┐
│   QueueMetricsConsumer (Node.js)    │
│   - N consumers per consumer group  │
│   - polls every 1s, batch of 1000   │
│   - bulk INSERT into ClickHouse     │
│   - XACK only on successful insert  │
└──────────────┬──────────────────────┘
               │ INSERT (JSONEachRow)
               ▼
┌─────────────────────────────────────┐
│         ClickHouse                  │
│                                     │
│  metrics_v1  (MergeTree)            │
│  Generic metrics table              │
│  30-day TTL                         │
│                                     │
└──────────────┬──────────────────────┘
               │ Query
               ▼
┌─────────────────────────────────────┐
│   API / Presenters / Alerts         │
│   - Queue dashboard time series     │
│   - API endpoints for metrics       │
│   - Alert evaluation (polling CH)   │
└─────────────────────────────────────┘
```

---

## 2. Evaluation of the Proposed Architecture

### What makes sense

1. **Metrics emitted from Lua scripts**: This is the right place. The Lua scripts are the single source of truth for queue state transitions. Computing metrics here guarantees consistency — you're reading queue length/concurrency at the exact moment of the operation, inside the atomic script.

2. **Redis Streams as the transport**: Good choice. Streams provide:

   - Consumer groups with automatic pending entry list (PEL) for at-least-once delivery
   - Back-pressure via MAXLEN trimming (bounded memory)
   - Natural ordering by timestamp
   - No need for a separate message broker (Kafka, etc.)

3. **Bulk ClickHouse inserts**: Aligns with the existing `DynamicFlushScheduler` pattern in the codebase. ClickHouse is optimized for bulk inserts and is already used for analytics.

4. **XACK only on successful insert**: Correct — this gives at-least-once semantics. Failed inserts leave entries in the PEL for reprocessing.

### Suggested improvements

#### 2.1 Stream ID deduplication — use MAXLEN, not custom IDs

> Your proposal: "with an ID (unique to the second and the queue)"

Custom stream IDs are fragile. If two enqueue operations happen in the same second for the same queue, you'd silently drop the second one. Instead:

- **Use auto-generated IDs** (`*` in XADD) — Redis generates monotonically increasing `{ms}-{seq}` IDs.
- **Use `MAXLEN ~ 100000`** for memory bounding (the `~` means approximate, which is more efficient).
- **Handle deduplication at the ClickHouse layer** via `ReplacingMergeTree` or just accept that metrics are append-only gauge snapshots (which is actually fine — more data points = better resolution).

#### 2.2 Emit events, not pre-aggregated metrics

Rather than computing "queue length" in Lua, emit **structured events** describing what happened:

```
{operation: "enqueue", queue: "...", org_id: "...", env_id: "...", timestamp: ...}
{operation: "dequeue", queue: "...", count: 3, ...}
{operation: "ack", queue: "...", wait_duration_ms: 1523, ...}
```

Then also emit periodic **gauge snapshots** from the Lua scripts (queue length, concurrency) at the point of each operation. This hybrid approach gives you both:

- **Counters** (throughput: enqueues/s, dequeues/s) from events
- **Gauges** (queue depth, concurrency utilization) from snapshots

This is actually exactly what you described. The key insight is that each Lua script already has access to the current state after the operation, so appending a snapshot costs just a few extra SCARD/ZCARD calls.

#### 2.3 Shard the streams to match queue shards

The RunQueue already uses sharded master queues (`masterQueue:shard:0`, `masterQueue:shard:1`). Mirror this for metric streams:

```
queue_metrics:shard:0
queue_metrics:shard:1
```

Each Lua script knows its shard. Each consumer group shard can be processed independently, giving horizontal scalability.

#### 2.4 Consumer retry strategy

Your concern about failed inserts is valid. The architecture should be:

```
1. XREADGROUP COUNT 1000 BLOCK 1000 GROUP queue_metrics_cg consumer_1 STREAMS queue_metrics:shard:0 >
2. Batch the messages
3. Try INSERT into ClickHouse
4. On success: XACK all message IDs
5. On failure:
   a. Log the error
   b. Do NOT XACK — messages stay in PEL
   c. Back off (exponential: 1s, 2s, 4s, 8s, max 30s)
   d. On next poll, process pending entries first:
      XREADGROUP ... STREAMS queue_metrics:shard:0 0
      (this reads from PEL instead of new messages)
   e. After 3 consecutive failures, pause the consumer and alert
6. Periodically XAUTOCLAIM stale entries (> 60s) from crashed consumers
```

This matches the existing retry pattern in `DynamicFlushScheduler` but adapted for streams.

---

## 3. ClickHouse Schema

### 3.1 Design philosophy: generic metrics table

The ClickHouse table is designed as a **generic metrics table** that supports any metric type — not just queue metrics. The same table handles queue depth, enqueue throughput, OTel metrics from user workloads (CPU, memory), worker health, and any future metric source. This avoids creating a new table every time a new metric type is added.

The schema separates concerns into three layers:

- **Fixed dimensions** (always present): `organization_id`, `project_id`, `environment_id`. These are the leading ORDER BY columns, ensuring all queries filter efficiently by tenant.
- **Metric identity**: `metric_name` (what's being measured, e.g., `queue.depth`) + `metric_subject` (what entity it's about, e.g., the queue name or task identifier). No column has a metric-specific name — the metric_name field carries the semantic meaning.
- **Flexible dimensions**: An `attributes` JSON column for additional context (task identifier, version, worker ID, etc.). Queue metrics may have empty attributes; OTel metrics from user workloads would populate task_id, version, etc. Uses ClickHouse's [JSON type](https://clickhouse.com/docs/sql-reference/data-types/newjson), which splits paths into sub-columns for efficient columnar access (e.g., `attributes.version` reads only that sub-column, not the entire object).

Value columns are generic: `count`, `sum_value` for counters/rates, and `max_value`, `min_value`, `last_value` for gauges. Each metric type uses whichever columns are relevant and leaves the rest at their defaults.

### 3.2 Cardinality analysis

| Dimension | Cardinality | LowCardinality? | Notes |
|---|---|---|---|
| `organization_id` | Hundreds to thousands | Yes | |
| `project_id` | Thousands to tens of thousands | Yes | |
| `environment_id` | Thousands+ | No | Preview envs drive high cardinality |
| `metric_name` | Tens (fixed set) | Yes | `queue.depth`, `queue.enqueue_count`, `task.cpu_percent`, etc. |
| `metric_subject` | Unbounded | No | Queue names, task identifiers, etc. |
| `attributes` paths | Tens of known paths | N/A (JSON sub-columns) | ClickHouse auto-splits frequent paths into sub-columns; overflow goes to shared storage |

The cross-product of `(org x project x env x metric_name x metric_subject)` could reach millions of unique combinations at scale. However, the critical insight is that **only active entities produce rows** — a queue with no operations in a 5-second window produces zero rows, a task that isn't running produces no CPU metrics. Most entities are idle most of the time, so the actual row count is driven by active entity-seconds, not total entities.

### 3.3 Metrics table (single table, direct ingest target)

The consumer pre-aggregates raw stream entries into 5-second buckets in memory, then inserts directly into this table. There is no raw table and no materialized views — the consumer does the aggregation. Materialized views for minute/hour rollups can be added later if query performance requires it.

```sql
-- +goose Up
CREATE TABLE trigger_dev.metrics_v1
(
  -- Fixed dimensions (always present)
  organization_id     LowCardinality(String),
  project_id          LowCardinality(String),
  environment_id      String,

  -- Metric identity
  metric_name         LowCardinality(String),
  metric_subject      String,

  -- Time bucket
  bucket_start        DateTime,

  -- Counter/sum values (sum these in queries for rate/throughput)
  count               UInt64 DEFAULT 0,
  sum_value           Float64 DEFAULT 0,

  -- Gauge values (take max/min/last in queries for point-in-time state)
  max_value           Float64 DEFAULT 0,
  min_value           Float64 DEFAULT 0,
  last_value          Float64 DEFAULT 0,

  -- Flexible dimensions (task identifier, version, worker ID, etc.)
  -- JSON type splits paths into sub-columns for efficient columnar access
  attributes          JSON(max_dynamic_paths=64)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, project_id, environment_id, metric_name, metric_subject, bucket_start)
TTL bucket_start + INTERVAL 30 DAY;
```

**Why MergeTree (not SummingMergeTree)?**

The `attributes` JSON column means that two rows with the same ORDER BY key can have different attribute values and should NOT be merged together. For example, a `task.cpu_percent` metric for the same task but different versions would share the same `(org, project, env, metric_name, metric_subject, bucket_start)` key but differ in `attributes.version`. SummingMergeTree would incorrectly merge these rows. With plain MergeTree, each inserted row is preserved as-is, and queries use explicit GROUP BY to aggregate as needed.

**Why JSON instead of Map(String, String)?**

The [JSON type](https://clickhouse.com/docs/sql-reference/data-types/newjson) (production-ready in ClickHouse 25.3+) splits frequently-occurring paths into dedicated sub-columns. This means a query like `WHERE attributes.version = '20250808.3'` reads only the `version` sub-column, not the entire attributes blob. With `Map(String, String)`, every query touching any attribute key must scan all keys and values. The JSON type also preserves native types (integers, floats) rather than storing everything as strings, and supports nested structures if needed later. The `max_dynamic_paths=64` limit caps the number of auto-discovered sub-columns; overflow paths share a compact fallback store.

**How queue metrics map to generic columns**

Each queue operation stream entry (from a Lua script) gets expanded into multiple rows — one per metric:

| metric_name | count | sum_value | max_value | min_value | last_value | Notes |
|---|---|---|---|---|---|---|
| `queue.enqueue_count` | 1 | 0 | 0 | 0 | 0 | Counter: sum `count` for throughput |
| `queue.dequeue_count` | 1 | 0 | 0 | 0 | 0 | Counter |
| `queue.ack_count` | 1 | 0 | 0 | 0 | 0 | Counter |
| `queue.depth` | 0 | 0 | 150 | 148 | 150 | Gauge: use `max_value` for peak depth |
| `queue.concurrency_current` | 0 | 0 | 8 | 8 | 8 | Gauge |
| `queue.oldest_message_age_ms` | 0 | 0 | 5200 | 5200 | 5200 | Gauge |
| `queue.wait_duration_ms` | 1 | 1523 | 1523 | 1523 | 1523 | Histogram-like: `sum_value / count` for avg |

For all queue metrics, `metric_subject` is the queue name and `attributes` is empty.

**How OTel task metrics would map**

| metric_name | metric_subject | count | max_value | attributes |
|---|---|---|---|---|
| `task.cpu_percent` | `my-task` | 1 | 85.2 | `{version: "20250808.3"}` |
| `task.memory_mb` | `my-task` | 1 | 512 | `{version: "20250808.3"}` |
| `task.run_duration_ms` | `my-task` | 1 | 3400 | `{version: "20250808.3", run_id: "run_abc"}` |

**Why a single table with 30-day TTL?**

- 30 days covers most dashboard use cases (real-time, daily trends, monthly overview)
- No materialized views means simpler operations, no MV cascade risk, and no data consistency concerns between tiers
- Queries use `GROUP BY toStartOfMinute(bucket_start)` or `GROUP BY toStartOfHour(bucket_start)` to get coarser resolution — no need for separate tables
- Materialized views can be added later if query performance on large time ranges becomes an issue

**Estimated row counts**

Since the consumer pre-aggregates into 5s buckets and expands each into multiple metric rows, row counts scale with _active entities per 5s window_ times _metrics per entity_:

- Queue metrics: ~7 metric rows per active queue per 5s bucket = ~120,960 rows/day per continuously active queue
- 1,000 active queues: ~121M rows/day, ~3.6B rows retained (30 days)
- With ZSTD compression: ~50-100 bytes/row compressed, ~180-360GB on disk at this scale
- In practice, most queues are intermittently active, so real-world row counts are significantly lower

### 3.4 Handling idle queues (the "stale gauge" problem)

Since we only emit metrics on queue operations, an idle queue with 500 items sitting in it produces **zero rows** in any 5s window where no enqueue/dequeue/ack occurs. But the queue isn't empty — the user's dashboard should still show depth = 500.

This only affects **gauge metrics** (`queue.depth`, `queue.concurrency_current`, `queue.oldest_message_age_ms`). Counter metrics are fine — zero rows correctly means zero activity.

**Solution: "last known value" carry-forward at query time**

When the presenter queries a time window, it also fetches the most recent row _before_ the window start for each queue to seed the initial gauge values:

```sql
-- Get the last known gauge values before the requested window
SELECT metric_subject,
       max_value
FROM metrics_v1
WHERE environment_id = {envId}
  AND metric_name = 'queue.depth'
  AND metric_subject = {queueName}
  AND bucket_start < {windowStart}
ORDER BY bucket_start DESC
LIMIT 1
```

The presenter then fills gaps in the timeseries:

- For any 5s bucket with no row, carry forward the gauge values from the most recent preceding bucket (or the seed query above)
- Counter metrics are zero-filled (no row = no activity, which is correct)

This is the standard approach for gauge metrics in time-series systems (Prometheus/Grafana use identical "last value" semantics for `gauge` types). The worst-case staleness is bounded by the 5s resolution.

**Why not periodic heartbeats?**

An alternative is emitting a "heartbeat" snapshot for all non-empty queues every 5s from Node.js, guaranteeing every active queue has at least one row per window. This would work but:

- Adds Redis polling overhead (ZCARD per queue per 5s) that scales with total queues, not active queues — exactly the scaling property we want to avoid
- Requires maintaining a "known queues" registry
- Carry-forward at query time achieves the same UX with zero additional infrastructure

Heartbeats could be added later if carry-forward proves insufficient (e.g., if alert evaluation needs gap-free data). But alert evaluation can also use the same seed query pattern.

### 3.5 Query patterns

All queries use the single `metrics_v1` table. Resolution is controlled at query time via GROUP BY, not by routing to different tables.

**5-second resolution (raw buckets)**

```sql
SELECT
  bucket_start,
  sum(count) AS total_count,
  max(max_value) AS peak_value,
  sum(sum_value) / sum(count) AS avg_value
FROM metrics_v1
WHERE organization_id = {orgId}
  AND project_id = {projId}
  AND environment_id = {envId}
  AND metric_name = {metricName}
  AND metric_subject = {subject}
  AND bucket_start BETWEEN {start} AND {end}
GROUP BY bucket_start
ORDER BY bucket_start
```

**1-minute resolution**

```sql
SELECT
  toStartOfMinute(bucket_start) AS minute,
  sum(count) AS total_count,
  max(max_value) AS peak_value
FROM metrics_v1
WHERE organization_id = {orgId}
  AND project_id = {projId}
  AND environment_id = {envId}
  AND metric_name = {metricName}
  AND metric_subject = {subject}
  AND bucket_start BETWEEN {start} AND {end}
GROUP BY minute
ORDER BY minute
```

**1-hour resolution**

```sql
SELECT
  toStartOfHour(bucket_start) AS hour,
  sum(count) AS total_count,
  max(max_value) AS peak_value
FROM metrics_v1
WHERE organization_id = {orgId}
  AND project_id = {projId}
  AND environment_id = {envId}
  AND metric_name = {metricName}
  AND metric_subject = {subject}
  AND bucket_start BETWEEN {start} AND {end}
GROUP BY hour
ORDER BY hour
```

**Recommended resolution by time range**

| Requested Period | Resolution | GROUP BY | Table | Max Data Points |
| ---------------- | ---------- | -------- | ----- | --------------- |
| Last 30 minutes | 5s | `bucket_start` | `metrics_v1` | 360 |
| Last 2 hours | 5s | `bucket_start` | `metrics_v1` | 1,440 |
| Last 24 hours | 1m | `toStartOfMinute(bucket_start)` | `metrics_v1` | 1,440 |
| Last 7 days | 1m | `toStartOfMinute(bucket_start)` | `metrics_v1` | 10,080 |
| Last 30 days | 1h | `toStartOfHour(bucket_start)` | `metrics_v1` | 720 |

Materialized views for pre-aggregated minute and hour tables can be added later if query performance on large time ranges (7+ days) becomes an issue. The query patterns remain the same — the MV just avoids re-aggregating at query time.

---

## 4. What Metrics Happen in Lua vs. Node.js

### Collected inside Lua scripts (cheap, atomic, consistent)

These are O(1) Redis operations added to the end of each Lua script:

| Metric                  | Redis Command                                               | Available In                |
| ----------------------- | ----------------------------------------------------------- | --------------------------- |
| `queue_length`          | `ZCARD queueKey`                                            | enqueue, dequeue, ack, nack |
| `concurrency_current`   | `SCARD queueCurrentConcurrencyKey`                          | enqueue, dequeue, ack, nack |
| `concurrency_limit`     | `GET queueConcurrencyLimitKey`                              | dequeue                     |
| `env_queue_length`      | `ZCARD envQueueKey`                                         | enqueue, dequeue, ack       |
| `env_concurrency`       | `SCARD envCurrentConcurrencyKey`                            | enqueue, dequeue, ack, nack |
| `env_concurrency_limit` | `GET envConcurrencyLimitKey`                                | dequeue                     |
| `oldest_message_age_ms` | `ZRANGE queueKey 0 0 WITHSCORES` then `currentTime - score` | enqueue, dequeue            |
| operation type          | Known from which script runs                                | all                         |
| timestamp               | `redis.call('TIME')`                                        | all                         |

The Lua script emits a single XADD at the end:

```lua
-- At the end of enqueueMessage Lua script:
local queueLength = redis.call('ZCARD', queueKey)
local concurrency = redis.call('SCARD', queueCurrentConcurrencyKey)
local envQueueLen = redis.call('ZCARD', envQueueKey)
local envConcurrency = redis.call('SCARD', envCurrentConcurrencyKey)

-- Oldest message age
local oldestMsg = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
local oldestAge = 0
if #oldestMsg > 0 then
  local now = tonumber(redis.call('TIME')[1]) * 1000
  oldestAge = now - tonumber(oldestMsg[2])
end

-- Emit to metrics stream (fire-and-forget, bounded)
local streamKey = KEYS[N]  -- queue_metrics:shard:X
redis.call('XADD', streamKey, 'MAXLEN', '~', '100000', '*',
  'org', ARGV[orgIndex],
  'proj', ARGV[projIndex],
  'env', ARGV[envIndex],
  'queue', queueName,
  'op', 'enqueue',
  'ql', tostring(queueLength),
  'cc', tostring(concurrency),
  'eql', tostring(envQueueLen),
  'ec', tostring(envConcurrency),
  'age', tostring(oldestAge),
  'eq', '1'   -- enqueue_count
)
```

### Computed in Node.js (on the consumer side)

| Metric                    | How                                                                           |
| ------------------------- | ----------------------------------------------------------------------------- |
| `wait_duration_ms`        | On `ack` events: `ack_timestamp - message.timestamp` (from the OutputPayload) |
| Throughput rates          | Computed at query time from count columns in ClickHouse                       |
| Concurrency utilization % | `concurrency_current / concurrency_limit * 100` at query time                 |

---

## 5. User-Facing Queue Metrics

### 5.1 Real-time dashboard (current state)

These continue to come from Redis directly (as they do today via `QueueListPresenter`/`QueueRetrievePresenter`):

| Metric                  | Description               | Source                        |
| ----------------------- | ------------------------- | ----------------------------- |
| Queue depth             | Number of runs waiting    | `ZCARD` of queue sorted set   |
| Running count           | Number of runs executing  | `SCARD` of currentConcurrency |
| Concurrency limit       | Max concurrent executions | Queue concurrency limit key   |
| Concurrency utilization | `running / limit * 100%`  | Computed                      |
| Paused state            | Whether queue is paused   | PostgreSQL                    |

### 5.2 Historical analytics (from ClickHouse)

These are the new user-facing metrics enabled by this system:

| Metric                                | Description                           | Query Source                                                                                                            | User Value                                                                    |
| ------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Throughput**                        | Enqueues/s, dequeues/s, completions/s | `sum(count) ... WHERE metric_name = 'queue.enqueue_count'` from `metrics_v1`                                            | "How busy is my queue?"                                                       |
| **Queue depth over time**             | Historical queue length graph         | `max(max_value) ... WHERE metric_name = 'queue.depth'` from `metrics_v1`                                                | "Is my queue growing or draining?"                                            |
| **Wait time (queue latency)**         | Time from enqueue to dequeue          | `sum(sum_value) / sum(count) ... WHERE metric_name = 'queue.wait_duration_ms'` from `metrics_v1`                        | "How long do my tasks wait before starting?" — the most important user metric |
| **Oldest message age**                | How stale the oldest waiting run is   | `max(max_value) ... WHERE metric_name = 'queue.oldest_message_age_ms'` from `metrics_v1`                                | "Is something stuck?"                                                         |
| **Concurrency utilization over time** | Historical concurrency usage          | `max(max_value) ... WHERE metric_name = 'queue.concurrency_current'` from `metrics_v1`                                  | "Should I increase my concurrency limit?"                                     |
| **Failure rate**                      | Nacks + DLQ relative to dequeues      | Sum of `count` for `queue.nack_count` + `queue.dlq_count` / sum of `count` for `queue.dequeue_count` from `metrics_v1`  | "Are my tasks failing?"                                                       |
| **TTL expiration rate**               | Runs expiring before execution        | `sum(count) ... WHERE metric_name = 'queue.ttl_expire_count'` from `metrics_v1`                                         | "Am I losing work to TTLs?"                                                   |
| **Environment-level totals**          | Aggregate of all queues               | Filtered by `environment_id` and `metric_name`, grouped by time from `metrics_v1`                                       | "Overall environment health"                                                  |

### 5.3 Recommended API shape

```typescript
// GET /api/v1/queues/:queueParam/metrics?period=30m&resolution=5s
// resolution: "5s" | "1m" | "1h" (auto-selected if omitted based on period)
{
  queue: "my-queue",
  period: { start: "2025-01-01T00:00:00Z", end: "2025-01-01T00:30:00Z" },
  resolution: "5s",
  timeseries: [
    {
      timestamp: "2025-01-01T00:00:00Z",
      throughput: { enqueued: 3, dequeued: 2, completed: 2 },
      queue_depth: { max: 120 },
      latency: { avg_wait_ms: 1523, max_age_ms: 8200 },
      concurrency: { max: 8, limit: 10, utilization_pct: 80 },
      failures: { nack: 0, dlq: 0, ttl_expired: 0 }
    },
    // ... one entry per 5 seconds (360 data points for 30 min)
  ]
}
```

---

## 6. Generic Metrics Pipeline

The transport layer (Redis Stream → Consumer → ClickHouse) is not queue-specific. It should be built as a generic pipeline that any part of the application can use to ship metrics to ClickHouse. Queue metrics is the first consumer.

### 6.1 Architecture

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│   Queue Lua Scripts  │  │   Worker Health       │  │   Future: API Metrics│
│   (XADD in Lua)      │  │   (XADD from Node.js) │  │   (XADD from Node.js)│
└──────────┬───────────┘  └──────────┬───────────┘  └──────────┬───────────┘
           │                         │                         │
           ▼                         ▼                         ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ metrics:queue:0  │    │ metrics:worker:0 │    │ metrics:api:0    │
│ metrics:queue:1  │    │ metrics:worker:1 │    │ metrics:api:1    │
│ (Redis Streams)  │    │ (Redis Streams)  │    │ (Redis Streams)  │
└──────────┬───────┘    └──────────┬───────┘    └──────────┬───────┘
           │                       │                       │
           └───────────┬───────────┘───────────────────────┘
                       ▼
         ┌──────────────────────────────┐
         │  MetricsStreamConsumer       │
         │  (generic, one per metric    │
         │   definition)                │
         │                              │
         │  - XREADGROUP per shard      │
         │  - pre-aggregate via         │
         │    MetricDefinition          │
         │  - INSERT into target table  │
         │  - XACK on success           │
         └──────────────────────────────┘
```

### 6.2 MetricDefinition interface

Each metric type registers a definition that tells the pipeline how to parse, aggregate, and store its data:

```typescript
/**
 * Defines a metric type for the generic Redis Stream → ClickHouse pipeline.
 *
 * The pipeline handles: stream consumption, consumer groups, PEL recovery,
 * retry with backoff, batching, and graceful shutdown.
 *
 * The metric definition handles: what the data looks like, how to aggregate
 * it, and where it goes.
 */
interface MetricDefinition<TEntry, TAggregated> {
  /** Unique name for this metric (used in stream keys, consumer groups) */
  name: string;

  /** Target ClickHouse table for inserts */
  clickhouseTable: string;

  /** Number of stream shards (streams are named `metrics:{name}:{shard}`) */
  shardCount: number;

  /** MAXLEN for each stream shard */
  maxStreamLength: number;

  /** Bucket size in milliseconds for pre-aggregation */
  bucketSizeMs: number;

  /**
   * Parse a raw Redis Stream entry (string key-value pairs)
   * into a typed entry. Return null to skip/filter the entry.
   */
  parseEntry(fields: Record<string, string>, streamId: string): TEntry | null;

  /**
   * Extract the dimension key for grouping.
   * Entries with the same dimension key and time bucket are aggregated together.
   * Returns a string that uniquely identifies the dimension combination.
   */
  dimensionKey(entry: TEntry): string;

  /**
   * Extract the timestamp from a parsed entry (ms since epoch).
   * Used to assign entries to time buckets.
   */
  timestamp(entry: TEntry): number;

  /**
   * Aggregate a batch of entries that share the same dimension key
   * and time bucket into a single row for ClickHouse insertion.
   */
  aggregate(dimensionKey: string, bucketStart: Date, entries: TEntry[]): TAggregated;

  /**
   * Convert aggregated rows into the format expected by the ClickHouse client.
   * Returns column names and values for JSONEachRow insert.
   */
  toInsertRow(row: TAggregated): Record<string, unknown>;
}
```

### 6.3 MetricsStreamConsumer (generic pipeline)

```typescript
/**
 * Generic consumer that reads from Redis Streams and inserts into ClickHouse.
 * One instance per MetricDefinition.
 */
class MetricsStreamConsumer<TEntry, TAggregated> {
  constructor(options: {
    redis: RedisOptions;
    clickhouse: ClickHouseClient;
    definition: MetricDefinition<TEntry, TAggregated>;
    consumerGroup: string;
    consumerId: string;
    pollIntervalMs?: number; // default: 1000
    batchSize?: number; // default: 1000
  }) {}

  async start(): Promise<void> {
    // For each shard:
    // 1. XGROUP CREATE metrics:{name}:{shard} {consumerGroup} $ MKSTREAM
    // 2. Start polling loop
  }

  private async pollShard(shard: number): Promise<void> {
    // 1. Read pending entries first (PEL recovery): XREADGROUP ... 0
    //    - INSERT these as a separate batch (enables CH insert dedup)
    //    - XACK on success
    // 2. Read new entries: XREADGROUP ... >
    //    - Parse via definition.parseEntry()
    //    - Group by definition.dimensionKey() + time bucket
    //    - Aggregate via definition.aggregate()
    //    - Convert via definition.toInsertRow()
    //    - INSERT batch into definition.clickhouseTable
    //    - XACK on success
    // 3. On failure: back off, retry from PEL next iteration
  }

  async stop(): Promise<void> {
    // Signal shutdown, drain in-flight batches
  }
}
```

### 6.4 Lua emission helpers

Every Lua XADD block has the same boilerplate: check the enabled flag, wrap in pcall, XADD with MAXLEN and auto-generated ID, convert values to strings. The package provides a TypeScript function that **generates the Lua code** at command registration time, so each Lua script just appends the generated block.

```typescript
/**
 * Generates a Lua code block that emits a metric entry to a Redis Stream.
 *
 * Handles:
 * - Enabled flag check (skips emission when disabled)
 * - pcall wrapping (metric failures never abort the parent operation)
 * - XADD with MAXLEN ~ and auto-generated ID
 * - tostring() conversion for numeric values
 *
 * The caller provides:
 * - KEYS/ARGV indices for the stream key and enabled flag
 * - A block of Lua code that computes local variables (domain-specific)
 * - A field mapping from stream field names to Lua expressions
 */
function createMetricsEmitLua(options: {
  /** KEYS index for the metrics stream (e.g., 9 → KEYS[9]) */
  streamKeyIndex: number;
  /** ARGV index for the metrics-enabled flag (e.g., 5 → ARGV[5]) */
  enabledFlagArgvIndex: number;
  /** Max stream length for XADD MAXLEN ~ */
  maxStreamLength: number;
  /**
   * Lua code block that computes local variables used in `fields`.
   * These are domain-specific Redis calls (ZCARD, SCARD, etc.)
   * that the generic layer doesn't know about.
   * Variable names should be prefixed with _m_ to avoid collisions.
   */
  computeBlock: string;
  /**
   * Ordered list of [fieldName, luaExpression] pairs for the XADD.
   * Expressions can reference variables from computeBlock, ARGV, or
   * variables already in scope in the parent Lua script.
   * Numeric expressions are automatically wrapped in tostring().
   */
  fields: Array<[string, string]>;
}): string {
  const fieldArgs = options.fields
    .map(([name, expr]) => `'${name}', tostring(${expr})`)
    .join(",\n      ");

  return `
if ARGV[${options.enabledFlagArgvIndex}] == '1' then
  pcall(function()
    ${options.computeBlock}
    redis.call('XADD', KEYS[${options.streamKeyIndex}],
      'MAXLEN', '~', '${options.maxStreamLength}', '*',
      ${fieldArgs}
    )
  end)
end
`;
}
```

Usage in a Lua script definition:

```typescript
// Generated once at command registration time
const enqueueMetricsBlock = createMetricsEmitLua({
  streamKeyIndex: 9,
  enabledFlagArgvIndex: 5,
  maxStreamLength: 100_000,
  computeBlock: `
    local _m_ql = redis.call('ZCARD', queueKey)
    local _m_cc = redis.call('SCARD', queueCurrentConcurrencyKey)
    local _m_eql = redis.call('ZCARD', envQueueKey)
    local _m_ec = redis.call('SCARD', envCurrentConcurrencyKey)
    local _m_age = 0
    local _m_oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
    if #_m_oldest > 0 then
      local _m_now = tonumber(redis.call('TIME')[1]) * 1000
      _m_age = _m_now - tonumber(_m_oldest[2])
    end
  `,
  fields: [
    ["org", "ARGV[6]"],
    ["proj", "ARGV[7]"],
    ["env", "ARGV[8]"],
    ["queue", "queueName"],
    ["op", '"enqueue"'],
    ["ql", "_m_ql"],
    ["cc", "_m_cc"],
    ["eql", "_m_eql"],
    ["ec", "_m_ec"],
    ["age", "_m_age"],
    ["eq", "1"],
  ],
});

// Then in #registerCommands():
this.redis.defineCommand("enqueueMessage", {
  numberOfKeys: 9, // was 8, +1 for metricsStreamKey
  lua: `
    ${existingEnqueueLua}
    ${enqueueMetricsBlock}
  `,
});
```

Since the gauge computations (ZCARD, SCARD, etc.) are the same across most queue operations, a queue-specific helper can eliminate further repetition:

```typescript
/**
 * Queue-specific helper that generates the computeBlock + fields
 * for queue metrics. Lives in run-engine, not in the generic package.
 */
function queueMetricsLuaBlock(options: {
  streamKeyIndex: number;
  enabledFlagArgvIndex: number;
  orgArgvIndex: number;
  projArgvIndex: number;
  envArgvIndex: number;
  operation: "enqueue" | "dequeue" | "ack" | "nack" | "dlq";
  counterField: "eq" | "dq" | "ak" | "nk" | "dlq";
  /** Lua variable names that are in scope in the parent script */
  vars: {
    queueKey: string;
    queueConcurrencyKey: string;
    envQueueKey: string;
    envConcurrencyKey: string;
    queueName: string;
  };
}): string {
  return createMetricsEmitLua({
    streamKeyIndex: options.streamKeyIndex,
    enabledFlagArgvIndex: options.enabledFlagArgvIndex,
    maxStreamLength: 100_000,
    computeBlock: `
      local _m_ql = redis.call('ZCARD', ${options.vars.queueKey})
      local _m_cc = redis.call('SCARD', ${options.vars.queueConcurrencyKey})
      local _m_eql = redis.call('ZCARD', ${options.vars.envQueueKey})
      local _m_ec = redis.call('SCARD', ${options.vars.envConcurrencyKey})
      local _m_age = 0
      local _m_oldest = redis.call('ZRANGE', ${options.vars.queueKey}, 0, 0, 'WITHSCORES')
      if #_m_oldest > 0 then
        local _m_now = tonumber(redis.call('TIME')[1]) * 1000
        _m_age = _m_now - tonumber(_m_oldest[2])
      end
    `,
    fields: [
      ["org", `ARGV[${options.orgArgvIndex}]`],
      ["proj", `ARGV[${options.projArgvIndex}]`],
      ["env", `ARGV[${options.envArgvIndex}]`],
      ["queue", options.vars.queueName],
      ["op", `"${options.operation}"`],
      ["ql", "_m_ql"],
      ["cc", "_m_cc"],
      ["eql", "_m_eql"],
      ["ec", "_m_ec"],
      ["age", "_m_age"],
      [options.counterField, "1"],
    ],
  });
}

// Adding metrics to enqueueMessage is now:
const enqueueMetrics = queueMetricsLuaBlock({
  streamKeyIndex: 9,
  enabledFlagArgvIndex: 5,
  orgArgvIndex: 6,
  projArgvIndex: 7,
  envArgvIndex: 8,
  operation: "enqueue",
  counterField: "eq",
  vars: {
    queueKey: "KEYS[2]",
    queueConcurrencyKey: "KEYS[4]",
    envQueueKey: "KEYS[8]",
    envConcurrencyKey: "KEYS[5]",
    queueName: "queueName",
  },
});
```

This means adding metrics to all 6 Lua scripts is 6 calls to `queueMetricsLuaBlock()` with different variable mappings, instead of 6 hand-written copies of the same ~20-line Lua block.

### 6.5 MetricsStreamEmitter (convenience for Node.js producers)

For metrics emitted from Node.js (not Lua), provide a thin helper:

```typescript
/**
 * Emits metric entries to a Redis Stream. For use in Node.js code.
 * Lua scripts use XADD directly — this is for non-Lua producers.
 */
class MetricsStreamEmitter {
  constructor(options: {
    redis: Redis;
    streamPrefix: string; // e.g., "metrics"
    metricName: string; // e.g., "worker_health"
    shardCount: number;
    maxStreamLength?: number; // default: 100000
  }) {}

  /**
   * Emit a metric entry to the appropriate shard.
   * Shard selection can be based on a dimension value (e.g., envId)
   * for locality, or round-robin.
   */
  async emit(fields: Record<string, string | number>, shardKey?: string): Promise<void> {
    const shard = shardKey ? jumpHash(shardKey, this.shardCount) : this.roundRobinShard();
    const streamKey = `${this.streamPrefix}:${this.metricName}:${shard}`;
    await this.redis.xadd(
      streamKey,
      "MAXLEN",
      "~",
      this.maxStreamLength.toString(),
      "*",
      ...Object.entries(fields).flat()
    );
  }
}
```

### 6.6 Queue metrics as the first MetricDefinition

The key difference from the old queue-specific schema: a single stream entry from a Lua script (containing fields like `ql`, `cc`, `eql`, `ec`, `age`, `eq`) gets **expanded into multiple rows** in the generic `metrics_v1` table — one row per metric_name. The `aggregate` function handles this expansion.

```typescript
const queueMetricsDefinition: MetricDefinition<QueueMetricEntry, QueueMetricRow[]> = {
  name: "queue",
  clickhouseTable: "metrics_v1",
  shardCount: 2, // match RunQueue shard count
  maxStreamLength: 100_000,
  bucketSizeMs: 5_000, // 5 seconds

  parseEntry(fields, streamId) {
    return {
      organizationId: fields.org,
      projectId: fields.proj,
      environmentId: fields.env,
      queueName: fields.queue,
      operation: fields.op,
      timestamp: redisStreamIdToMs(streamId),
      queueLength: parseInt(fields.ql ?? "0"),
      concurrencyCurrent: parseInt(fields.cc ?? "0"),
      envQueueLength: parseInt(fields.eql ?? "0"),
      envConcurrency: parseInt(fields.ec ?? "0"),
      oldestMessageAgeMs: parseInt(fields.age ?? "0"),
      enqueueCount: parseInt(fields.eq ?? "0"),
      dequeueCount: parseInt(fields.dq ?? "0"),
      ackCount: parseInt(fields.ak ?? "0"),
      nackCount: parseInt(fields.nk ?? "0"),
      dlqCount: parseInt(fields.dlq ?? "0"),
      ttlExpireCount: parseInt(fields.ttl ?? "0"),
      waitDurationMs: parseInt(fields.wd ?? "0"),
    };
  },

  dimensionKey(entry) {
    return `${entry.organizationId}:${entry.projectId}:${entry.environmentId}:${entry.queueName}`;
  },

  timestamp(entry) {
    return entry.timestamp;
  },

  aggregate(dimensionKey, bucketStart, entries) {
    const [orgId, projId, envId, queue] = dimensionKey.split(":");

    const base = {
      organization_id: orgId,
      project_id: projId,
      environment_id: envId,
      metric_subject: queue,
      bucket_start: bucketStart,
      attributes: {},
    };

    // Each stream entry produces MULTIPLE rows — one per metric_name.
    // Counter metrics use `count`, gauge metrics use `max_value`/`min_value`/`last_value`.
    const rows: QueueMetricRow[] = [];

    // Counter metrics (one row each, only if non-zero)
    const counters = [
      { name: "queue.enqueue_count", value: sum(entries, "enqueueCount") },
      { name: "queue.dequeue_count", value: sum(entries, "dequeueCount") },
      { name: "queue.ack_count", value: sum(entries, "ackCount") },
      { name: "queue.nack_count", value: sum(entries, "nackCount") },
      { name: "queue.dlq_count", value: sum(entries, "dlqCount") },
      { name: "queue.ttl_expire_count", value: sum(entries, "ttlExpireCount") },
    ];

    for (const { name, value } of counters) {
      if (value > 0) {
        rows.push({ ...base, metric_name: name, count: value, sum_value: 0, max_value: 0, min_value: 0, last_value: 0 });
      }
    }

    // Gauge metrics (one row each, always emitted if entries exist)
    rows.push({
      ...base,
      metric_name: "queue.depth",
      count: 0, sum_value: 0,
      max_value: max(entries, "queueLength"),
      min_value: min(entries, "queueLength"),
      last_value: last(entries, "queueLength"),
    });
    rows.push({
      ...base,
      metric_name: "queue.concurrency_current",
      count: 0, sum_value: 0,
      max_value: max(entries, "concurrencyCurrent"),
      min_value: min(entries, "concurrencyCurrent"),
      last_value: last(entries, "concurrencyCurrent"),
    });
    rows.push({
      ...base,
      metric_name: "queue.oldest_message_age_ms",
      count: 0, sum_value: 0,
      max_value: max(entries, "oldestMessageAgeMs"),
      min_value: min(entries, "oldestMessageAgeMs"),
      last_value: last(entries, "oldestMessageAgeMs"),
    });

    // Wait duration (histogram-like: count + sum for computing averages)
    const wdCount = countNonZero(entries, "waitDurationMs");
    if (wdCount > 0) {
      rows.push({
        ...base,
        metric_name: "queue.wait_duration_ms",
        count: wdCount,
        sum_value: sum(entries, "waitDurationMs"),
        max_value: max(entries, "waitDurationMs"),
        min_value: min(entries, "waitDurationMs"),
        last_value: last(entries, "waitDurationMs"),
      });
    }

    // Environment-level gauges
    rows.push({
      ...base,
      metric_name: "queue.env_queue_length",
      count: 0, sum_value: 0,
      max_value: max(entries, "envQueueLength"),
      min_value: min(entries, "envQueueLength"),
      last_value: last(entries, "envQueueLength"),
    });
    rows.push({
      ...base,
      metric_name: "queue.env_concurrency",
      count: 0, sum_value: 0,
      max_value: max(entries, "envConcurrency"),
      min_value: min(entries, "envConcurrency"),
      last_value: last(entries, "envConcurrency"),
    });

    return rows;
  },

  toInsertRow(row) {
    return { ...row, bucket_start: formatDateTime(row.bucket_start) };
  },
};
```

### 6.7 Example: adding a second metric type

To ship a new metric to ClickHouse, you only need:

1. **Uses the existing `metrics_v1` table** — no new table required since the schema is generic
2. **A MetricDefinition** implementation
3. **XADD calls** at the emission points (Lua or Node.js)
4. **Register the consumer** at startup

For example, worker health metrics:

```typescript
const workerHealthDefinition: MetricDefinition<WorkerHealthEntry, WorkerHealthRow> = {
  name: "worker_health",
  clickhouseTable: "metrics_v1",
  shardCount: 1,
  maxStreamLength: 50_000,
  bucketSizeMs: 5_000,

  parseEntry(fields, streamId) {
    return {
      workerId: fields.wid,
      environmentId: fields.env,
      timestamp: redisStreamIdToMs(streamId),
      cpuPercent: parseFloat(fields.cpu ?? "0"),
      memoryMb: parseInt(fields.mem ?? "0"),
      activeConnections: parseInt(fields.conn ?? "0"),
    };
  },

  dimensionKey(entry) {
    return `${entry.environmentId}:${entry.workerId}`;
  },
  timestamp(entry) {
    return entry.timestamp;
  },

  aggregate(dimensionKey, bucketStart, entries) {
    const [envId, workerId] = dimensionKey.split(":");
    return {
      environment_id: envId,
      worker_id: workerId,
      bucket_start: bucketStart,
      max_cpu_percent: max(entries, "cpuPercent"),
      max_memory_mb: max(entries, "memoryMb"),
      max_active_connections: max(entries, "activeConnections"),
      sample_count: entries.length,
    };
  },

  toInsertRow(row) {
    return { ...row, bucket_start: formatDateTime(row.bucket_start) };
  },
};

// At startup:
const workerHealthConsumer = new MetricsStreamConsumer({
  redis: redisOptions,
  clickhouse: clickhouseClient,
  definition: workerHealthDefinition,
  consumerGroup: "worker_health_cg",
  consumerId: `consumer_${process.pid}`,
});
await workerHealthConsumer.start();
```

### 6.8 Where to put the generic pipeline

```
internal-packages/
  metrics-pipeline/            # NEW package: @internal/metrics-pipeline
    src/
      types.ts                 # MetricDefinition interface
      consumer.ts              # MetricsStreamConsumer
      emitter.ts               # MetricsStreamEmitter (Node.js producers)
      lua.ts                   # createMetricsEmitLua() (Lua code generation)
      helpers.ts               # sum(), max(), countNonZero(), redisStreamIdToMs()
      index.ts                 # public exports

  run-engine/
    src/run-queue/
      queueMetrics.ts          # queueMetricsDefinition + queueMetricsLuaBlock()
      index.ts                 # Lua scripts with generated XADD blocks appended
```

The generic pipeline lives in its own internal package so it can be used by any app (webapp, supervisor) without depending on run-engine. It provides three concerns:

- **Consumer side**: `MetricDefinition` + `MetricsStreamConsumer` (stream → ClickHouse)
- **Node.js emission**: `MetricsStreamEmitter` (convenience XADD wrapper)
- **Lua emission**: `createMetricsEmitLua()` (generates Lua code for XADD with pcall/enabled/MAXLEN boilerplate)

---

## 7. Queue-Specific Implementation Plan

### Phase 1: Generic pipeline package

Create `@internal/metrics-pipeline` with:

- `MetricDefinition` interface and `MetricsStreamConsumer` (consumer side)
- `MetricsStreamEmitter` (Node.js emission)
- `createMetricsEmitLua()` (Lua code generation)
- Aggregation helpers: `sum()`, `max()`, `countNonZero()`, `redisStreamIdToMs()`

This is framework code with no queue-specific logic.

### Phase 2: Queue metric definition + Lua script changes

1. Create `queueMetricsLuaBlock()` helper in `run-engine/src/run-queue/queueMetrics.ts` that wraps `createMetricsEmitLua()` with queue-specific gauge computations (section 6.4).

2. For each Lua script, generate the metrics block via `queueMetricsLuaBlock()` and append it to the existing Lua string. Each script needs +1 to `numberOfKeys` (for `metricsStreamKey`) and +4 ARGV entries (`metricsEnabled`, `orgId`, `projId`, `envId`):

| Script                     | Counter field | Notes                                     |
| -------------------------- | ------------- | ----------------------------------------- |
| `enqueueMessage`           | `eq`          | org/proj/env from ARGV                    |
| `enqueueMessageWithTtl`    | `eq`          | org/proj/env from ARGV                    |
| `dequeueMessagesFromQueue` | `dq`          | org/proj/env parsed from queue key in Lua |
| `acknowledgeMessage`       | `ak`          | org/proj/env from message data            |
| `nackMessage`              | `nk`          | org/proj/env from message data            |
| `moveToDeadLetterQueue`    | `dlq`         | org/proj/env from message data            |

The pcall wrapping and enabled-flag check are handled by `createMetricsEmitLua()` — no manual boilerplate.

3. Create `queueMetricsDefinition` (section 6.6) and wire a `MetricsStreamConsumer` for it in the webapp startup.

### Phase 3: ClickHouse migration

Add migration `016_add_metrics.sql` with the single `metrics_v1` table from section 3.3. No materialized views — coarser resolution is achieved at query time via GROUP BY.

### Phase 4: API and presenters

- New `QueueMetricsPresenter` that queries `metrics_v1` with appropriate GROUP BY resolution based on time range (see section 3.5)
- New API endpoint `GET /api/v1/queues/:queueParam/metrics`
- Environment-level metrics endpoint `GET /api/v1/environments/:envId/queue-metrics`

---

## 8. Alerting Architecture

### How alerts fit in

The alerting system should **not** be part of the stream consumer pipeline. Instead, it should be a separate polling loop that queries ClickHouse aggregated data:

```
┌─────────────────────────────────────┐
│  QueueAlertEvaluator (cron job)     │
│  - Runs every 30s via redis-worker  │
│  - Queries metrics_v1               │
│  - Evaluates alert rules            │
│  - Creates ProjectAlert records     │
└─────────────────────────────────────┘
```

### Why separate from the consumer?

1. **Decoupled failure domains**: Alert evaluation failing shouldn't affect metric ingestion
2. **Different cadence**: Metrics are ingested every second; alerts are evaluated every 30s
3. **Query flexibility**: Alert conditions can use complex ClickHouse aggregations across multiple minutes
4. **Reuses existing infrastructure**: The existing `ProjectAlert` + `ProjectAlertChannel` + `DeliverAlertService` system handles delivery via Slack/Email/Webhook

### Proposed alert types

Add new values to the `ProjectAlertType` enum:

```prisma
enum ProjectAlertType {
  TASK_RUN            // existing
  TASK_RUN_ATTEMPT    // existing (deprecated)
  DEPLOYMENT_FAILURE  // existing
  DEPLOYMENT_SUCCESS  // existing
  QUEUE_BACKLOG       // NEW - queue depth exceeds threshold
  QUEUE_LATENCY       // NEW - wait time exceeds threshold
  QUEUE_ERROR_RATE    // NEW - failure rate exceeds threshold
}
```

### Alert rule configuration

Store alert rules in a new model:

```prisma
model QueueAlertRule {
  id            String @id @default(cuid())
  friendlyId    String @unique

  project       Project @relation(...)
  projectId     String

  environment   RuntimeEnvironment @relation(...)
  environmentId String

  // Optional: specific queue, or null = all queues
  queueName     String?

  // Rule configuration
  metric        QueueAlertMetric  // BACKLOG, LATENCY, ERROR_RATE
  operator      AlertOperator     // GREATER_THAN, LESS_THAN
  threshold     Float
  windowMinutes Int @default(5)   // evaluation window

  // Cooldown to prevent alert storms
  cooldownMinutes Int @default(15)
  lastTriggeredAt DateTime?

  enabled       Boolean @default(true)

  channels      ProjectAlertChannel[]

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

### Alert evaluation flow

```
1. QueueAlertEvaluator runs every 30s (via redis-worker cron)
2. Fetch all enabled QueueAlertRules
3. For each rule, query ClickHouse (`metrics_v1` with appropriate GROUP BY resolution):
   - BACKLOG: SELECT max(max_value) FROM metrics_v1
              WHERE metric_name = 'queue.depth'
              AND metric_subject = {queueName}
              AND bucket_start > now() - interval {windowSeconds} second
   - LATENCY: SELECT sum(sum_value) / sum(count) FROM metrics_v1
              WHERE metric_name = 'queue.wait_duration_ms' AND ...
   - ERROR_RATE: (sum of count for queue.nack_count + queue.dlq_count) /
                 (sum of count for queue.dequeue_count) FROM metrics_v1 WHERE ...
4. If threshold exceeded AND cooldown expired:
   a. Create ProjectAlert record
   b. Enqueue DeliverAlertService for each configured channel
   c. Update lastTriggeredAt
```

### Auto-resolve

When the condition is no longer met, the evaluator can optionally auto-resolve:

- Check if the metric has been below threshold for `windowMinutes`
- Send a "resolved" notification via the same channels
- This prevents alert fatigue from flapping conditions

---

## 9. Risks

### Risk 1: Double-counting on consumer crash (MEDIUM)

**The problem**: If the consumer crashes after a successful ClickHouse INSERT but before XACK, the entries remain in the PEL. On restart, they're re-read, re-aggregated, and re-inserted. With MergeTree, duplicate inserts simply produce duplicate rows. Queries that use `GROUP BY` + `sum()` would **double-count** the values from that batch, producing inflated counters for the affected 5s bucket.

Gauge metrics using `max()` are unaffected — `max(x, x) = x`.

**Likelihood**: Low. Requires a crash in the ~millisecond window between INSERT completing and XACK completing.

**Impact**: One 5s bucket shows ~2x real counter values. Manifests as a brief spike in throughput graphs. Could trigger a false alert if the doubled count crosses a threshold (but the next evaluation 30s later would see normal values).

**Mitigations** (pick one):

1. **ClickHouse insert deduplication** (recommended): ClickHouse deduplicates identical inserted blocks by default (`insert_deduplicate=1`). If the consumer processes PEL entries separately from new entries (two separate INSERT calls), the PEL retry produces the exact same rows in the same order, same block hash, and ClickHouse rejects the duplicate. **This works as long as PEL entries and new entries are never mixed in the same INSERT batch.**
2. **Idempotency key per batch**: Include a `batch_id` column and use ReplacingMergeTree. But this changes merge semantics and adds complexity.
3. **Accept it**: The window is small, the impact is bounded, and it self-corrects on the next bucket.

### Risk 2: MergeTree requires explicit GROUP BY (LOW)

**The situation**: Since we use MergeTree (not SummingMergeTree), there is no automatic row merging. Every inserted row is preserved as-is. Queries MUST use `GROUP BY` with appropriate aggregate functions (`sum()`, `max()`, etc.) to produce correct results.

**Impact**: This is actually simpler and less error-prone than SummingMergeTree, where you had to remember to either use `FINAL` or manual aggregation to avoid partial-merge artifacts. With plain MergeTree, the rule is straightforward: always GROUP BY, always aggregate.

**Mitigation**: The presenter layer should always use the query patterns from section 3.5, which include explicit GROUP BY and aggregate functions. This is a one-time implementation detail. Since there is no "automatic merging" to create a false sense of correctness, developers are naturally guided toward writing correct queries.

### Risk 3: Redis Cluster incompatibility (LOW — but blocks future migration)

**The problem**: The current Lua scripts use keys with different hash tag patterns in the same script. For example, `enqueueMessage` touches both `masterQueue:shard:0` (no hash tag) and `{org:X}:proj:Y:env:Z:queue:Q` (org hash tag). This works because the RunQueue uses a single Redis instance, not Redis Cluster.

Adding a metrics stream key (e.g., `queue_metrics:shard:0`) to these Lua scripts continues this pattern — it's fine on a single instance but would fail on Redis Cluster because keys must hash to the same slot within a Lua script.

**Impact**: Not a current issue, but constrains future Redis Cluster migration.

**Mitigation**: If Redis Cluster becomes necessary, move the XADD out of the Lua script and into Node.js. The Node.js layer would read the Lua script's return values (which already include queue state) and issue the XADD to a separate connection. This loses the atomic snapshot property but the inaccuracy is negligible (microseconds between Lua return and XADD).

### Risk 4: MAXLEN data loss during consumer outage (MEDIUM)

**The problem**: If the consumer is down for an extended period, the stream fills to MAXLEN (~100K entries per shard). Once full, new XADD calls trim the oldest entries. Those entries are gone — they were never processed.

**Impact**: Gap in metrics data proportional to the outage duration. At 1000 ops/sec with MAXLEN 100K, the stream fills in ~100 seconds. Any outage longer than that loses data.

**Mitigations**:

1. **Increase MAXLEN**: 500K entries ≈ 100MB per shard, buys ~8 minutes of buffer. Reasonable.
2. **Monitor consumer lag**: Alert on `XPENDING` count growing. If the consumer is falling behind, intervene before data loss.
3. **Accept bounded loss**: Queue operations are unaffected. Metrics gaps are visible but not catastrophic — the system is designed to be best-effort.

### Risk 5: Feature flag adds latency even when disabled (LOW)

**The problem**: The design proposes checking `redis.call('GET', 'queue_metrics:enabled')` inside every Lua script. This adds a GET to every queue operation even when metrics are disabled.

**Mitigation**: Pass the enabled/disabled flag as an ARGV from Node.js instead of reading it from Redis inside Lua. The Node.js layer can cache the flag and refresh it periodically (e.g., every 10s). This moves the check out of the hot path entirely.

### Risk 6: Future MV cascade risk (NOT CURRENT)

**Current state**: There are no materialized views in the initial design — just a single `metrics_v1` table. This risk does not apply today.

**Future consideration**: If materialized views are added later for pre-aggregated minute/hour rollups, they would introduce a cascade risk: incorrect data in the base table propagates to downstream MVs permanently. At that point, the same mitigations apply — `ALTER TABLE DELETE` mutations can correct affected rows across all tables, though they're expensive and should be rare.

---

## 10. Metric Importance Ranking

Ranked by user value — how directly the metric answers questions users actually ask.

### Tier 1: Must-have (ship in v1)

**1. Queue depth over time** — `queue.depth` (max_value)

- Answers: "Is my queue backed up? Is it growing or draining?"
- Why #1: This is the single most glanceable metric. A growing queue depth means processing can't keep up with ingest. Every user will look at this first.
- Alert: `QUEUE_BACKLOG` — "queue depth > N for M minutes"

**2. Wait time (queue latency)** — `queue.wait_duration_ms` (sum_value / count)

- Answers: "How long do tasks wait before starting execution?"
- Why #2: Directly maps to end-user-perceived latency. If you trigger a task via an API call, wait time is your latency budget. This is often more actionable than queue depth — a queue with 1000 items draining fast might have lower wait time than a queue with 10 items and no concurrency.
- Alert: `QUEUE_LATENCY` — "avg wait time > N seconds"

**3. Concurrency utilization** — `queue.concurrency_current` (max_value, with concurrency_limit for context)

- Answers: "Am I at my concurrency limit? Should I increase it?"
- Why #3: If utilization is consistently at 100%, the user knows exactly what to do (increase limit or optimize task duration). If it's low despite high queue depth, something else is wrong (paused queue, no workers, etc.). This is the diagnostic bridge between "queue is backed up" and "here's why."

### Tier 2: Important (ship in v1 if feasible, otherwise v2)

**4. Throughput** — `queue.enqueue_count`, `queue.dequeue_count`, `queue.ack_count` (count) per time window

- Answers: "What's my processing rate? How busy is this queue?"
- Why tier 2: Useful for capacity planning and spotting trends, but less immediately actionable than depth/latency/utilization. A user rarely wakes up and says "my throughput dropped" — they say "my queue is backed up" (depth) or "tasks are slow" (latency).

**5. Oldest message age** — `queue.oldest_message_age_ms` (max_value)

- Answers: "Is something stuck?"
- Why tier 2: This is a specialization of queue depth but catches a different failure mode — a queue with only 5 items where the oldest is 30 minutes old suggests a stuck consumer or a permanently-failing task. Very useful for debugging but less universally applicable than depth/latency.

### Tier 3: Good to have (v2)

**6. Failure rate** — `queue.nack_count` + `queue.dlq_count` (count) relative to `queue.dequeue_count` (count)

- Answers: "What percentage of my tasks are failing?"
- Why tier 3: Users already have per-run failure visibility in the existing dashboard. This adds the aggregate view (failure _rate_ over time), which is useful for spotting trends but somewhat redundant with existing task run alerting (`TASK_RUN` alert type already exists).
- Alert: `QUEUE_ERROR_RATE` — "failure rate > N% over M minutes"

**7. TTL expiration rate** — `queue.ttl_expire_count` (count)

- Answers: "Am I losing work to TTL expirations?"
- Why tier 3: Only relevant for users who configure TTLs. When it fires, it's serious (work is being silently dropped), but the audience is small. Worth tracking from day one since it's nearly free (the counter is already in the schema), but the dashboard/alert for it can ship later.

### Tier 4: Environment-level aggregates (v2)

**8. Environment-level totals** — all above metrics aggregated across queues

- Answers: "Is my environment healthy overall?"
- Why tier 4: Useful for the dashboard overview page, but most debugging starts at the queue level. The per-queue metrics above are more actionable. Environment-level metrics are essentially `WHERE environment_id = X` without `AND metric_subject = Y` — a query pattern, not a new metric.

### Summary table

| Rank | Metric                  | Primary Question             | Alert            | Ship in |
| ---- | ----------------------- | ---------------------------- | ---------------- | ------- |
| 1    | Queue depth             | "Is my queue backed up?"     | QUEUE_BACKLOG    | v1      |
| 2    | Wait time               | "How long do tasks wait?"    | QUEUE_LATENCY    | v1      |
| 3    | Concurrency utilization | "Am I at my limit?"          | —                | v1      |
| 4    | Throughput              | "What's my processing rate?" | —                | v1/v2   |
| 5    | Oldest message age      | "Is something stuck?"        | —                | v1/v2   |
| 6    | Failure rate            | "Are tasks failing?"         | QUEUE_ERROR_RATE | v2      |
| 7    | TTL expiration rate     | "Am I losing work?"          | —                | v2      |
| 8    | Environment aggregates  | "Is my env healthy?"         | —                | v2      |

---

## 11. Performance Considerations

### Redis impact

Each Lua script gains 2-4 extra Redis commands (ZCARD, SCARD, GET, XADD):

| Command                     | Time Complexity    | Typical Latency |
| --------------------------- | ------------------ | --------------- |
| `ZCARD`                     | O(1)               | < 1μs           |
| `SCARD`                     | O(1)               | < 1μs           |
| `GET`                       | O(1)               | < 1μs           |
| `ZRANGE ... 0 0 WITHSCORES` | O(1) for 1 element | < 1μs           |
| `XADD` with MAXLEN ~        | O(1) amortized     | < 10μs          |

Total added latency per operation: **< 15μs**. Negligible compared to the ~50-100μs total Lua script execution time.

### Memory impact

With MAXLEN ~100000 per shard and 2 shards:

- ~200K stream entries
- Each entry ~200 bytes
- **~40MB total** — well within acceptable Redis memory overhead

### ClickHouse impact

Since the consumer pre-aggregates into 5s buckets before inserting into `metrics_v1`, row counts scale with _active entities per 5s window_ times _metrics per entity_, not with raw operation throughput:

- **Single `metrics_v1` table** with 30-day TTL: ~7 metric rows per active queue per 5s bucket = ~120,960 rows/day per continuously active queue
  - 1,000 active queues: ~121M rows/day, ~3.6B rows retained (30 days)
  - With ZSTD compression: ~50-100 bytes/row compressed, ~180-360GB on disk at this scale
  - In practice, most queues are intermittently active, so real-world row counts are significantly lower
- **No raw table**: eliminates what would have been ~86M rows/day at 1000 ops/sec
- **No materialized views**: simplifies operations, MVs can be added later if query performance on large time ranges requires it

The critical scaling property: a queue that processes 1 event/5s and a queue that processes 10,000 events/5s produce the _same number of rows_ in ClickHouse (one set of metric rows per 5s window). Volume is proportional to distinct active entities, not throughput.

### Consumer resource usage

- Each consumer polls 1 shard every 1s
- Processes up to 1000 entries per poll
- Single ClickHouse INSERT per batch
- Minimal CPU and memory footprint

---

## 12. Failure Modes and Recovery

| Failure                                | Impact                                            | Recovery                                                            |
| -------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| XADD fails in Lua (pcall catches it)   | Metric point lost                                 | Acceptable — queue operation succeeds                               |
| Stream consumer crashes                | Messages accumulate in stream (bounded by MAXLEN) | Consumer restarts, reads from PEL + new entries                     |
| ClickHouse INSERT fails                | Messages stay in PEL                              | Retry with backoff; after 3 failures, pause + alert                 |
| ClickHouse is down for extended period | Stream fills to MAXLEN, oldest entries trimmed    | Gap in metrics; stream entries lost but queue operations unaffected |
| Redis memory pressure                  | MAXLEN trimming kicks in aggressively             | Some metric points lost; core queue operations unaffected           |

The key invariant: **queue operations (enqueue/dequeue/ack) are never blocked or slowed by metrics failures**.

---

## 13. Migration and Rollout Strategy

1. **Feature flag**: Pass a metrics-enabled flag as an ARGV to Lua scripts from Node.js (see Risk 5 — avoids an extra GET on every Lua invocation). The Node.js layer caches the flag from a Redis key (`queue_metrics:enabled`) and refreshes every 10s:

   ```lua
   local metricsEnabled = ARGV[metricsEnabledIndex]
   if metricsEnabled == '1' then
     -- emit metrics
   end
   ```

2. **Deploy consumer first**: Start the consumer before enabling emission. It will idle until metrics start flowing.

3. **Enable emission**: Set `queue_metrics:enabled` to `1`. Metrics immediately start flowing.

4. **Monitor**: Watch Redis memory, stream length, ClickHouse insert rates, consumer lag.

5. **Expose to users**: Once data is stable, enable the API endpoints and dashboard components.

---

## 14. Summary of Tradeoffs

| Decision                                   | Alternative                         | Why This Choice                                                                                                                               |
| ------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| No raw table, consumer pre-aggregates      | Raw MergeTree + MV                  | Eliminates ~86M rows/day. Volume scales with active entities, not throughput. Consumer pre-aggregation into `metrics_v1` is straightforward.  |
| MergeTree with generic schema              | SummingMergeTree                    | The `attributes` JSON column means rows with the same ORDER BY key can have different attributes and should not be merged. MergeTree preserves all rows; queries use explicit GROUP BY. Simpler mental model — no partial-merge surprises. |
| Generic schema vs queue-specific columns   | Dedicated table per metric type     | Single `metrics_v1` table supports queue metrics, OTel task metrics, worker health, and any future metric type. No schema migrations needed to add new metric types — just add a new MetricDefinition. |
| Single table with query-time resolution    | 3-tier: 5s → 1m → 1h with MVs      | Simpler operations, no MV cascade risk. Queries use GROUP BY toStartOfMinute/toStartOfHour for coarser resolution. MVs can be added later if query performance requires it. |
| 30-day TTL on single table                 | Multi-tier TTLs (2d/31d/400d)       | 30 days covers most dashboard use cases. Single TTL is simpler to reason about and operate. |
| XADD in Lua (inline)                       | Emit from Node.js after Lua returns | Lua gives atomic snapshot of queue state at exact moment of operation. Node.js would need separate Redis calls and introduce race conditions. |
| Auto-generated stream IDs                  | Custom second+queue IDs             | Avoids silent data loss from collisions. Redis auto-IDs are monotonic and unique.                                                             |
| Separate alert evaluator                   | Alert in consumer pipeline          | Decoupled failure domains, simpler consumer logic, richer query capabilities.                                                                 |
| Sharded streams                            | Single stream                       | Matches existing queue shard architecture. Enables horizontal scaling.                                                                        |
