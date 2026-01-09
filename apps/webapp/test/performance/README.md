# RunsReplicationService Performance Test Harness

A comprehensive test harness for profiling the `RunsReplicationService` to identify CPU and event loop bottlenecks during high-throughput replication from PostgreSQL to ClickHouse.

## Overview

This harness helps you:

- **Profile CPU usage** and identify hot code paths with Clinic.js flamegraphs
- **Measure event loop utilization** to find bottlenecks
- **Test at scale** from 1k to 20k+ records/second
- **Isolate bottlenecks** by testing with real or mocked ClickHouse
- **Track metrics** across multiple test phases

## Architecture

The harness uses a **multi-process architecture** to prevent CPU interference:

```
Main Orchestrator Process
├── Producer Process (writes to PostgreSQL)
│   └── Reports metrics via IPC
├── Consumer Process (RunsReplicationService)
│   └── Optional: Wrapped by Clinic.js for profiling
│   └── Reports metrics via IPC
└── Metrics Collector (aggregates data)
```

**Key Features:**

- Producer and consumer run in **separate Node.js processes**
- Real PostgreSQL writes trigger actual WAL-based logical replication
- Configurable ClickHouse mode: real writes or mocked (CPU-only profiling)
- Clinic.js integration for Doctor (event loop) and Flame (flamegraph) profiling
- Phase-based testing with detailed metrics per phase

## Quick Start

### 1. Configure Local Credentials

The harness uses `test/performance/.env.local` (git-ignored) for credentials:

```bash
# PostgreSQL (local instance)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres?schema=public

# Redis (local instance)
REDIS_URL=redis://localhost:6379

# ClickHouse Cloud
CLICKHOUSE_URL=https://your-instance.clickhouse.cloud:8443?username=default&password=YOUR_PASSWORD
```

**Note:** `.env.local` is automatically created with current credentials. Edit if you need to change them.

### 2. Basic CPU Profiling (Mock ClickHouse)

Profile at 10k records/sec with mocked ClickHouse to isolate CPU bottlenecks:

```bash
pnpm tsx scripts/profile-runs-replication.ts \
  --mock-clickhouse \
  --throughput 10000 \
  --duration 60 \
  --profile flame
```

### 3. Full Stack Profiling (Real ClickHouse)

Test the complete stack including real ClickHouse Cloud writes:

```bash
pnpm tsx scripts/profile-runs-replication.ts \
  --throughput 5000 \
  --duration 60
```

**Note:** The harness automatically runs ClickHouse migrations from `internal-packages/clickhouse/schema/` when using real ClickHouse.

### Multi-Phase Testing

Create a config file for complex test scenarios:

```json
{
  "phases": [
    { "name": "warmup", "durationSec": 30, "targetThroughput": 1000 },
    { "name": "baseline", "durationSec": 60, "targetThroughput": 5000 },
    { "name": "stress", "durationSec": 120, "targetThroughput": 10000 },
    { "name": "peak", "durationSec": 60, "targetThroughput": 15000 }
  ],
  "profiling": { "enabled": true, "tool": "flame" },
  "consumer": {
    "useMockClickhouse": true,
    "flushBatchSize": 50,
    "flushIntervalMs": 100,
    "maxFlushConcurrency": 100
  }
}
```

Run with config file:

```bash
pnpm tsx scripts/profile-runs-replication.ts --config config.json
```

## CLI Options

```
Usage: profile-runs-replication [options]

Options:
  -c, --config <file>     Config file path (JSON)
  -t, --throughput <num>  Target throughput (records/sec) (default: 5000)
  -d, --duration <num>    Test duration per phase (seconds) (default: 60)
  --mock-clickhouse       Use mock ClickHouse (CPU-only profiling)
  --profile <tool>        Profiling tool: doctor, flame, both, none (default: none)
  --output <dir>          Output directory (default: ./profiling-results)
  -v, --verbose           Verbose logging
  -h, --help              Display help
```

### Database Setup

