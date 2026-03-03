# Pub/Sub Event System — Audit Fix Plan

Findings from 5-agent parallel audit (2026-03-03). Organized by priority.
Follow [Implementation Process & Guidelines](pubsub-roadmap.md#implementation-process--guidelines) for each phase.

---

## Phase 10: Audit Fixes — CRITICAL + HIGH

### 10.1 — Fix `expireTtlRuns` Lua: global concurrency slot leak (CRITICAL)

**Found by**: Redis auditor
**Severity**: CRITICAL — permanent slot leak
**File**: `internal-packages/run-engine/src/run-queue/index.ts:2633-2726`

**Problem**: The `expireTtlRuns` Lua script removes from `queueCurrentConcurrency`, `queueCurrentDequeued`, `envCurrentConcurrency`, `envCurrentDequeued` but does NOT remove from `globalCurrentConcurrency`. When a run with an ordering key expires via TTL, the global concurrency slot is permanently leaked, eventually starving the entire queue.

**Fix**:
1. Add `globalCurrentConcurrencyKey` as a new KEYS parameter to the `expireTtlRuns` Lua
2. Add `redis.call('SREM', globalCurrentConcurrencyKey, messageId)` alongside existing SREMs
3. Update `numberOfKeys`, type declaration, and caller to pass the key
4. Update the caller that invokes `expireTtlRuns` to compute and pass `queueGlobalCurrentConcurrencyKeyFromQueue`

**Verify**: Run existing run-engine TTL tests

### 10.2 — Fix `clearMessageFromConcurrencySets` bare queue name (HIGH)

**Found by**: Redis auditor
**Severity**: HIGH — SREM to wrong key, slot never released
**File**: `internal-packages/run-engine/src/engine/index.ts:2240-2243`

**Problem**: `clearMessageFromConcurrencySets` is called with `taskRun.queue` which is a bare queue name (e.g. `"my-task"`), not a full Redis key. `queueGlobalCurrentConcurrencyKeyFromQueue()` expects a full key like `{org:X}:proj:Y:env:Z:queue:my-task` and produces a nonsense key from a bare name.

**Fix**: Trace how other callers of similar methods get the full queue key (likely from the `message.queue` field which includes the full path). Ensure `clearMessageFromConcurrencySets` either:
- Receives the full queue key, or
- Has access to the env/org/project context to construct it

**Verify**: Check that the same issue exists for the existing per-key `queueCurrentConcurrencyKeyFromQueue` call (it probably does but SREM on a wrong key is a no-op, not a crash).

### 10.3 — Add `.max()` to batch publish items array (HIGH)

**Found by**: Security auditor
**Severity**: HIGH — potential DoS
**File**: `packages/core/src/v3/schemas/api.ts` — `BatchPublishEventRequestBody`

**Fix**: Add `.max(100)` (or similar) to the `items` array in `BatchPublishEventRequestBody`. Matches the pattern of existing batch trigger which has limits.

### 10.4 — Fix publishAndWait schema: parentRunId required but options optional (HIGH)

**Found by**: API auditor
**Severity**: HIGH — schema mismatch causes runtime 400 instead of Zod validation error
**File**: `packages/core/src/v3/schemas/api.ts:1658-1671`

**Fix**: Either:
- Make `options` required in `PublishAndWaitEventRequestBody`, or
- Move `parentRunId` to be a top-level required field outside of `options`

### 10.5 — Fix ClickHouse interval string interpolation (HIGH)

**Found by**: Security auditor
**Severity**: HIGH — fragile pattern
**File**: `apps/webapp/app/routes/api.v1.events.$eventId.stats.ts:54`

**Fix**: Use parameterized query or keep the whitelist validation but use a safer pattern (map from allowed period to interval string rather than interpolating user input).

### 10.6 — Add missing index for pattern subscription query (HIGH)

**Found by**: DB auditor
**Severity**: HIGH — full table scan on every publish
**File**: `internal-packages/database/prisma/schema.prisma` — `EventSubscription`

**Fix**:
1. Add `@@index([projectId, environmentId, enabled])` to EventSubscription model
2. Create migration with `CREATE INDEX CONCURRENTLY` in its own file
3. Run `pnpm run db:migrate:deploy && pnpm run generate`

### 10.7 — Fix batch publish partial failure semantics (HIGH)

**Found by**: API auditor
**Severity**: HIGH — client can't determine which items succeeded
**File**: `apps/webapp/app/routes/api.v1.events.$eventId.batchPublish.ts:40-57`

**Fix**: Two options:
- **Option A**: Validate ALL items upfront before triggering any (current approach fails mid-batch)
- **Option B**: Return partial results with per-item status (more complex but more resilient)

Recommend Option A — validate schema + rate limits for all items first, then trigger.

---

## Phase 11: Audit Fixes — MEDIUM

### 11.1 — Fix N+1 in DLQ retryAll

**File**: `apps/webapp/app/v3/services/events/deadLetterManagement.server.ts:126-148`
**Fix**: Remove redundant re-fetch in `retry()` when called from `retryAll()`, or batch the operations.

### 11.2 — Add payload size check before fan-out

**File**: `apps/webapp/app/v3/services/events/publishEvent.server.ts`
**Fix**: Check payload byte size before triggering subscribers. Return 413 if over limit and object store is not configured.

### 11.3 — Fix inconsistent error handling in routes

**Files**: `api.v1.events.dlq.retry-all.ts`, `api.v1.events.ts`
**Fix**: Add try/catch with ServiceValidationError handling, matching other routes.

### 11.4 — Add CLI publish options support

**File**: `packages/cli-v3/src/commands/events/publish.ts`
**Fix**: Add `--delay`, `--tags`, `--idempotency-key`, `--ordering-key` options.

### 11.5 — Fix schema validation silent pass on compilation error

**File**: `apps/webapp/app/v3/services/events/schemaRegistry.server.ts:198-201`
**Fix**: Log a warning when ajv compilation fails, and optionally reject the publish.

### 11.6 — Add stale subscription cleanup

**File**: `apps/webapp/app/v3/services/events/publishEvent.server.ts`
**Fix**: When a subscriber trigger fails consistently, log a warning and optionally disable the subscription after N consecutive failures.

### 11.7 — Add data cleanup mechanism

**Fix**: Add a periodic cleanup job (or TTL-based approach) for:
- Disabled EventSubscriptions older than 30 days
- Processed DeadLetterEvents (RETRIED/DISCARDED) older than 30 days
- Deprecated EventDefinitions with no active subscriptions

---

## Phase 12: Test Coverage

### 12.1 — Tests for ReplayEventsService

**File**: `apps/webapp/test/engine/replayEvents.test.ts` (new)
**Tests**:
- Replay with date range filter
- Replay with task filter
- Replay dry run (count only)
- Replay with idempotency (no duplicate triggers)
- Replay when ClickHouse is unavailable (graceful error)

Note: These require ClickHouse in testcontainers or mocking.

### 12.2 — Tests for DeadLetterService

**File**: `apps/webapp/test/engine/deadLetterService.test.ts` (new)
**Tests**:
- Failed event-triggered run creates DLQ entry
- Non-event run does NOT create DLQ entry
- DLQ entry has correct eventType, payload, error
- Multiple failures create separate DLQ entries

### 12.3 — Tests for DeadLetterManagementService

**File**: `apps/webapp/test/engine/deadLetterManagement.test.ts` (new)
**Tests**:
- List DLQ entries with pagination
- List with eventType filter
- List with status filter
- Retry creates new run with correct payload
- Retry marks DLQ entry as RETRIED
- Discard marks entry as DISCARDED
- RetryAll processes up to 1000 items
- Retry/discard nonexistent ID returns error

### 12.4 — Tests for RedisEventRateLimitChecker

**File**: `apps/webapp/test/engine/eventRateLimiter.test.ts` (extend)
**Tests**:
- Redis checker allows under limit
- Redis checker blocks over limit
- Redis checker returns correct remaining/retryAfter
- Different configs get separate Ratelimit instances

Note: Requires Redis in testcontainers.

### 12.5 — Tests for SchemaRegistryService.checkCompatibility

**File**: extend existing SchemaRegistryService tests
**Tests**:
- Compatible schema change (add optional field)
- Incompatible change (remove required field)
- Incompatible change (change field type)

---

## Phase 13: LOW Priority Fixes

### 13.1 — Add LRU bounds to caches
- `validatorCache` in SchemaRegistryService: max 1000 entries
- `patternCache`/`filterCache` in core evaluators: max 1000 entries
- `InMemoryEventRateLimitChecker.windows`: evict entries older than 2x window

### 13.2 — Tighten Zod schemas
- `payload: z.any()` → `payload: z.unknown()`
- `metadata: z.any()` → `metadata: z.record(z.unknown())`
- Add `.max(256)` to idempotencyKey
- Add DLQ status validation with Zod instead of `as` cast

### 13.3 — Remove dead code
- Unused `compileFilter`/`evaluateFilter` exports from core filterEvaluator

### 13.4 — Fix batchPublish URL naming
- Current: `/api/v1/events/:id/batchPublish` (camelCase)
- Consider: `/api/v1/events/:id/batch-publish` or keep for consistency

---

## Execution Order

```
Phase 10 (CRITICAL+HIGH) → Phase 12 (Tests) → Phase 11 (MEDIUM) → Phase 13 (LOW)
```

Phase 10 first because it contains a CRITICAL bug (permanent slot leak).
Phase 12 second because tests validate the fixes and catch regressions.
Phase 11 and 13 are improvements, not blockers.

## Verification per phase

Same as roadmap guidelines:
1. `pnpm run build --filter @internal/run-engine --filter webapp --filter @trigger.dev/core --filter @trigger.dev/sdk`
2. `cd internal-packages/run-engine && pnpm run test --run` (run-engine: 236+ must pass)
3. `cd apps/webapp && pnpm run test ./test/engine/publishEvent.test.ts --run` (24+ must pass)
4. `cd apps/webapp && pnpm run test ./test/engine/eventRateLimiter.test.ts --run` (11+ must pass)
5. New test files must pass
6. Commit after each sub-step: `feat(events): phase X.Y — <description>`
