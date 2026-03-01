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

### 9.5 — Consumer-side Rate Limiting + Backpressure Monitor

**Status**: NOT STARTED (deferred from Phase 7)
**Complexity**: MEDIUM
**Items from original roadmap**:
- Per-consumer rate limit on task subscription
- `backpressureMonitor.server.ts` — lag detection, metrics
- `GET /api/v1/events/:eventId/metrics` endpoint