The harness creates a **separate database** (`trigger_profiling`) on your local PostgreSQL server:

- ✅ Isolated from your main development database
- ✅ Schema copied from main database using `pg_dump`
- ✅ Preserved after tests for inspection
- ✅ Reuses existing org/project/environment records
- ⚠️ Requires local PostgreSQL with logical replication enabled (`wal_level = logical`)

To clean up: `DROP DATABASE trigger_profiling;`

## Configuration

### Test Phases

Define multiple test phases with different throughput targets:

```typescript
{
  "phases": [
    {
      "name": "warmup",
      "durationSec": 30,
      "targetThroughput": 1000
    },
    {
      "name": "sustained",
      "durationSec": 120,
      "targetThroughput": 10000
    }
  ]
}
```

### Producer Configuration

```typescript
{
  "producer": {
    "targetThroughput": 5000,     // records/sec
    "insertUpdateRatio": 0.8,     // 80% inserts, 20% updates
    "batchSize": 100,              // records per batch write
    "payloadSizeKB": 1             // average payload size
  }
}
```

### Consumer Configuration

```typescript
{
  "consumer": {
    "flushBatchSize": 50,          // batch size for ClickHouse writes
    "flushIntervalMs": 100,        // flush interval
    "maxFlushConcurrency": 100,    // concurrent flush operations
    "useMockClickhouse": false,    // true for CPU-only profiling
    "mockClickhouseDelay": 0       // simulated network delay (ms)
  }
}
```

### Profiling Configuration

```typescript
{
  "profiling": {
    "enabled": true,
    "tool": "flame",               // doctor, flame, both, none
    "outputDir": "./profiling-results"
  }
}
```

## Output and Metrics

### Metrics Collected

For each test phase:

- **Producer Metrics:**
  - Total inserts and updates
  - Actual throughput (records/sec)
  - Write latency (p50, p95, p99)
  - Error count

- **Consumer Metrics:**
  - Batches flushed
  - Records consumed
  - Consumer throughput
  - Replication lag (p50, p95, p99)
  - Event loop utilization
  - Heap memory usage

### Output Files

```
profiling-results/
└── 2026-01-09/
    ├── metrics.json              # Detailed metrics for all phases
    ├── .clinic-flame/            # Flamegraph (if enabled)
    │   └── index.html
    └── .clinic-doctor/           # Event loop analysis (if enabled)
        └── index.html
```

### Viewing Profiling Results

**Flamegraph (CPU hotspots):**
```bash
open profiling-results/2026-01-09/.clinic-flame/index.html
```

**Doctor (Event loop analysis):**
```bash
open profiling-results/2026-01-09/.clinic-doctor/index.html
```

## Common Use Cases

### 1. Identify CPU Bottlenecks

Use mocked ClickHouse to eliminate I/O overhead:

```bash
pnpm tsx scripts/profile-runs-replication.ts \
  --mock-clickhouse \
  --throughput 10000 \
  --profile flame
```

**What to look for in flamegraph:**
- Hot functions consuming most CPU time
- JSON parsing overhead
- LSN conversion operations
- Array sorting/merging operations

### 2. Measure Event Loop Saturation

Use Clinic.js Doctor to analyze event loop health:

```bash
pnpm tsx scripts/profile-runs-replication.ts \
  --mock-clickhouse \
  --throughput 15000 \
  --profile doctor
```

**What to look for in Doctor analysis:**
- Event loop delay spikes
- I/O vs CPU time breakdown
- Event loop utilization percentage

### 3. Compare Configuration Changes

Test different batch sizes to find optimal configuration:

```bash
# Test with batch size 50
pnpm tsx scripts/profile-runs-replication.ts \
  --throughput 8000 -d 60 --output ./results/batch-50

# Edit config and test with batch size 100
pnpm tsx scripts/profile-runs-replication.ts \
  --throughput 8000 -d 60 --output ./results/batch-100
```

### 4. Stress Test to Find Breaking Point

Incrementally increase throughput to find maximum capacity:

