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

### 9.6 — Large Payloads >512KB Return 0 Runs (Silent Partial Failure)

**Status**: NOT A BUG IN OUR CODE — infrastructure issue in dev
**Priority**: MEDIUM — only in dev without object store configured
**Found during**: E2E testing (2026-03-01)

**Root cause**: `TriggerTaskService` detects payload >512KB and tries to offload to S3/R2 object store. In local dev, object store credentials are not set → throws `ServiceValidationError: "Failed to upload large payload to object store"`. Our `PublishEventService` catches this per-subscriber (partial failure pattern) and continues, resulting in 0 runs.

**This is NOT specific to events** — a regular `tasks.trigger()` with >512KB payload would fail the same way without object store.

**Test results**:
- 500KB payload: 4 runs (OK — under threshold)
- 600KB payload: 0 runs (object store not configured)
- In production with object store: would work fine

**Improvement we could make**:
- Detect payload size BEFORE fan-out and return a clear error (413 Payload Too Large) instead of HTTP 200 with 0 runs
- Or: propagate the TriggerTaskService error instead of treating it as partial failure

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
