# Pub/Sub Event System — Pending Items

## Phase 9: Production Hardening

Items identified during post-implementation audit. Ordered by priority.

### 9.1 — Redis-backed Rate Limiter (swap InMemory for Redis)

**Status**: NOT STARTED
**Complexity**: LOW — interface already exists, just need new implementation
**Why**: InMemory limiter doesn't survive restarts and doesn't work multi-instance

The codebase already has proven rate limiting patterns:
- `apps/webapp/app/services/rateLimiter.server.ts` — Upstash `@upstash/ratelimit` wrapper (sliding window, token bucket, fixed window)
- `apps/webapp/app/v3/GCRARateLimiter.server.ts` — Custom GCRA with Redis Lua scripts (used for alerts)
- Both use dedicated Redis connection (`RATE_LIMIT_REDIS_HOST` env vars)

**Implementation plan**:
1. Create `RedisEventRateLimitChecker` implementing `EventRateLimitChecker` interface
2. Use existing `RateLimiter` wrapper from `rateLimiter.server.ts` with `Ratelimit.slidingWindow()`
3. Key format already defined: `{projectId}:{eventSlug}`
4. Swap singleton in `eventRateLimiterGlobal.server.ts`
5. Keep `InMemoryEventRateLimitChecker` for tests

**Key files**:
- Interface: `apps/webapp/app/v3/services/events/eventRateLimiter.server.ts`
- Singleton: `apps/webapp/app/v3/services/events/eventRateLimiterGlobal.server.ts`
- Reference: `apps/webapp/app/services/rateLimiter.server.ts`
- Reference: `apps/webapp/app/services/mfa/mfaRateLimiter.server.ts` (good example of production usage)

### 9.2 — Consumer Group Improvement

**Status**: NOT STARTED
**Complexity**: MEDIUM — needs design decision
**Why**: Current round-robin by timestamp is too simplistic for production

Options:
1. **Redis-based round-robin counter** — atomic increment, true rotation across events
2. **Hash-based selection** — hash(eventId) % members for consistent routing per event
3. **Weighted selection** — respect task queue concurrency limits
4. Keep current for MVP, document as "basic" consumer groups

**Current implementation**: `PublishEventService.applyConsumerGroups()` in `publishEvent.server.ts`

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
