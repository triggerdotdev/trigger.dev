# RunsReplicationService Error Fingerprinting Benchmark

This benchmark measures the performance impact of error fingerprinting in the RunsReplicationService.

## Overview

The benchmark:
1. Creates a realistic dataset of TaskRuns (7% with errors by default)
2. Runs the producer in a **separate process** to simulate real-world load
3. Measures replication throughput and Event Loop Utilization (ELU)
4. Compares performance with fingerprinting **enabled** vs **disabled**

## Architecture

```
┌─────────────────┐         ┌──────────────────────┐
│  Producer       │         │  Benchmark Test      │
│  (Child Process)│─────────│  (Main Process)      │
│                 │  IPC    │                      │
│  - Inserts      │         │  - RunsReplication   │
│    TaskRuns     │         │    Service           │
│    to Postgres  │         │  - ELU Monitor       │
│                 │         │  - Metrics           │
└─────────────────┘         └──────────────────────┘
         │                           │
         │                           │
         ▼                           ▼
    ┌──────────┐              ┌──────────────┐
    │ Postgres │              │  ClickHouse  │
    └──────────┘              └──────────────┘
```

## Files

- `runsReplicationBenchmark.test.ts` - Main benchmark test
- `runsReplicationBenchmark.producer.ts` - Producer script (runs in child process)
- `runsReplicationBenchmark.README.md` - This file

## Configuration

The benchmark can be configured via environment variables or by editing `BENCHMARK_CONFIG` in the test file:

```typescript
const BENCHMARK_CONFIG = {
  // Number of runs to create
  NUM_RUNS: parseInt(process.env.BENCHMARK_NUM_RUNS || "5000", 10),

  // Error rate (0.07 = 7%)
  ERROR_RATE: 0.07,

  // Producer batch size
  PRODUCER_BATCH_SIZE: 100,

  // Replication service settings
  FLUSH_BATCH_SIZE: 50,
  FLUSH_INTERVAL_MS: 100,
  MAX_FLUSH_CONCURRENCY: 4,

  // Timeout
  REPLICATION_TIMEOUT_MS: 120_000, // 2 minutes
};
```

## Running the Benchmark

### Quick Test (Small Dataset)

```bash
cd apps/webapp
BENCHMARK_NUM_RUNS=1000 pnpm run test ./test/runsReplicationBenchmark.test.ts --run
```

### Realistic Benchmark (Larger Dataset)

```bash
cd apps/webapp
BENCHMARK_NUM_RUNS=10000 pnpm run test ./test/runsReplicationBenchmark.test.ts --run
```

### High Volume Benchmark

```bash
cd apps/webapp
BENCHMARK_NUM_RUNS=50000 pnpm run test ./test/runsReplicationBenchmark.test.ts --run
```

**Note:** The test is marked with `.skip` by default. To run it, remove the `.skip` from the test:

```typescript
// Change this:
containerTest.skip("should benchmark...", async () => {

// To this:
containerTest("should benchmark...", async () => {
```

## What Gets Measured

### 1. Producer Metrics
- Total runs created
- Runs with errors (should be ~7%)
- Duration
- Throughput (runs/sec)

### 2. Replication Metrics
- Total runs replicated to ClickHouse
- Replication duration
- Replication throughput (runs/sec)

### 3. Event Loop Utilization (ELU)
- Mean utilization (%)
- P50 (median) utilization (%)
- P95 utilization (%)
- P99 utilization (%)
- All samples for detailed analysis

### 4. OpenTelemetry Metrics
- Batches flushed
- Task runs inserted
- Payloads inserted
- Events processed

## Output

The benchmark produces detailed output including:

