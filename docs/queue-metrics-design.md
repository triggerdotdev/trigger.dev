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
│  raw_queue_metrics_v1  (MergeTree)  │
│         │                           │
│         ├─► queue_metrics_by_minute  │
│         │   (SummingMergeTree + MV)  │
│         │                           │
│         └─► queue_metrics_by_hour    │
│             (SummingMergeTree + MV)  │
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

### 3.1 Cardinality analysis

The dimension cardinality of queue metrics is **not low** and should be designed for growth:

| Dimension | Current | Future Growth Path |
|-----------|---------|-------------------|
| `organization_id` | Hundreds | Thousands (hosted platform growth) |
| `project_id` | ~1-10 per org | Tens per org |
| `environment_id` | ~3-5 per project | Thousands per project (preview envs, ephemeral test envs) |
| `queue_name` | Tens per project (task-based) | Stable — per-entity queue names have been removed |

The cross-product of `(org × project × env × queue)` could reach millions of unique combinations at scale. However, the critical insight is that **only active queues produce rows** — a queue with no operations in a 5-second window produces zero rows. Most queues are idle most of the time, so the actual row count is driven by active queue-seconds, not total queues.

This means:
- **No raw per-event table**: Storing a row per Lua script invocation would be wasteful at high throughput. Instead, the consumer pre-aggregates stream entries into 5-second buckets before inserting into ClickHouse.
- **SummingMergeTree is safe**: Even with high cardinality, SummingMergeTree handles the merge load well because the ORDER BY key matches exactly what we group by.
- **ABR-style sampling is not needed yet** but could become relevant if the active queue count grows into the tens of thousands.

### 3.2 5-second table (primary tier, direct ingest target)

The consumer pre-aggregates raw stream entries into 5-second buckets in memory, then inserts directly into this table. There is no raw table and no materialized view — the consumer does the aggregation.

```sql
-- +goose Up
CREATE TABLE trigger_dev.queue_metrics_5s_v1
(
  organization_id     String,
  project_id          String,
  environment_id      String,
  queue_name          String,
  bucket_start        DateTime,

  -- Counters (summed by SummingMergeTree on merge)
  enqueue_count       UInt64,
  dequeue_count       UInt64,
  ack_count           UInt64,
  nack_count          UInt64,
  dlq_count           UInt64,
  ttl_expire_count    UInt64,

  -- Gauges (SimpleAggregateFunction takes max on merge)
  max_queue_length          SimpleAggregateFunction(max, UInt32),
  max_concurrency_current   SimpleAggregateFunction(max, UInt32),
  max_env_queue_length      SimpleAggregateFunction(max, UInt32),
  max_env_concurrency       SimpleAggregateFunction(max, UInt32),
  max_oldest_message_age_ms SimpleAggregateFunction(max, UInt64),

  -- For computing averages at query time (summed on merge)
  total_wait_duration_ms    UInt64,
  wait_duration_count       UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, project_id, environment_id, queue_name, bucket_start)
TTL bucket_start + INTERVAL 2 DAY;
```

**Why no raw table?**

A raw per-event table (one row per Lua script invocation) would be the most flexible but is wasteful for this use case:
- At 1000 ops/sec → 86M rows/day in raw vs. ~17K rows/day per active queue in 5s buckets
- We don't need per-event granularity — 5s resolution is sufficient for all user-facing queries
- The consumer can pre-aggregate in memory trivially (group stream entries by `(org, proj, env, queue, floor(ts/5s))` and compute sums/maxes)
- SummingMergeTree handles duplicate inserts gracefully — if two consumer batches insert rows for the same 5s bucket, ClickHouse merges them correctly

**Why 5-second buckets with 2-day TTL?**
- 5s gives 12 data points per minute — smooth enough for real-time graphs, coarse enough to keep row counts manageable
- Row count scales with *active* queues, not total queues — idle queues produce zero rows
- 2-day TTL is sufficient since this tier is for real-time/recent dashboards; minute and hour tiers cover longer windows

### 3.3 Minute-level aggregation (middle tier)

Rolls up from the 5-second table. Used for 1-hour to 7-day dashboard views and alert evaluation.

