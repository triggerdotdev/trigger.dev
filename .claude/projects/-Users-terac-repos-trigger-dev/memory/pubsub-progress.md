# Pub/Sub Event System — Progress

## Phase 0: Core Primitives + Basic Fan-out — COMPLETE
All sub-steps 0.1–0.9 implemented and committed. See git log for details.

## Phase 1: Schema Registry + Validation — COMPLETE

### What was done
1. **1.1 — Schema versioning DB + SchemaRegistryService**
   - Added `compatibleVersions`, `deprecatedAt`, `deprecatedMessage` to EventDefinition model
   - Added `schema` field to EventManifest (Zod schema in core)
   - Created migration `20260228054059_add_event_schema_versioning`
   - Installed `ajv@8` in webapp for JSON Schema validation
   - Created `SchemaRegistryService` with: registerSchema, getSchema, listSchemas, validatePayload, checkCompatibility

2. **1.2 — Schema discovery API endpoints**
   - Created `GET /api/v1/events` — lists all event definitions with subscriber counts
   - Created `GET /api/v1/events/:eventId` — event detail with schema, subscribers, versioning info
   - Created `GET /api/v1/events/:eventId/schema` — JSON schema only
   - Added response schemas (`ListEventsResponseBody`, `GetEventResponseBody`, `GetEventSchemaResponseBody`) to core
   - Added API client methods (`listEvents`, `getEvent`, `getEventSchema`)

3. **1.3 — Store JSON schema during deploy + validate at publish**
   - Extended `EventMetadata` with `rawSchema` field
   - SDK `event()` now stores raw schema in resource catalog
   - CLI indexers (dev + managed) convert event schemas to JSON Schema via `schemaToJsonSchema`
   - `syncWorkerEvents` stores JSON schema in `EventDefinition.schema` field
   - `PublishEventService` validates payloads against stored schemas using ajv
   - Added `getEventSchema()` to ResourceCatalog interface + implementations

4. **1.4 — Tests + verification**
   - 12 unit tests for SchemaRegistryService (validation, compatibility)
   - 3 new integration tests for publish with schema validation
   - All 9 integration tests pass (6 existing + 3 new)
   - Full build passes: core, sdk, cli, webapp
   - Changeset added

### Key decisions
- Used `ajv@8` (industry standard) for JSON Schema validation at publish time
- Schema conversion happens at CLI indexing time (same pattern as task payloadSchema)
- Malformed schemas don't block publishes (graceful degradation)
- Compatibility checking is heuristic (checks required fields, type changes) — not exhaustive
- Schema validation errors return 422 with descriptive messages

### Commits
- `e6249e407` — phase 1.1: schema versioning DB + SchemaRegistryService
- `49b2903d5` — phase 1.2: schema discovery API endpoints
- `2a06ef605` — phase 1.3: store JSON schema during deploy + validate at publish
- `cfa67d079` — phase 1.4: tests + changeset

## Phase 2: Smart Routing — COMPLETE

### What was done
1. **2.1 — Filter evaluator + pattern matcher**
   - Reused existing `eventFilterMatches` (30+ tests already exist) — wrapped with caching layer
   - Created `packages/core/src/v3/events/filterEvaluator.ts`: `compileFilter`, `evaluateFilter`, cache management
   - Created `packages/core/src/v3/events/patternMatcher.ts`: `compilePattern`, `matchesPattern` for `*` and `#` wildcards
   - 28 unit tests for filter evaluator + 30 unit tests for pattern matcher

2. **2.2 — Filters in the SDK**
   - Added `onEventFilter` to `TaskMetadata` schema
   - Added `filter?: EventFilter` to `TaskOptionsWithEvent` type
   - SDK `shared.ts` extracts filter and passes to metadata
   - `syncWorkerEvents` stores filter in `EventSubscription.filter` during deploy

3. **2.3 — Filter evaluation during fan-out**
   - `PublishEventService` evaluates `subscription.filter` against payload before triggering
   - Non-matching subscribers are skipped (no run created)
   - Malformed filters err on side of delivery (graceful degradation)
   - Span attributes: `filteredOutCount`, `matchingSubscriberCount`
   - 3 integration tests: filter skips, filter allows, complex multi-field filter

4. **2.4 — Wildcard pattern subscriptions**
   - Created `events.match(pattern)` SDK helper returning `EventPatternMatcher`
   - Added `onEventPattern` to `TaskMetadata` schema
   - `syncWorkerEvents` stores pattern in `EventSubscription.pattern`
   - `PublishEventService` queries pattern subscriptions and evaluates them against event slug
   - Deduplication: subscriptions that appear in both exact and pattern results are kept only once
   - 4 integration tests: `*` matches, `*` rejects, `#` multi-level, pattern+filter combo

