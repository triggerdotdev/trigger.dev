# Batch Queue & Fair Queue Metrics Guide

This document provides a comprehensive breakdown of all metrics emitted by the Batch Queue and Fair Queue systems, including what they mean and how to identify degraded system states.

## Overview

The batch queue system consists of two layers:
1. **BatchQueue** (`batch_queue.*`) - High-level batch processing metrics
2. **FairQueue** (`batch-queue.*`) - Low-level message queue metrics (with `name: "batch-queue"`)

Both layers emit metrics that together provide full observability into batch processing.

---

## BatchQueue Metrics

These metrics track batch-level operations.

### Counters

| Metric | Description | Labels |
|--------|-------------|--------|
| `batch_queue.batches_enqueued` | Number of batches initialized for processing | `envId`, `itemCount`, `streaming` |
| `batch_queue.items_enqueued` | Number of individual batch items enqueued | `envId` |
| `batch_queue.items_processed` | Number of batch items successfully processed (turned into runs) | `envId` |
| `batch_queue.items_failed` | Number of batch items that failed processing | `envId`, `errorCode` |
| `batch_queue.batches_completed` | Number of batches that completed (all items processed) | `envId`, `hasFailures` |

### Histograms

| Metric | Description | Unit | Labels |
|--------|-------------|------|--------|
| `batch_queue.batch_processing_duration` | Time from batch creation to completion | ms | `envId`, `itemCount` |
| `batch_queue.item_queue_time` | Time from item enqueue to processing start | ms | `envId` |

---

## FairQueue Metrics (batch-queue namespace)

These metrics track the underlying message queue operations. With the batch queue configuration, they are prefixed with `batch-queue.`.

### Counters

| Metric | Description |
|--------|-------------|
| `batch-queue.messages.enqueued` | Number of messages (batch items) added to the queue |
| `batch-queue.messages.completed` | Number of messages successfully processed |
| `batch-queue.messages.failed` | Number of messages that failed processing |
| `batch-queue.messages.retried` | Number of message retry attempts |
| `batch-queue.messages.dlq` | Number of messages sent to dead letter queue |

### Histograms

| Metric | Description | Unit |
|--------|-------------|------|
| `batch-queue.message.processing_time` | Time to process a single message | ms |
| `batch-queue.message.queue_time` | Time a message spent waiting in queue | ms |

### Observable Gauges

| Metric | Description | Labels |
|--------|-------------|--------|
| `batch-queue.queue.length` | Current number of messages in a queue | `fairqueue.queue_id` |
| `batch-queue.master_queue.length` | Number of active queues in the master queue shard | `fairqueue.shard_id` |
| `batch-queue.inflight.count` | Number of messages currently being processed | `fairqueue.shard_id` |
| `batch-queue.dlq.length` | Number of messages in the dead letter queue | `fairqueue.tenant_id` |

---

## Key Relationships

Understanding how metrics relate helps diagnose issues:

```
batches_enqueued × avg_items_per_batch ≈ items_enqueued
items_enqueued = items_processed + items_failed + items_pending
batches_completed ≤ batches_enqueued (lag indicates processing backlog)
```

---

## Degraded State Indicators

### 🔴 Critical Issues

#### 1. Processing Stopped
**Symptoms:**
- `batch_queue.items_processed` rate drops to 0
- `batch-queue.inflight.count` is 0
- `batch-queue.master_queue.length` is growing

**Likely Causes:**
- Consumer loops crashed
- Redis connection issues
- All consumers blocked by concurrency limits

**Actions:**
- Check webapp logs for "BatchQueue consumers started" message
- Verify Redis connectivity
- Check for "Unknown concurrency group" errors

#### 2. Items Stuck in Queue
**Symptoms:**
- `batch_queue.item_queue_time` p99 > 60 seconds
- `batch-queue.queue.length` growing continuously
- `batch-queue.inflight.count` at max capacity

**Likely Causes:**
- Processing is slower than ingestion
- Concurrency limits too restrictive
- Global rate limiter bottleneck

**Actions:**
- Increase `BATCH_QUEUE_CONSUMER_COUNT`
- Review concurrency limits per environment
- Check `BATCH_QUEUE_GLOBAL_RATE_LIMIT` setting

#### 3. High Failure Rate
**Symptoms:**
- `batch_queue.items_failed` rate > 5% of `items_processed`
- `batch-queue.messages.dlq` increasing

**Likely Causes:**
- TriggerTaskService errors
- Invalid task identifiers
- Downstream service issues