```
================================================================================
BENCHMARK: baseline-no-fingerprinting
Error Fingerprinting: DISABLED
Runs: 5000, Error Rate: 7.0%
================================================================================

[Producer] Starting - will create 5000 runs (7.0% with errors)
[Producer] Progress: 1000/5000 runs (2500 runs/sec)
...
[Producer] Completed:
  - Total runs: 5000
  - With errors: 352 (7.0%)
  - Duration: 2145ms
  - Throughput: 2331 runs/sec

[Benchmark] Waiting for replication to complete...

================================================================================
RESULTS: baseline-no-fingerprinting
================================================================================

Producer:
  Created: 5000 runs
  With errors: 352 (7.0%)
  Duration: 2145ms
  Throughput: 2331 runs/sec

Replication:
  Replicated: 5000 runs
  Duration: 3456ms
  Throughput: 1447 runs/sec

Event Loop Utilization:
  Mean: 23.45%
  P50: 22.10%
  P95: 34.20%
  P99: 41.30%
  Samples: 346

Metrics:
  Batches flushed: 102
  Task runs inserted: 5000
  Payloads inserted: 5000
  Events processed: 5000
================================================================================

[... Similar output for "with-fingerprinting" benchmark ...]

================================================================================
COMPARISON
Baseline: baseline-no-fingerprinting (fingerprinting OFF)
Comparison: with-fingerprinting (fingerprinting ON)
================================================================================

Replication Duration:
  3456ms → 3512ms (+1.62%)

Throughput:
  1447 → 1424 runs/sec (-1.59%)

Event Loop Utilization (Mean):
  23.45% → 24.12% (+2.86%)

Event Loop Utilization (P99):
  41.30% → 43.20% (+4.60%)

================================================================================

BENCHMARK COMPLETE
Fingerprinting impact on replication duration: +1.62%
Fingerprinting impact on throughput: -1.59%
Fingerprinting impact on ELU (mean): +2.86%
Fingerprinting impact on ELU (P99): +4.60%
```

## Interpreting Results

### What to Look For

1. **Replication Duration Delta** - How much longer replication takes with fingerprinting
2. **Throughput Delta** - Change in runs processed per second
3. **ELU Delta** - Change in event loop utilization (higher = more CPU bound)

### Expected Results

With a 7% error rate and SHA-256 hashing:
- **Small impact** (<5% overhead): Fingerprinting is well optimized
- **Moderate impact** (5-15% overhead): May want to consider optimizations
- **Large impact** (>15% overhead): Fingerprinting needs optimization

### Performance Optimization Ideas

If the benchmark shows significant overhead, consider:

1. **Faster hashing algorithm** - Replace SHA-256 with xxHash or MurmurHash3
2. **Worker threads** - Move fingerprinting to worker threads
3. **Caching** - Cache fingerprints for identical errors
4. **Lazy computation** - Only compute fingerprints when needed
5. **Batch processing** - Group similar errors before hashing

## Dataset Characteristics

The producer generates realistic error variety:

- TypeError (undefined property access)
- Error (API fetch failures)
- ValidationError (input validation)
- TimeoutError (operation timeouts)
- DatabaseError (connection failures)
- ReferenceError (undefined variables)

Each error template includes:
- Realistic stack traces
- Variable IDs and timestamps
- Line/column numbers
- File paths

This ensures the fingerprinting algorithm is tested with realistic data.

## Troubleshooting

### Benchmark Times Out

Increase the timeout:
```typescript
REPLICATION_TIMEOUT_MS: 300_000, // 5 minutes
```

### Producer Fails

Check Postgres connection and ensure:
- Docker services are running (`pnpm run docker`)
- Database is accessible
- Sufficient disk space

### Different Results Each Run

This is normal! Factors affecting variance:
- System load
- Docker container overhead
- Database I/O
- Network latency (even localhost)

Run multiple times and look at trends.

## Future Enhancements

Potential improvements to the benchmark:

1. **Multiple error rates** - Test 0%, 5%, 10%, 25%, 50% error rates
2. **Different hash algorithms** - Compare SHA-256 vs xxHash vs MurmurHash3
3. **Worker thread comparison** - Test main thread vs worker threads
4. **Concurrent producers** - Multiple producer processes
5. **Memory profiling** - Track memory usage over time
6. **Flame graphs** - Generate CPU flame graphs for analysis
7. **Historical tracking** - Store results over time to track regressions
