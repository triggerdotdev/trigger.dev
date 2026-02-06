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

### 3.1 Raw metrics table

```sql
-- +goose Up
CREATE TABLE trigger_dev.raw_queue_metrics_v1
(
  -- Identifiers
  organization_id     String,
  project_id          String,
  environment_id      String,
  queue_name          String,

  -- Timestamp of the metric snapshot
  timestamp           DateTime64(3),

  -- What operation triggered this snapshot
  operation           LowCardinality(String),  -- 'enqueue', 'dequeue', 'ack', 'nack', 'dlq', 'ttl_expire'

  -- Gauge metrics (point-in-time snapshots after the operation)
  queue_length        UInt32 DEFAULT 0,        -- ZCARD of the queue sorted set
  concurrency_current UInt32 DEFAULT 0,        -- SCARD of currentConcurrency set
  concurrency_limit   UInt32 DEFAULT 0,        -- GET of concurrency limit key
  env_queue_length    UInt32 DEFAULT 0,        -- ZCARD of env queue
  env_concurrency     UInt32 DEFAULT 0,        -- SCARD of env currentConcurrency set
  env_concurrency_limit UInt32 DEFAULT 0,      -- GET of env concurrency limit key

  -- Counter/event metrics
  enqueue_count       UInt32 DEFAULT 0,        -- 1 if this was an enqueue, 0 otherwise
  dequeue_count       UInt32 DEFAULT 0,        -- number of messages dequeued (can be > 1)
  ack_count           UInt32 DEFAULT 0,
  nack_count          UInt32 DEFAULT 0,
  dlq_count           UInt32 DEFAULT 0,
  ttl_expire_count    UInt32 DEFAULT 0,

  -- Latency metrics (only populated on dequeue/ack)
  oldest_message_age_ms  UInt64 DEFAULT 0,     -- currentTime - score of oldest message in queue
  wait_duration_ms       UInt64 DEFAULT 0      -- time from enqueue to dequeue (on ack)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (organization_id, project_id, environment_id, queue_name, timestamp)
TTL timestamp + INTERVAL 8 DAY;
```

**Why MergeTree (not ReplacingMergeTree)?**
- These are append-only metric events, not mutable state. No need for deduplication or versioning.
- MergeTree has the best insert performance and simplest query semantics.
- TTL of 8 days keeps raw data manageable; aggregated data lives longer.

### 3.2 Minute-level aggregation (materialized view)

```sql
CREATE TABLE trigger_dev.queue_metrics_by_minute_v1
(
  organization_id     String,
  project_id          String,
  environment_id      String,
  queue_name          String,
  bucket_start        DateTime,

  -- Counters (summed)
  enqueue_count       UInt64,
  dequeue_count       UInt64,
  ack_count           UInt64,
  nack_count          UInt64,
  dlq_count           UInt64,
  ttl_expire_count    UInt64,

  -- Gauges (use AggregateFunction for proper max/avg)
  max_queue_length          SimpleAggregateFunction(max, UInt32),
  max_concurrency_current   SimpleAggregateFunction(max, UInt32),
  max_env_queue_length      SimpleAggregateFunction(max, UInt32),
  max_env_concurrency       SimpleAggregateFunction(max, UInt32),
  max_oldest_message_age_ms SimpleAggregateFunction(max, UInt64),
  avg_wait_duration_ms      AggregateFunction(avg, UInt64),

  -- For computing averages
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
  toStartOfMinute(timestamp) AS bucket_start,
  sum(enqueue_count) AS enqueue_count,
  sum(dequeue_count) AS dequeue_count,
  sum(ack_count) AS ack_count,
  sum(nack_count) AS nack_count,
  sum(dlq_count) AS dlq_count,
  sum(ttl_expire_count) AS ttl_expire_count,
  max(queue_length) AS max_queue_length,
  max(concurrency_current) AS max_concurrency_current,
  max(env_queue_length) AS max_env_queue_length,
  max(env_concurrency) AS max_env_concurrency,
  max(oldest_message_age_ms) AS max_oldest_message_age_ms,
  avgState(wait_duration_ms) AS avg_wait_duration_ms,
  sum(wait_duration_ms) AS total_wait_duration_ms,
  countIf(wait_duration_ms > 0) AS wait_duration_count
FROM trigger_dev.raw_queue_metrics_v1
GROUP BY organization_id, project_id, environment_id, queue_name, bucket_start;
```

### 3.3 Hour-level aggregation

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
| **Throughput** | Enqueues/s, dequeues/s, completions/s | `sum(enqueue_count)` over time from minute table | "How busy is my queue?" |
| **Queue depth over time** | Historical queue length graph | `max(max_queue_length)` from minute table | "Is my queue growing or draining?" |
| **Wait time (queue latency)** | Time from enqueue to dequeue | `total_wait_duration_ms / wait_duration_count` from minute table | "How long do my tasks wait before starting?" — the most important user metric |
| **Oldest message age** | How stale the oldest waiting run is | `max(max_oldest_message_age_ms)` from minute table | "Is something stuck?" |
| **Concurrency utilization over time** | Historical concurrency usage | `max(max_concurrency_current) / max(concurrency_limit)` | "Should I increase my concurrency limit?" |
| **Failure rate** | Nacks + DLQ moves per minute | `sum(nack_count + dlq_count) / sum(dequeue_count)` | "Are my tasks failing?" |
| **TTL expiration rate** | Runs expiring before execution | `sum(ttl_expire_count)` over time | "Am I losing work to TTLs?" |
| **Environment-level totals** | Aggregate of all queues | Filtered by `environment_id`, grouped by time | "Overall environment health" |