### Key decisions
- Reused existing `eventFilterMatches` rather than rewriting — it already has 34 tests
- Filter caching via `compileFilter(filter, cacheKey)` — keyed by subscription ID
- Pattern matching uses recursive segment-matching (not regex) for correctness with `#`
- `#` matches zero or more segments (AMQP-style) — `order.#` matches `order`, `order.created`, `order.status.changed`
- Pattern subscriptions still need an EventDefinition (placeholder with `pattern:` prefix) due to the foreign key constraint
- Malformed filters/patterns don't block publishes — errors are logged but delivery continues

### Commits
- `cd426b366` — phase 2.1: filter evaluator + pattern matcher with tests
- `be7ca08fb` — phase 2.2: filters in SDK + stored during deploy
- `676d37eb0` — phase 2.3: filter evaluation during fan-out
- `846438cf9` — phase 2.4: wildcard pattern subscriptions

## Phase 3: Event Persistence + Replay — COMPLETE

### What was done
1. **3.1 — ClickHouse event_log_v1 table + insert function**
   - Created migration `021_event_log_v1.sql`: `event_log_v1` table (MergeTree engine)
     - Partitioned by `toYYYYMM(published_at)`, ordered by `(project_id, environment_id, event_type, published_at, event_id)`
     - 90-day TTL, bloom filter indexes on event_id/publisher_run_id/idempotency_key
     - ZSTD compression on all string columns, Delta+ZSTD on timestamps
   - Created migration `022_event_counts_mv_v1.sql`: `event_counts_v1` (SummingMergeTree) + `event_counts_mv_v1` materialized view
   - Created `internal-packages/clickhouse/src/eventLog.ts`: `EventLogV1Input/Output` schemas, `insertEventLog`, `getEventLogQueryBuilder`
   - Added `eventLog` getter on `ClickHouse` class (insert + queryBuilder)

2. **3.2 — Write to event log on each publish**
   - Added `EventLogWriter` callback type + `EventLogEntry` type to `PublishEventService`
   - Constructor accepts optional `eventLogWriter` (injectable, like `triggerFn`)
   - After fan-out, calls writer with event metadata — fire-and-forget, errors logged not thrown
   - Created `eventLogWriter.server.ts`: `writeEventLog()` function using `clickhouseClient.eventLog.insert`
   - Wired into `publish` and `batchPublish` routes

3. **3.3 — Event history API endpoint**
   - Created `GET /api/v1/events/:eventId/history` route
   - Query params: `from`, `to`, `limit` (max 200), `cursor`, `publisherRunId`
   - Uses ClickHouse queryBuilder pattern: `.where().orderBy().limit().execute()`
   - Cursor-based pagination (by published_at)
   - Added `EventHistoryItem`, `GetEventHistoryResponseBody` schemas to core
   - Added `getEventHistory()` API client method

4. **3.4 — Event Replay service + API endpoint**
   - Created `ReplayEventsService` with `call(params)` method
   - Queries ClickHouse for events in date range, applies optional EventFilter
   - Re-publishes each event via `PublishEventService` with `replay:{eventId}` idempotency key
   - Supports `dryRun` (count without executing), `tasks[]` filter, max 10k events
   - Created `POST /api/v1/events/:eventId/replay` endpoint
   - Added `ReplayEventsRequestBody`, `ReplayEventsResponseBody` schemas to core
   - Added `replayEvents()` API client method

### Key decisions
- Used MergeTree (not ReplacingMergeTree) — events are immutable, no need for dedup/soft-delete
- EventLogWriter is injectable callback (not direct import) — keeps PublishEventService testable without ClickHouse
- Fire-and-forget ClickHouse writes — async `.then()` pattern, errors logged but never block publish
- Replay uses `replay:{originalEventId}` as idempotency key prefix — per-consumer dedup via PublishEventService
- No dedicated tests for 3.3/3.4 since they require ClickHouse (testcontainers only has Postgres+Redis)
- All existing 16 integration tests + 58 unit tests still pass

### Commits
- `c63c1e781` — phase 3.1: event_log_v1 ClickHouse table + insert function
- `8dfb002ee` — phase 3.2: write to ClickHouse event log on each publish
- `02369b128` — phase 3.3: event history API endpoint
- `3d9863512` — phase 3.4: event replay service + API endpoint

