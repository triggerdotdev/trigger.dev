# Pub/Sub Event System — Pending Items

## Phase 9: Production Hardening

Items identified during post-implementation audit. Ordered by priority.

### 9.1 — Redis-backed Rate Limiter

**Status**: DONE (commit `81c09cda5`)
- Created `RedisEventRateLimitChecker` using `@upstash/ratelimit` sliding window
- Singleton auto-detects: uses Redis when `RATE_LIMIT_REDIS_HOST` is set, falls back to InMemory
- Caches `Ratelimit` instances per config (limit+window combo)
- Reuses existing `createRedisRateLimitClient` infrastructure

### 9.2 — Consumer Group Improvement

**Status**: DONE (commit `81c09cda5`)
- Replaced `Math.floor(Date.now() / 1000) % N` with FNV-1a hash of `eventId:groupName`
- Deterministic: same eventId always routes to the same group member
- Evenly distributed: different eventIds spread across members
- Consistent for retries/replays (same eventId = same routing)

### 9.3 — Verify Integration Tests

**Status**: DONE (2026-02-28)
- 24/24 integration tests PASS with Docker running
- 11/11 rate limiter unit tests PASS
- 470/470 core unit tests PASS

### 9.4 — Dashboard UI, CLI Commands, Reference Project, Documentation

**Status**: NOT STARTED (deferred from Phase 8)
**Complexity**: HIGH — significant amount of work
**Items from original roadmap**:
- Event list/detail views in webapp dashboard
- `trigger events list|publish|history|replay|dlq` CLI commands
- `references/event-system/` demo project
- SDK docs in `rules/` directory
- Update `.claude/skills/trigger-dev-tasks/SKILL.md`

### 9.5 — Ordering Key Does Not Guarantee Strict Ordering

**Status**: NOT RESOLVED — needs design decision
**Priority**: HIGH — correctness issue
**Found during**: E2E testing (2026-03-01)

**Problem**: `orderingKey` maps to Trigger.dev's `concurrencyKey`, which creates a **copy of the queue per key**, each with the same `concurrencyLimit`. This means:

- If task has `concurrencyLimit: 1` → ordering works per key, BUT the limit is per-key, not global. All different keys run in parallel with no global cap (only bounded by environment concurrency limit).
- If task has `concurrencyLimit: 10` → 10 events with the SAME key can run in parallel, breaking ordering.
- There's no way to express "strict ordering per key + global concurrency limit N" with Trigger.dev's current queue model.

**Expected behavior** (like Kafka/SQS FIFO):
- `orderingKey` = strict sequential per key (always 1 at a time per key)
- `concurrencyLimit` = total parallel runs across all keys (separate concept)

```
concurrencyLimit: 3, ordering keys A/B/C:

Slot 1: A1 → A2 → A3  (key A in order)
Slot 2: B1 → B2        (key B in order)
Slot 3: C1 → C2        (key C in order)
Max 3 running at once, each key strictly ordered.
```

**Trigger.dev's actual behavior with concurrencyKey**:
- Creates 3 separate queues (A, B, C), EACH with concurrencyLimit 3
- So 9 runs could execute simultaneously (3 per key × 3 keys)
- Not true ordering

**Options to resolve**:
1. Build ordering on top of Trigger.dev's queue system with custom logic in PublishEventService
2. Contribute ordering support upstream to Trigger.dev's run engine
3. Document as limitation and recommend `concurrencyLimit: 1` for ordering use cases
4. Use a separate ordering mechanism (Redis-based FIFO per key) before triggering runs

**Test results that confirmed this**:
- `concurrencyLimit: 1` + same key → sequential (correct)
- `concurrencyLimit: 1` + different keys → parallel (capped by env limit ~8, not by concurrencyLimit)
- `concurrencyLimit: 2` + same key → 2 at a time (breaks ordering)
- 10 different keys + `concurrencyLimit: 1` → only ~8 ran in parallel (env limit, not queue limit)

### 9.6 — Large Payloads Cause Silent Fan-out Failure

**Status**: NOT RESOLVED — needs fix
**Priority**: HIGH — data loss / silent failure
**Found during**: E2E testing (2026-03-01)

**Problem**: Payloads >512KB cause `PublishEventService` to return `runs: []` (HTTP 200, no error) because Trigger.dev's task trigger silently fails for large payloads (>512KB need object storage offloading which our event publish path doesn't handle).

**Test results**:
- 100KB payload: 4 runs (OK)
- 500KB payload: 4 runs (OK)
- 600KB payload: 0 runs (SILENT FAILURE)
- 2MB payload: 0 runs (SILENT FAILURE)

**The trigger call fails silently** — `TriggerTaskService` returns `undefined` for each subscriber, and `PublishEventService` logs it as a partial failure but still returns HTTP 200 with empty runs.

**Options to resolve**:
1. Validate payload size in PublishEventService before fan-out (reject >512KB with clear error)
2. Use Trigger.dev's payload offloading mechanism (payloads >512KB go to object storage)
3. Both: warn on large payloads + support offloading

### 9.7 — ClickHouse Tables Not Created in Dev

**Status**: KNOWN LIMITATION
**Priority**: LOW — only affects stats/history/replay in local dev

**Problem**: ClickHouse migrations (`021_event_log_v1.sql`, `022_event_counts_mv_v1.sql`) are not automatically applied in local dev. This causes:
- `GET /api/v1/events/:id/stats` → 500 "Failed to query event stats"
- `GET /api/v1/events/:id/history` → 500 "Failed to query event history"
- `POST /api/v1/events/:id/replay` → 500 "Failed to query events for replay"

The event log writer (fire-and-forget) also fails silently:
```
Table trigger_dev.event_log_v1 does not exist.
```

**Resolution**: Apply ClickHouse migrations in local dev, or improve error messages to indicate ClickHouse is not configured.

### 9.8 — Consumer-side Rate Limiting + Backpressure Monitor

**Status**: NOT STARTED (deferred from Phase 7)
**Complexity**: MEDIUM
**Items from original roadmap**:
- Per-consumer rate limit on task subscription
- `backpressureMonitor.server.ts` — lag detection, metrics
- `GET /api/v1/events/:eventId/metrics` endpoint