```sql
CREATE TABLE trigger_dev.queue_metrics_by_minute_v1
(
  organization_id     String,
  project_id          String,
  environment_id      String,
  queue_name          String,
  bucket_start        DateTime,

  enqueue_count       UInt64,
  dequeue_count       UInt64,
  ack_count           UInt64,
  nack_count          UInt64,
  dlq_count           UInt64,
  ttl_expire_count    UInt64,

  max_queue_length          SimpleAggregateFunction(max, UInt32),
  max_concurrency_current   SimpleAggregateFunction(max, UInt32),
  max_env_queue_length      SimpleAggregateFunction(max, UInt32),
  max_env_concurrency       SimpleAggregateFunction(max, UInt32),
  max_oldest_message_age_ms SimpleAggregateFunction(max, UInt64),

  total_wait_duration_ms    UInt64,
  wait_duration_count       UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, project_id, environment_id, queue_name, bucket_start)
TTL bucket_start + INTERVAL 31 DAY;

CREATE MATERIALIZED VIEW trigger_dev.queue_metrics_by_minute_mv_v1
TO trigger_dev.queue_metrics_by_minute_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  queue_name,
  toStartOfMinute(bucket_start) AS bucket_start,
  sum(enqueue_count) AS enqueue_count,
  sum(dequeue_count) AS dequeue_count,
  sum(ack_count) AS ack_count,
  sum(nack_count) AS nack_count,
  sum(dlq_count) AS dlq_count,
  sum(ttl_expire_count) AS ttl_expire_count,
  max(max_queue_length) AS max_queue_length,
  max(max_concurrency_current) AS max_concurrency_current,
  max(max_env_queue_length) AS max_env_queue_length,
  max(max_env_concurrency) AS max_env_concurrency,
  max(max_oldest_message_age_ms) AS max_oldest_message_age_ms,
  sum(total_wait_duration_ms) AS total_wait_duration_ms,
  sum(wait_duration_count) AS wait_duration_count
FROM trigger_dev.queue_metrics_5s_v1
GROUP BY organization_id, project_id, environment_id, queue_name, bucket_start;
```

### 3.4 Hour-level aggregation (long-term tier)

Rolls up from minute table. Used for 7-day+ views and long-term trends.

```sql
CREATE TABLE trigger_dev.queue_metrics_by_hour_v1
(
  organization_id     String,
  project_id          String,
  environment_id      String,
  queue_name          String,
  bucket_start        DateTime,

  enqueue_count       UInt64,
  dequeue_count       UInt64,
  ack_count           UInt64,
  nack_count          UInt64,
  dlq_count           UInt64,
  ttl_expire_count    UInt64,

  max_queue_length          SimpleAggregateFunction(max, UInt32),
  max_concurrency_current   SimpleAggregateFunction(max, UInt32),
  max_env_queue_length      SimpleAggregateFunction(max, UInt32),
  max_env_concurrency       SimpleAggregateFunction(max, UInt32),
  max_oldest_message_age_ms SimpleAggregateFunction(max, UInt64),

  total_wait_duration_ms    UInt64,
  wait_duration_count       UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (organization_id, project_id, environment_id, queue_name, bucket_start)
TTL bucket_start + INTERVAL 400 DAY;

CREATE MATERIALIZED VIEW trigger_dev.queue_metrics_by_hour_mv_v1
TO trigger_dev.queue_metrics_by_hour_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  queue_name,
  toStartOfHour(bucket_start) AS bucket_start,
  sum(enqueue_count) AS enqueue_count,
  sum(dequeue_count) AS dequeue_count,
  sum(ack_count) AS ack_count,
  sum(nack_count) AS nack_count,
  sum(dlq_count) AS dlq_count,
  sum(ttl_expire_count) AS ttl_expire_count,
  max(max_queue_length) AS max_queue_length,
  max(max_concurrency_current) AS max_concurrency_current,
  max(max_env_queue_length) AS max_env_queue_length,
  max(max_env_concurrency) AS max_env_concurrency,
  max(max_oldest_message_age_ms) AS max_oldest_message_age_ms,
  sum(total_wait_duration_ms) AS total_wait_duration_ms,
  sum(wait_duration_count) AS wait_duration_count
FROM trigger_dev.queue_metrics_by_minute_v1
GROUP BY organization_id, project_id, environment_id, queue_name, bucket_start;
```