### 5.3 Recommended API shape

```typescript
// GET /api/v1/queues/:queueParam/metrics?period=1h&resolution=1m
{
  queue: "my-queue",
  period: { start: "2025-01-01T00:00:00Z", end: "2025-01-01T01:00:00Z" },
  resolution: "1m",
  timeseries: [
    {
      timestamp: "2025-01-01T00:00:00Z",
      throughput: { enqueued: 42, dequeued: 38, completed: 35 },
      queue_depth: { max: 120, current: 95 },
      latency: { avg_wait_ms: 1523, max_age_ms: 8200 },
      concurrency: { current: 8, limit: 10, utilization_pct: 80 },
      failures: { nack: 2, dlq: 0, ttl_expired: 1 }
    },
    // ... one entry per minute
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
    // 3. Parse entries into ClickHouse insert format
    // 4. Bulk INSERT into raw_queue_metrics_v1
    // 5. On success: XACK all processed IDs
    // 6. On failure: back off, retry from PEL next iteration
  }

  async stop(): Promise<void> {
    // Graceful shutdown
  }
}
```

### Phase 3: ClickHouse migration

Add migration `016_add_queue_metrics.sql` with the tables and materialized views from section 3.

### Phase 4: API and presenters

- New `QueueMetricsPresenter` that queries the minute/hour tables
- New API endpoint `GET /api/v1/queues/:queueParam/metrics`
- Environment-level metrics endpoint `GET /api/v1/environments/:envId/queue-metrics`

---

## 7. Alerting Architecture

### How alerts fit in

The alerting system should **not** be part of the stream consumer pipeline. Instead, it should be a separate polling loop that queries ClickHouse aggregated data:

```
┌─────────────────────────────────────┐
│  QueueAlertEvaluator (cron job)     │
│  - Runs every 60s via redis-worker  │
│  - Queries queue_metrics_by_minute  │
│  - Evaluates alert rules            │
│  - Creates ProjectAlert records     │
└─────────────────────────────────────┘
```

### Why separate from the consumer?

1. **Decoupled failure domains**: Alert evaluation failing shouldn't affect metric ingestion
2. **Different cadence**: Metrics are ingested every second; alerts are evaluated every minute
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
1. QueueAlertEvaluator runs every 60s (via redis-worker cron)
2. Fetch all enabled QueueAlertRules
3. For each rule, query ClickHouse:
   - BACKLOG: SELECT max(max_queue_length) FROM queue_metrics_by_minute_v1
              WHERE timestamp > now() - interval {windowMinutes} minute
              AND queue_name = {queueName}
   - LATENCY: SELECT max(total_wait_duration_ms / wait_duration_count)
              FROM queue_metrics_by_minute_v1 WHERE ...
   - ERROR_RATE: SELECT sum(nack_count + dlq_count) / sum(dequeue_count)
                 FROM queue_metrics_by_minute_v1 WHERE ...
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

- Raw table: ~8 days retention, auto-pruned by TTL
- At 1000 ops/sec, that's ~86M rows/day → ~690M rows in 8 days
- With ZSTD compression and LowCardinality, expect ~10-20 bytes per row on disk → **~7-14GB** for raw data
- Minute aggregation: 1440 rows/day/queue → negligible
- Hour aggregation: 24 rows/day/queue → negligible

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
| ClickHouse is down for extended period | Stream fills to MAXLEN, oldest entries trimmed | Gap in metrics; raw data lost but queue operations unaffected |
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
| MergeTree for raw metrics | ReplacingMergeTree | Append-only events, no updates needed. Simpler. |
| SummingMergeTree for aggregations | AggregatingMergeTree | Simpler query semantics (`sum()` vs `merge()`). Matches existing codebase pattern (task_event_usage tables). |
| XADD in Lua (inline) | Emit from Node.js after Lua returns | Lua gives atomic snapshot of queue state at exact moment of operation. Node.js would need separate Redis calls and introduce race conditions. |
| Auto-generated stream IDs | Custom second+queue IDs | Avoids silent data loss from collisions. Redis auto-IDs are monotonic and unique. |
| Separate alert evaluator | Alert in consumer pipeline | Decoupled failure domains, simpler consumer logic, richer query capabilities. |
| 8-day raw TTL, 31-day minute, 400-day hour | Longer raw retention | Matches existing task_events pattern. Raw data is voluminous; aggregations are compact. |
| Sharded streams | Single stream | Matches existing queue shard architecture. Enables horizontal scaling. |