**Actions:**
- Check `errorCode` label distribution on `items_failed`
- Review batch error records in database
- Check TriggerTaskService logs

### 🟡 Warning Signs

#### 4. Growing Backlog
**Symptoms:**
- `batch_queue.batches_enqueued` - `batch_queue.batches_completed` is increasing over time
- `batch-queue.master_queue.length` trending upward

**Likely Causes:**
- Sustained high load
- Processing capacity insufficient
- Specific tenants monopolizing resources

**Actions:**
- Monitor DRR deficit distribution across tenants
- Consider scaling consumers
- Review per-tenant concurrency settings

#### 5. Uneven Tenant Processing
**Symptoms:**
- Some `envId` labels show much higher `item_queue_time` than others
- DRR logs show "tenants blocked by concurrency" frequently

**Likely Causes:**
- Concurrency limits too low for high-volume tenants
- DRR quantum/maxDeficit misconfigured

**Actions:**
- Review `BATCH_CONCURRENCY_*` environment settings
- Adjust DRR parameters if needed

#### 6. Rate Limit Impact
**Symptoms:**
- `batch_queue.item_queue_time` has periodic spikes
- Logs show "Global rate limit reached, waiting"

**Likely Causes:**
- `BATCH_QUEUE_GLOBAL_RATE_LIMIT` is set too low

**Actions:**
- Increase global rate limit if system can handle more throughput
- Or accept as intentional throttling

---

## Recommended Dashboards

### Processing Health
```
# Throughput
rate(batch_queue_items_processed_total[5m])
rate(batch_queue_items_failed_total[5m])

# Success Rate
rate(batch_queue_items_processed_total[5m]) / 
  (rate(batch_queue_items_processed_total[5m]) + rate(batch_queue_items_failed_total[5m]))

# Batch Completion Rate
rate(batch_queue_batches_completed_total[5m]) / rate(batch_queue_batches_enqueued_total[5m])
```

### Latency
```
# Item Queue Time (p50, p95, p99)
histogram_quantile(0.50, rate(batch_queue_item_queue_time_bucket[5m]))
histogram_quantile(0.95, rate(batch_queue_item_queue_time_bucket[5m]))
histogram_quantile(0.99, rate(batch_queue_item_queue_time_bucket[5m]))

# Batch Processing Duration
histogram_quantile(0.95, rate(batch_queue_batch_processing_duration_bucket[5m]))
```

### Queue Depth
```
# Current backlog
batch_queue_master_queue_length
batch_queue_inflight_count

# DLQ (should be 0)
batch_queue_dlq_length
```

---

## Alert Thresholds (Suggested)

| Condition | Severity | Threshold |
|-----------|----------|-----------|
| Processing stopped | Critical | `items_processed` rate = 0 for 5min |
| High failure rate | Warning | `items_failed` / `items_processed` > 0.05 |
| Queue time p99 | Warning | > 30 seconds |
| Queue time p99 | Critical | > 120 seconds |
| DLQ length | Warning | > 0 |
| Batch completion lag | Warning | `batches_enqueued - batches_completed` > 100 |

---

## Environment Variables Affecting Metrics

| Variable | Impact |
|----------|--------|
| `BATCH_QUEUE_CONSUMER_COUNT` | More consumers = higher throughput, lower queue time |
| `BATCH_QUEUE_CONSUMER_INTERVAL_MS` | Lower = more frequent polling, higher throughput |
| `BATCH_QUEUE_GLOBAL_RATE_LIMIT` | Caps max items/sec, increases queue time if too low |
| `BATCH_CONCURRENCY_FREE/PAID/ENTERPRISE` | Per-tenant concurrency limits |
| `BATCH_QUEUE_DRR_QUANTUM` | Credits per tenant per round (fairness tuning) |
| `BATCH_QUEUE_MAX_DEFICIT` | Max accumulated credits (prevents starvation) |

---

## Debugging Checklist

When investigating batch queue issues:

1. **Check consumer status**: Look for "BatchQueue consumers started" in logs
2. **Check Redis**: Verify connection and inspect keys with prefix `engine:batch-queue:`
3. **Check concurrency**: Look for "tenants blocked by concurrency" debug logs
4. **Check rate limits**: Look for "Global rate limit reached" debug logs
5. **Check DRR state**: Query `batch:drr:deficit` hash in Redis
6. **Check batch status**: Query `BatchTaskRun` table for stuck `PROCESSING` batches