### 3.5 Handling idle queues (the "stale gauge" problem)

Since we only emit metrics on queue operations, an idle queue with 500 items sitting in it produces **zero rows** in any 5s window where no enqueue/dequeue/ack occurs. But the queue isn't empty — the user's dashboard should still show depth = 500.

This only affects **gauge metrics** (queue_length, concurrency_current, oldest_message_age_ms). Counter metrics are fine — zero rows correctly means zero activity.

**Solution: "last known value" carry-forward at query time**

When the presenter queries a time window, it also fetches the most recent row *before* the window start for each queue to seed the initial gauge values:

```sql
-- Get the last known gauge values before the requested window
SELECT queue_name,
       max_queue_length,
       max_concurrency_current,
       max_oldest_message_age_ms
FROM queue_metrics_5s_v1
WHERE environment_id = {envId}
  AND queue_name = {queueName}
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

### 3.6 Query routing by time range (ABR-inspired)

The query routing here borrows the core idea from [Cloudflare's ABR (Adaptive Bit Rate) analytics](https://blog.cloudflare.com/explaining-cloudflares-abr-analytics/): automatically select the best resolution table for each query based on the requested time range, so dashboards stay fast regardless of how far back the user looks.

**Why full ABR (sampling) isn't needed yet**: Cloudflare's ABR stores the *same raw events* at decreasing sample rates (100%, 10%, 1%, 0.01%) across parallel tables and multiplies counts by the sample interval at query time. This is designed for extremely high-cardinality data (billions of unique IP/URL/rule combinations per day) where pre-aggregation is impractical because you don't know what dimensions the user will GROUP BY.

Queue metrics differ in one critical way:
- **Fixed aggregations**: we always want the same sums/maxes — no ad-hoc GROUP BY on arbitrary fields. This means pre-aggregation works, unlike Cloudflare's analytics where users query arbitrary dimension combinations.

However, the cardinality is **not low** (see section 3.1) — the `(org × project × env × queue)` cross-product can reach millions. The saving grace is that volume scales with *active* queues, not total queues. If this assumption changes (e.g., many queues with low-frequency but steady activity across thousands of environments), ABR-style sampling at the 5s tier would become the right move.

For now, **tiered pre-aggregation** (5s → 1m → 1h) is simpler and gives deterministic query performance without sample-interval arithmetic. We get the *spirit* of ABR — adaptive resolution selection — via table routing:

| Requested Period | Resolution | Table | Max Data Points |
|-----------------|------------|-------|-----------------|
| Last 30 minutes | 5s | `queue_metrics_5s_v1` | 360 |
| Last 2 hours | 5s | `queue_metrics_5s_v1` | 1,440 |
| Last 24 hours | 1m | `queue_metrics_by_minute_v1` | 1,440 |
| Last 7 days | 1m | `queue_metrics_by_minute_v1` | 10,080 |
| Last 30+ days | 1h | `queue_metrics_by_hour_v1` | 720 |

The presenter can also downsample at query time (e.g., `GROUP BY toStartOfMinute(bucket_start)` on the 5s table) for periods between 2h-24h where you want fewer data points but higher fidelity than the minute table.

---

## 4. What Metrics Happen in Lua vs. Node.js

### Collected inside Lua scripts (cheap, atomic, consistent)

These are O(1) Redis operations added to the end of each Lua script:

| Metric | Redis Command | Available In |
|--------|--------------|-------------|
| `queue_length` | `ZCARD queueKey` | enqueue, dequeue, ack, nack |
| `concurrency_current` | `SCARD queueCurrentConcurrencyKey` | enqueue, dequeue, ack, nack |
| `concurrency_limit` | `GET queueConcurrencyLimitKey` | dequeue |
| `env_queue_length` | `ZCARD envQueueKey` | enqueue, dequeue, ack |
| `env_concurrency` | `SCARD envCurrentConcurrencyKey` | enqueue, dequeue, ack, nack |
| `env_concurrency_limit` | `GET envConcurrencyLimitKey` | dequeue |
| `oldest_message_age_ms` | `ZRANGE queueKey 0 0 WITHSCORES` then `currentTime - score` | enqueue, dequeue |
| operation type | Known from which script runs | all |
| timestamp | `redis.call('TIME')` | all |

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

| Metric | How |
|--------|-----|
| `wait_duration_ms` | On `ack` events: `ack_timestamp - message.timestamp` (from the OutputPayload) |
| Throughput rates | Computed at query time from count columns in ClickHouse |
| Concurrency utilization % | `concurrency_current / concurrency_limit * 100` at query time |

---

## 5. User-Facing Queue Metrics

### 5.1 Real-time dashboard (current state)

These continue to come from Redis directly (as they do today via `QueueListPresenter`/`QueueRetrievePresenter`):

| Metric | Description | Source |
|--------|-------------|--------|
| Queue depth | Number of runs waiting | `ZCARD` of queue sorted set |
| Running count | Number of runs executing | `SCARD` of currentConcurrency |
| Concurrency limit | Max concurrent executions | Queue concurrency limit key |
| Concurrency utilization | `running / limit * 100%` | Computed |
| Paused state | Whether queue is paused | PostgreSQL |

### 5.2 Historical analytics (from ClickHouse)

These are the new user-facing metrics enabled by this system:

| Metric | Description | Query Source | User Value |
|--------|-------------|-------------|------------|
| **Throughput** | Enqueues/s, dequeues/s, completions/s | `sum(enqueue_count) / 5` over time from 5s table | "How busy is my queue?" |
| **Queue depth over time** | Historical queue length graph | `max(max_queue_length)` from 5s table | "Is my queue growing or draining?" |
| **Wait time (queue latency)** | Time from enqueue to dequeue | `total_wait_duration_ms / wait_duration_count` from 5s table | "How long do my tasks wait before starting?" — the most important user metric |
| **Oldest message age** | How stale the oldest waiting run is | `max(max_oldest_message_age_ms)` from 5s table | "Is something stuck?" |
| **Concurrency utilization over time** | Historical concurrency usage | `max(max_concurrency_current) / max(concurrency_limit)` | "Should I increase my concurrency limit?" |
| **Failure rate** | Nacks + DLQ per 5s bucket | `sum(nack_count + dlq_count) / sum(dequeue_count)` | "Are my tasks failing?" |
| **TTL expiration rate** | Runs expiring before execution | `sum(ttl_expire_count)` over time | "Am I losing work to TTLs?" |
| **Environment-level totals** | Aggregate of all queues | Filtered by `environment_id`, grouped by time | "Overall environment health" |

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

## 6. Implementation Plan

### Phase 1: Lua script changes

Modify each Lua script to accept an additional KEYS entry (the metrics stream key) and emit an XADD at the end. The additional KEYS/ARGV entries to pass:

| Script | New KEYS | New ARGV |
|--------|----------|----------|
| `enqueueMessage` | `metricsStreamKey` | `orgId`, `projId`, `envId` |
| `enqueueMessageWithTtl` | `metricsStreamKey` | `orgId`, `projId`, `envId` |
| `dequeueMessagesFromQueue` | `metricsStreamKey` | `orgId`, `projId`, `envId` |
| `acknowledgeMessage` | `metricsStreamKey` | `orgId`, `projId`, `envId` |
| `nackMessage` | `metricsStreamKey` | `orgId`, `projId`, `envId` |
| `moveToDeadLetterQueue` | `metricsStreamKey` | `orgId`, `projId`, `envId` |

Note: The org/proj/env IDs are already available in the message payload (InputPayload/OutputPayload). For the enqueue script, they're directly in ARGV. For dequeue, they're parsed from the queue key. For ack/nack, the message data is available.

**Important**: The XADD is fire-and-forget within the Lua script. If it fails (e.g., stream doesn't exist), it should not abort the main operation. Wrap in `pcall`:

```lua
pcall(function()
  redis.call('XADD', streamKey, 'MAXLEN', '~', '100000', '*', ...)
end)
```

### Phase 2: Stream consumer

Create a new service class `QueueMetricsConsumer` in `internal-packages/run-engine/src/run-queue/`:

```typescript
export class QueueMetricsConsumer {
  constructor(options: {
    redis: RedisOptions;
    clickhouse: ClickHouseClient;
    shardCount: number;
    consumerGroup: string;
    consumerId: string;
    pollIntervalMs?: number;  // default: 1000
    batchSize?: number;       // default: 1000
    maxRetries?: number;      // default: 3
  }) {}

