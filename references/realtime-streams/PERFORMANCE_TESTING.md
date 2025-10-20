# Performance Testing & Latency Monitoring

## Overview

The performance testing scenario measures real-time streaming latency by sending JSON chunks with timestamps and calculating the time difference between when data is sent from the task and when it's received in the browser.

## How It Works

### 1. Performance Scenario

- Sends **500 chunks** by default (configurable)
- Each chunk sent every **50ms** (configurable)
- Each chunk contains:
  - `timestamp`: When the chunk was sent from the task (milliseconds since epoch)
  - `chunkIndex`: Sequential index (0-499)
  - `data`: Human-readable chunk description

### 2. Latency Calculation

```
Latency = Time Received (browser) - Time Sent (task)
```

This measures:

- Network transit time
- Server processing time
- Any buffering/queueing delays
- Browser processing time

### 3. Performance Page (`/performance/[runId]`)

Displays comprehensive latency metrics:

#### Key Metrics

- **Chunks Received**: Total count of chunks processed
- **Average Latency**: Mean latency across all chunks
- **P50 (Median)**: 50th percentile - half of chunks are faster
- **P95**: 95th percentile - only 5% of chunks are slower
- **P99**: 99th percentile - only 1% of chunks are slower
- **Time to First Chunk**: How long until first data arrives
- **Min/Max Latency**: Best and worst case latencies

#### Visualizations

**1. Latency Over Time Chart**

- Bar chart showing last 50 chunks
- Color-coded by performance:
  - 🟢 Green: Below median (good)
  - 🟡 Yellow: Between median and P95 (normal)
  - 🔴 Red: Above P95 (slow)
- Bar width represents latency magnitude

**2. Recent Chunks Table**

- Last 10 chunks in reverse chronological order
- Shows index, data, latency, and timestamp
- Color-coded badges for quick assessment

## Testing Scenarios

### Basic Latency Test

1. Click "📊 Performance Test" button
2. Watch metrics update in real-time
3. Observe average latency (typically 50-200ms for local dev)

### Network Quality Test

1. Start performance test
2. Throttle network in DevTools (Fast 3G, Slow 3G)
3. Watch latency increase
4. Return to normal - latency should recover

### Refresh/Reconnection Test

1. Start performance test
2. Wait for 100+ chunks
3. Refresh the page
4. Stream should resume from where it left off
5. Latency should remain consistent

### Long-Running Stability Test

1. Increase chunk count to 1000+
2. Reduce interval to 20ms for faster completion
3. Monitor for latency drift over time
4. Check P95/P99 for outliers

## Expected Performance

### Local Development

- **Average Latency**: 50-150ms
- **P95**: 100-250ms
- **Time to First Chunk**: 500-2000ms

### Production (Cloud)

- **Average Latency**: 100-300ms
- **P95**: 200-500ms
- **Time to First Chunk**: 1000-3000ms

## Customizing the Test

Modify the trigger in `src/app/actions.ts` or `src/app/page.tsx`:

```typescript
await tasks.trigger<typeof streamsTask>("streams", {
  scenario: "performance",
  chunkCount: 1000, // Number of chunks
  chunkIntervalMs: 20, // Milliseconds between chunks
});
```

## Interpreting Results

### Good Performance

- Average < 200ms
- P95 < 400ms
- Consistent latencies (low variance)
- Time to first chunk < 2000ms

### Issues to Investigate

- **High P95/P99**: Indicates periodic slowdowns (network congestion, GC pauses)
- **Increasing latency over time**: Possible queueing or buffering issues
- **High time to first chunk**: Connection establishment delays
- **Huge variance**: Unstable network or overloaded server

## What This Tests

✅ **Does Test:**

- End-to-end latency (task → browser)
- Stream reconnection with latency continuity
- Real-time data flow performance
- Browser processing speed
- Network conditions impact

❌ **Does Not Test:**

- Server-side processing time (needs separate instrumentation)
- Database query performance
- Task execution speed
- Memory usage
- Throughput limits

## Use Cases

1. **Baseline Performance**: Establish expected latency for your infrastructure
2. **Network Testing**: Test different network conditions (WiFi, cellular, VPN)
3. **Geographic Testing**: Compare latency from different regions
4. **Load Testing**: Run multiple concurrent streams
5. **Regression Testing**: Detect performance degradation over time
6. **Infrastructure Changes**: Compare before/after latency when changing hosting/config