## Phase 4: Dead Letter Queue — COMPLETE

### What was done
1. **4.1 — DeadLetterEvent model + enum + migration**
   - Created `DeadLetterStatus` enum: `PENDING`, `RETRIED`, `DISCARDED`
   - Created `DeadLetterEvent` model with: eventType, payload, taskSlug, failedRunId (FK to TaskRun), error, attemptCount, status, sourceEventId
   - Added reverse relations on TaskRun, Project, RuntimeEnvironment
   - Migration `20260228065743_add_dead_letter_event` (cleaned of extraneous lines)

2. **4.2 — Store event context on runs + DLQ detection**
   - Modified `PublishEventService` to inject `$$event` metadata into triggered runs: `{ eventId, eventType, sourceEventId }`
   - Created `DeadLetterService` with `handleFailedRun(run, error)` method
   - Extracts `$$event` from run metadata to identify event-triggered runs
   - Hooked into `FinalizeTaskRunService` after `isFailedRunStatus()` check (alongside alerts)

3. **4.3 — DLQ management API endpoints**
   - Created `DeadLetterManagementService` with: list, retry, discard, retryAll methods
   - `GET /api/v1/events/dlq` — paginated list with eventType/status filters
   - `POST /api/v1/events/dlq/:id/retry` — re-triggers the task with `dlq-retry:{id}` idempotency key
   - `POST /api/v1/events/dlq/:id/discard` — marks as DISCARDED
   - `POST /api/v1/events/dlq/retry-all` — batch retry up to 1000 PENDING items
   - DLQ response schemas added to core
   - API client methods added

### Key decisions
- Used `$$event` metadata prefix (double-dollar convention) to avoid collisions with user metadata
- Hooked into `FinalizeTaskRunService` (not EventBus) — matches existing alert pattern, has full run data available
- Phase 4.4 (SDK DLQ config per event) deferred to Phase 8 (DX) — current implementation is sufficient
- Retry creates new run with `dlq-retry:{dleId}` idempotency key for dedup
- retryAll is capped at 1000 items per call

### Commits
- `ec4139642` — phase 4.1: DeadLetterEvent model + enum + migration
- `5ed48645e` — phase 4.2: store event context on runs + DLQ detection
- `89d0daba8` — phase 4.3: DLQ management API endpoints

## Phase 5: Ordering + Consumer Groups — COMPLETE

### What was done
1. **5.1 — Ordering keys**
   - Added `orderingKey` to `PublishEventRequestBody` and `BatchPublishEventRequestBody` in core schemas
   - Added `orderingKey` to SDK `PublishEventOptions` and pass-through in `publish()` / `batchPublish()`
   - `PublishEventService` maps `orderingKey` to `concurrencyKey` on triggered runs: `evt:{eventSlug}:{orderingKey}`
   - Updated publish + batchPublish routes to pass ordering key through
   - Span attribute added for observability

2. **5.2 — Consumer groups**
   - Added `onEventConsumerGroup` to `TaskResource` and `TaskMetadata` schemas
   - Added `consumerGroup` option to `TaskOptionsWithEvent` type
   - SDK `shared.ts` extracts and registers `consumerGroup` from task params
   - `syncWorkerEvents` stores `consumerGroup` in `EventSubscription` during deploy
   - `PublishEventService.applyConsumerGroups()` groups subscriptions by `consumerGroup`
     - Ungrouped subscriptions always receive events (normal fan-out)
     - Within each group, one member is selected (round-robin by timestamp)

3. **5.3 — Tests**
   - 3 new integration tests: ordering key sets concurrencyKey, consumer group picks one, multiple groups + ungrouped
   - All 19 integration tests pass, all 470 unit tests pass
   - Full build passes: core, sdk, cli, webapp
   - Changeset added

### Key decisions
- Ordering at **publish time** (not event definition time) — ordering key values are dynamic per-payload
- Maps to existing `concurrencyKey` infrastructure — no new queue management needed
- Consumer group selection uses `Math.floor(Date.now() / 1000) % members.length` for time-based rotation
- `consumerGroup` field already existed in Prisma schema from Phase 0.4 — no migration needed

### Commits
- `dcd3ea3c1` — phase 5.1: ordering keys via concurrencyKey
- `8c033b3dd` — phase 5.2: consumer groups for load-balanced fan-out
- `3b3abf47a` — phase 5.3: integration tests for ordering + consumer groups

## Phase 6: Publish-and-Wait — NOT STARTED
Next phase. Fan-out/fan-in with waitpoints.