  async start(): Promise<void> {
    // 1. Create consumer group if not exists (XGROUP CREATE ... MKSTREAM)
    // 2. Start polling loop for each shard
  }

  private async pollShard(shard: number): Promise<void> {
    // 1. First, check for pending (unacked) entries: XREADGROUP ... 0
    // 2. Then read new entries: XREADGROUP ... >
    // 3. Pre-aggregate entries into 5s buckets in memory (see below)
    // 4. Bulk INSERT aggregated rows into queue_metrics_5s_v1
    // 5. On success: XACK all processed IDs
    // 6. On failure: back off, retry from PEL next iteration
  }

  /**
   * Pre-aggregates raw stream entries into 5-second buckets.
   *
   * Groups entries by (org, project, env, queue, floor(timestamp / 5000))
   * and computes:
   *   - Counters: sum of enqueue_count, dequeue_count, etc.
   *   - Gauges: max of queue_length, concurrency_current, etc.
   *   - Latency: sum of wait_duration_ms, count of non-zero waits
   *
   * This reduces N raw stream entries into M << N aggregated rows
   * (one per active queue per 5s window in the batch).
   *
   * SummingMergeTree handles the case where two consumer batches
   * produce rows for the same 5s bucket — they merge correctly
   * on background merge.
   */
  private preAggregate(entries: StreamEntry[]): AggregatedRow[] { ... }