```json
{
  "phases": [
    { "name": "5k", "durationSec": 60, "targetThroughput": 5000 },
    { "name": "10k", "durationSec": 60, "targetThroughput": 10000 },
    { "name": "15k", "durationSec": 60, "targetThroughput": 15000 },
    { "name": "20k", "durationSec": 60, "targetThroughput": 20000 }
  ]
}
```

### 5. Compare I/O vs CPU Overhead

Run twice - once with real ClickHouse, once with mock:

```bash
# With mock (CPU-only)
pnpm tsx scripts/profile-runs-replication.ts \
  --mock-clickhouse --throughput 8000 -d 60 \
  --output ./results/cpu-only

# With real ClickHouse Cloud (requires CLICKHOUSE_URL in .env.local)
pnpm tsx scripts/profile-runs-replication.ts \
  --throughput 8000 -d 60 \
  --output ./results/full-stack
```

Compare event loop utilization to understand I/O impact.

## Prerequisites

### PostgreSQL Setup

Ensure your local PostgreSQL has logical replication enabled:

**1. Check your postgresql.conf:**
```ini
wal_level = logical
```

**2. Restart PostgreSQL if you changed the config:**
```bash
# macOS (Homebrew)
brew services restart postgresql

# Linux
sudo systemctl restart postgresql
```

**3. Verify .env.local is configured:**
The harness loads credentials from `test/performance/.env.local`:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres?schema=public
REDIS_URL=redis://localhost:6379
CLICKHOUSE_URL=https://your-instance.clickhouse.cloud:8443?username=default&password=YOUR_PASSWORD
```

**4. The harness will automatically:**
- Create `trigger_profiling` database (separate from main DB)
- Copy schema from main database using `pg_dump`
- Configure REPLICA IDENTITY FULL on TaskRun table
- Create replication slot (`profiling_slot`)
- Create publication (`profiling_publication`)
- Run ClickHouse migrations (when using real ClickHouse)
- Reuse or create test org/project/environment

## Troubleshooting

### Producer/Consumer Out of Sync

If consumer can't keep up with producer:

1. Increase `flushBatchSize` for better throughput
2. Increase `maxFlushConcurrency` if ClickHouse can handle it
3. Reduce `targetThroughput` to sustainable level

### Docker Container Startup Failures

Ensure Docker is running and has sufficient resources:

```bash
docker info  # Check Docker status
```

Increase Docker memory/CPU limits if needed.

### Process Not Exiting Cleanly

If processes hang during shutdown:

1. Check for unhandled promises
2. Ensure all intervals/timeouts are cleared
3. Force kill with Ctrl+C (process will be killed automatically after 30s)

### High Memory Usage

If heap usage grows excessively:

1. Reduce payload size: `payloadSizeKB: 0.5`
2. Reduce batch sizes
3. Check for memory leaks in flamegraph (repeated allocations)

## Architecture Details

### Producer Process

- Runs in isolated Node.js process
- Writes TaskRun records to PostgreSQL using Prisma
- Throttles to maintain exact target throughput
- Tracks insert/update latencies
- Reports metrics to orchestrator via IPC

### Consumer Process

- Runs in isolated Node.js process (optionally wrapped by Clinic.js)
- Executes RunsReplicationService
- Consumes PostgreSQL logical replication stream
- Writes to ClickHouse (real or mocked)
- Reports batch flush events and metrics via IPC

### Orchestrator Process

- Manages Docker containers (PostgreSQL, Redis, ClickHouse)
- Spawns producer and consumer processes
- Coordinates test phases
- Aggregates metrics
- Generates reports

## Next Steps

After running profiling:

1. **Analyze flamegraphs** to identify top CPU consumers
2. **Check event loop utilization** - target <80% for headroom
3. **Optimize identified bottlenecks** in the code
4. **Re-run harness** to validate improvements
5. **Document findings** and optimal configuration

## Examples from Plan

See `/Users/eric/.claude/plans/elegant-humming-moler.md` for the complete implementation plan and additional context.
