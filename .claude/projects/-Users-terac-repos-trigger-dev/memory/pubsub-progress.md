# Pub/Sub Event System — Progress

## Phase 0: Core Primitives + Basic Fan-out — COMPLETE
All sub-steps 0.1–0.9 implemented and committed. See git log for details.

## Phase 1: Schema Registry + Validation — COMPLETE

### What was done
1. **1.1** — Schema versioning DB + `SchemaRegistryService` (ajv@8, registerSchema, getSchema, listSchemas, validatePayload, checkCompatibility)
2. **1.2** — Discovery API: `GET /api/v1/events`, `GET /api/v1/events/:id`, `GET /api/v1/events/:id/schema` + API client methods
3. **1.3** — SDK stores raw schema → CLI converts to JSON Schema → DB stores → PublishEventService validates
4. **1.4** — 12 unit + 3 integration tests

### Commits
`e6249e407` → `49b2903d5` → `2a06ef605` → `cfa67d079`

## Phase 2: Smart Routing — COMPLETE

### What was done
1. **2.1** — Filter evaluator (reused `eventFilterMatches`) + pattern matcher (`*` and `#` wildcards) — 58 unit tests
2. **2.2** — Filters in SDK, stored in `EventSubscription.filter` during deploy
3. **2.3** — Filter evaluation during fan-out in `PublishEventService` — 3 integration tests
4. **2.4** — `events.match(pattern)` SDK helper, pattern subscriptions — 4 integration tests

### Commits
`cd426b366` → `be7ca08fb` → `676d37eb0` → `846438cf9`

## Phase 3: Event Persistence + Replay — COMPLETE

### What was done
1. **3.1** — ClickHouse `event_log_v1` + `event_counts_mv_v1` materialized view
2. **3.2** — `EventLogWriter` callback in `PublishEventService` (fire-and-forget)
3. **3.3** — `GET /api/v1/events/:eventId/history` (paginated, from ClickHouse)
4. **3.4** — `ReplayEventsService` + `POST /api/v1/events/:eventId/replay`

### Key decisions
- MergeTree engine (events immutable), EventLogWriter injectable, fire-and-forget writes
- No tests for 3.3/3.4 (require ClickHouse, testcontainers only has Postgres+Redis)

### Commits
`c63c1e781` → `8dfb002ee` → `02369b128` → `3d9863512`

## Phase 4: Dead Letter Queue — COMPLETE

### What was done
1. **4.1** — `DeadLetterEvent` model + `DeadLetterStatus` enum + migration
2. **4.2** — `$$event` metadata on triggered runs + `DeadLetterService` in `FinalizeTaskRunService`
3. **4.3** — `DeadLetterManagementService` + 4 API endpoints (list, retry, discard, retry-all)

### Key decisions
- `$$event` metadata prefix, hooked into `FinalizeTaskRunService`
- Phase 4.4 (SDK DLQ config per event) deferred

### Commits
`ec4139642` → `5ed48645e` → `89d0daba8`

## Phase 5: Ordering + Consumer Groups — COMPLETE

### What was done
1. **5.1** — `orderingKey` mapped to `concurrencyKey` on triggered runs
2. **5.2** — `consumerGroup` option, `applyConsumerGroups()` picks one per group
3. **5.3** — 3 integration tests

### Key decisions
- Ordering at publish time (dynamic per-payload)
- Consumer groups: `Math.floor(Date.now() / 1000) % members.length` (simplistic — see pending items)

### Commits
`dcd3ea3c1` → `8c033b3dd` → `3b3abf47a`

## Phase 6: Publish-and-Wait — COMPLETE

### What was done
1. **6.1** — `waitForEvent` in `SharedRuntimeManager` (resolvers, suspendable, lifecycle hooks)
2. **6.2** — `POST /api/v1/events/:eventId/publishAndWait` endpoint + API client method
3. **6.3** — SDK `publishAndWait()` method (validates, calls API with `parentRunId`, waits via `runtime.waitForEvent()`)
4. **6.tests** — 3 integration tests (waitpoints, no-subscribers, event log writer)

### Key decisions
- Leverages existing waitpoint system (`parentRunId` + `resumeParentOnCompletion: true`)
- `publishAndWait` only works inside `task.run()` (needs task context)

### Commits
`a522cb6af` → `c4bd534af` → `a87bce472`

## Phase 7: Rate Limiting — COMPLETE

### What was done
1. `EventRateLimitConfig` zod schema + `EventRateLimitChecker` interface
2. `InMemoryEventRateLimitChecker` (sliding window)
3. `EventPublishRateLimitError` class with retry info
4. Integration in `PublishEventService` + 429 responses on all publish routes
5. `rateLimit` option on SDK `event()`, stored in DB during deploy
6. 11 unit tests + 2 integration tests

### Known limitation
- InMemory only — see pubsub-pending.md for Redis upgrade plan

### Commits
`6454ef3a6`

## Phase 8: Observability + DX — COMPLETE (partial)

### What was done
1. ClickHouse `event_counts_v1` query builder
2. `GET /api/v1/events/:eventId/stats` endpoint (time-bucketed metrics)
3. `getEventStats()` API client method
4. SDK `validate()` method for pre-flight payload validation

### Not done (deferred)
- Dashboard UI, CLI commands, reference project, documentation
- See pubsub-pending.md

### Commits
`42a3844e0`

## Test Verification (2026-02-28)
- 24/24 integration tests PASS (Docker + testcontainers)
- 11/11 rate limiter unit tests PASS
- 470/470 core unit tests PASS