  async stop(): Promise<void> {
    // Graceful shutdown
  }
}
```

### Phase 3: ClickHouse migration

Add migration `016_add_queue_metrics.sql` with the 5s table, minute/hour tables, and the two materialized views (5s→minute, minute→hour) from section 3.

### Phase 4: API and presenters

- New `QueueMetricsPresenter` that queries the 5s/minute/hour tables (auto-selects based on time range)
- New API endpoint `GET /api/v1/queues/:queueParam/metrics`
- Environment-level metrics endpoint `GET /api/v1/environments/:envId/queue-metrics`

---

## 7. Alerting Architecture

### How alerts fit in

The alerting system should **not** be part of the stream consumer pipeline. Instead, it should be a separate polling loop that queries ClickHouse aggregated data:

```
┌─────────────────────────────────────┐
│  QueueAlertEvaluator (cron job)     │
│  - Runs every 30s via redis-worker  │
│  - Queries queue_metrics_5s / _min  │
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
3. For each rule, query ClickHouse (uses 5s table for windows <= 2 hours, minute table otherwise):
   - BACKLOG: SELECT max(max_queue_length) FROM queue_metrics_5s_v1
              WHERE bucket_start > now() - interval {windowSeconds} second
              AND queue_name = {queueName}
   - LATENCY: SELECT sum(total_wait_duration_ms) / sum(wait_duration_count)
              FROM queue_metrics_5s_v1 WHERE ...
   - ERROR_RATE: SELECT sum(nack_count + dlq_count) / sum(dequeue_count)
                 FROM queue_metrics_5s_v1 WHERE ...
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

## 8. Performance Considerations

### Redis impact

Each Lua script gains 2-4 extra Redis commands (ZCARD, SCARD, GET, XADD):

| Command | Time Complexity | Typical Latency |
|---------|----------------|-----------------|
| `ZCARD` | O(1) | < 1μs |
| `SCARD` | O(1) | < 1μs |
| `GET` | O(1) | < 1μs |
| `ZRANGE ... 0 0 WITHSCORES` | O(1) for 1 element | < 1μs |
| `XADD` with MAXLEN ~ | O(1) amortized | < 10μs |

Total added latency per operation: **< 15μs**. Negligible compared to the ~50-100μs total Lua script execution time.

### Memory impact

With MAXLEN ~100000 per shard and 2 shards:
- ~200K stream entries
- Each entry ~200 bytes
- **~40MB total** — well within acceptable Redis memory overhead

### ClickHouse impact

Since the consumer pre-aggregates into 5s buckets before inserting, row counts scale with *active queues per 5s window*, not with raw operation throughput:

- **5s table** (primary): up to 17,280 rows/day per *continuously active* queue, 2-day TTL
  - 1,000 active queues → ~17M rows/day → ~35M rows retained (2 days)
  - With ZSTD compression: ~50-100 bytes/row → **~2-4GB** on disk
- **Minute table**: 1,440 rows/day per active queue, 31-day TTL → modest
- **Hour table**: 24 rows/day per active queue, 400-day TTL → negligible
- **No raw table**: eliminates what would have been ~86M rows/day at 1000 ops/sec

The critical scaling property: a queue that processes 1 event/5s and a queue that processes 10,000 events/5s produce the *same number of rows* in ClickHouse (1 per 5s window). Volume is proportional to distinct active queues, not throughput.

### Consumer resource usage

- Each consumer polls 1 shard every 1s
- Processes up to 1000 entries per poll
- Single ClickHouse INSERT per batch
- Minimal CPU and memory footprint

---

## 9. Failure Modes and Recovery

| Failure | Impact | Recovery |
|---------|--------|----------|
| XADD fails in Lua (pcall catches it) | Metric point lost | Acceptable — queue operation succeeds |
| Stream consumer crashes | Messages accumulate in stream (bounded by MAXLEN) | Consumer restarts, reads from PEL + new entries |
| ClickHouse INSERT fails | Messages stay in PEL | Retry with backoff; after 3 failures, pause + alert |
| ClickHouse is down for extended period | Stream fills to MAXLEN, oldest entries trimmed | Gap in metrics; stream entries lost but queue operations unaffected |
| Redis memory pressure | MAXLEN trimming kicks in aggressively | Some metric points lost; core queue operations unaffected |

The key invariant: **queue operations (enqueue/dequeue/ack) are never blocked or slowed by metrics failures**.

---

## 10. Migration and Rollout Strategy

1. **Feature flag**: Gate the XADD emission in Lua scripts behind a Redis key (`queue_metrics:enabled`). Check at the start of the metrics emission block:
   ```lua
   local metricsEnabled = redis.call('GET', 'queue_metrics:enabled')
   if metricsEnabled == '1' then
     -- emit metrics
   end
   ```

2. **Deploy consumer first**: Start the consumer before enabling emission. It will idle until metrics start flowing.

3. **Enable emission**: Set `queue_metrics:enabled` to `1`. Metrics immediately start flowing.

4. **Monitor**: Watch Redis memory, stream length, ClickHouse insert rates, consumer lag.

5. **Expose to users**: Once data is stable, enable the API endpoints and dashboard components.

---

## 11. Summary of Tradeoffs

| Decision | Alternative | Why This Choice |
|----------|-------------|-----------------|
| No raw table, consumer pre-aggregates | Raw MergeTree + MV | Eliminates ~86M rows/day. Volume scales with active queues, not throughput. SummingMergeTree handles duplicate 5s bucket inserts via merge. |
| SummingMergeTree for all tiers | AggregatingMergeTree | Simpler query semantics (`sum()` vs `merge()`). Matches existing codebase pattern (task_event_usage tables). |
| XADD in Lua (inline) | Emit from Node.js after Lua returns | Lua gives atomic snapshot of queue state at exact moment of operation. Node.js would need separate Redis calls and introduce race conditions. |
| Auto-generated stream IDs | Custom second+queue IDs | Avoids silent data loss from collisions. Redis auto-IDs are monotonic and unique. |
| Separate alert evaluator | Alert in consumer pipeline | Decoupled failure domains, simpler consumer logic, richer query capabilities. |
| 3-tier: 5s (ingest) → 1m → 1h | Raw + MV pipeline | Consumer pre-aggregation is simpler, avoids raw table bloat, and scales with active queues not throughput. |
| 2-day 5s, 31-day minute, 400-day hour TTLs | Longer 5s retention | 5s is for real-time dashboards only; minute and hour tiers cover longer windows cost-effectively. |
| Sharded streams | Single stream | Matches existing queue shard architecture. Enables horizontal scaling. |
