# Trigger.dev Pub/Sub Event System — Complete Roadmap

## Vision

First-class pub/sub event system within Trigger.dev that enables:
- Defining events with typed schemas
- Declaratively subscribing tasks to events
- Publishing events from any task (or externally via API)
- Automatic fan-out to all subscribed consumers
- Delivery guarantees, ordering, replay, DLQ
- Replacing the need for Kafka/RabbitMQ/EventBridge for most use cases

## Branch: feat/pubsub-event-system

## Implementation Status Summary

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Core — `event()` primitive + basic fan-out | DONE |
| 1 | Schema Registry — versioning and validation | DONE |
| 2 | Smart Routing — content-based filtering + wildcards | DONE |
| 3 | Persistence — event log in ClickHouse + replay | DONE |
| 4 | Dead Letter Queue — failure handling | DONE |
| 5 | Ordering + Consumer Groups | DONE |
| 6 | Publish-and-Wait (fan-out/fan-in) | DONE |
| 7 | Rate Limiting + Backpressure | DONE (publish-side only) |
| 8 | Observability + Developer Experience | PARTIAL (API, types, docs, CLI, ref project done; no dashboard UI) |
| 9.1 | Redis-backed rate limiter | DONE (`81c09cda5`) |
| 9.2 | Hash-based consumer groups | DONE (`81c09cda5`) |
| 9.3 | Integration tests verified | DONE (24/24 pass) |
| 9.4 | Dashboard UI, CLI, docs, reference project | PARTIAL (CLI + docs + ref done, dashboard UI pending) |
| 9.5 | Consumer-side rate limiting + backpressure | NOT STARTED |

See [pubsub-pending.md](pubsub-pending.md) for details on remaining items.
See [pubsub-progress.md](pubsub-progress.md) for per-phase implementation notes.

## Roadmap Structure

9 incremental phases. Each phase delivers usable functionality.

- **Phase 0**: Core — `event()` primitive + basic fan-out
- **Phase 1**: Schema Registry — versioning and validation
- **Phase 2**: Smart Routing — content-based filtering + wildcards
- **Phase 3**: Persistence — event log in ClickHouse + replay
- **Phase 4**: Dead Letter Queue — failure handling
- **Phase 5**: Ordering + Consumer Groups
- **Phase 6**: Publish-and-Wait (fan-out/fan-in)
- **Phase 7**: Rate Limiting + Backpressure
- **Phase 8**: Observability + Developer Experience

---

## Implementation Process & Guidelines

### Workflow per phase

1. **Read roadmap** from memory to understand current phase tasks
2. **Research before coding**: use sub-agents to explore existing patterns for each step
   - Before step 0.5 (worker registration), read how `createBackgroundWorker` currently works
   - Before step 0.7 (fan-out service), read how `TriggerTaskService` works
   - Follow existing code conventions (naming, file structure, error handling patterns)
3. **Read existing code** for every file being modified (never edit blind)
4. **Implement step by step** (0.1 → 0.2 → ... → 0.N) following dependency order
5. **Verify after each step**:
   - `pnpm run build --filter <affected-package>` — type check
   - Run specific tests if they exist for the changed code
   - Fix any issues before moving to next step
6. **Commit after each step** (each sub-step 0.1, 0.2, etc. gets its own commit)
   - Never commit broken code (build failures, test failures)
   - Commit message format: `feat(events): phase X.Y — <description>`
   - Each commit should be atomic and self-contained
7. **Full verification at end of phase**:
   - `pnpm run build --filter @trigger.dev/core --filter @trigger.dev/sdk --filter webapp`
   - Run all event-related tests
   - Run typecheck on affected packages
8. **Update roadmap** in memory: mark completed tasks with `[x]`, note any deviations
9. **Write phase summary** to memory: what was done, what decisions were made, any tech debt
10. **Proceed to next phase** without waiting for user input

### Git strategy

- Work on a feature branch: `feat/pubsub-event-system`
- Commit after every sub-step (0.1, 0.2, etc.) — one commit per sub-step minimum
- If a sub-step is large, break it into multiple commits (e.g., 0.4 DB models → one for schema, one for migration)
- Never commit code that doesn't build or has failing tests
- Changeset required when modifying public packages (`packages/*`) — add once per phase
- If a commit breaks something, fix it immediately before any other work

### Code conventions (match existing codebase)

- Follow the patterns found in existing services (e.g., `TriggerTaskService` for the publish service)
- Services go in `apps/webapp/app/v3/services/` with `.server.ts` suffix
- API routes follow Remix flat file convention in `apps/webapp/app/routes/`
- Use `env` from `apps/webapp/app/env.server.ts`, never `process.env`
- For testable code, pass config as options (never import env.server.ts in tests)
- Prisma operations follow existing patterns (transactions, error handling)
- Use `generateFriendlyId()` for user-facing IDs
- Zod schemas go in `packages/core/src/v3/schemas/`

### Sub-agents usage

- **DO use sub-agents for**: researching patterns in the codebase before coding, exploring how similar features are implemented, finding reference implementations
- **DO NOT use sub-agents for**: writing code — all code is written in main context to maintain full awareness of accumulated changes
- **DO use parallel bash calls for**: running build + test + typecheck simultaneously at verification checkpoints

### Error recovery

- If a build fails after a step: fix it before committing, don't move on
- If tests fail: investigate root cause, fix, re-run. Don't skip tests
- If a step's design doesn't work with existing code: adapt the plan, note deviation in roadmap
- If stuck on something for more than 2 attempts: note the blocker in the roadmap, skip to next step if possible, come back later
- If context gets too large: summarize current state to memory, the conversation auto-compresses old messages

### Context management

- The conversation auto-compresses old messages as context grows
- The roadmap file in memory serves as persistent state across compression
- Git commits serve as checkpoints — if context is lost, the code is in git
- Each phase starts by reading the roadmap + recent git log to understand state
- After completing each phase, write a brief summary to `memory/pubsub-progress.md`

### Quality gates (must ALL pass before moving to next phase)

1. All affected packages build successfully (`pnpm run build --filter ...`)
2. All new tests pass (`pnpm run test --filter ... --run`)
3. All existing tests still pass (no regressions)
4. No TypeScript errors in affected packages
5. All changes are committed to the feature branch
6. Roadmap updated with completed tasks marked `[x]`

### Database migration rules (from CLAUDE.md)

- Clean generated migrations of extraneous lines (see CLAUDE.md for list)
- Indexes MUST use CONCURRENTLY and be in their own separate migration file
- New tables don't need CONCURRENTLY
- Run `pnpm run db:migrate:deploy && pnpm run generate` after each migration

### Autonomous execution

The implementation runs end-to-end without user intervention:
- Phase 0 → Phase 1 → ... → Phase 8
- No need to ask user for confirmation between phases
- If a decision needs to be made (e.g., two valid approaches), pick the one that matches existing codebase patterns and note it in the roadmap
- If something is genuinely ambiguous or risky, ask the user via AskUserQuestion
- User can review progress anytime via `git log --oneline feat/pubsub-event-system` or reading `memory/pubsub-progress.md`

---

## Phase 0: Core Primitives + Basic Fan-out — COMPLETE

> **Goal**: Define events, subscribe tasks, publish, and have fan-out work.
> **Deliverable**: `event()` + `task({ on: ... })` + `.publish()` working end-to-end.

All sub-steps 0.1–0.9 implemented and committed. See `pubsub-progress.md` for details.

---

## Phase 1: Schema Registry + Validation — COMPLETE

> **Goal**: Versioned schemas, robust validation, event discovery.
> **Requires**: Phase 0

All sub-steps 1.1–1.4 implemented and committed. See `pubsub-progress.md` for details.

Key deliverables:
- [x] DB migration: `compatibleVersions`, `deprecatedAt`, `deprecatedMessage` on EventDefinition
- [x] `SchemaRegistryService` with registerSchema, getSchema, listSchemas, validatePayload, checkCompatibility
- [x] Discovery API: GET /api/v1/events, GET /api/v1/events/:id, GET /api/v1/events/:id/schema
- [x] API client methods: listEvents, getEvent, getEventSchema
- [x] Schema pipeline: SDK stores raw schema → CLI converts to JSON Schema → DB stores it → PublishEventService validates
- [x] ajv@8 for JSON Schema validation at publish time
- [x] 12 unit tests + 3 integration tests for schema validation
- [x] Changeset added

---

## Phase 2: Smart Routing — Content-based Filtering + Wildcards — COMPLETE

> **Goal**: Subscribe with filters (`amount >= 1000`) and patterns (`order.*`).
> **Requires**: Phase 0

All sub-steps 2.1–2.4 implemented and committed. See `pubsub-progress.md` for details.

Key deliverables:
- [x] Filter evaluator: `compileFilter`, `evaluateFilter` wrapping existing `eventFilterMatches` with caching
- [x] Pattern matcher: `compilePattern`, `matchesPattern` for `*` (single) and `#` (multi) wildcards
- [x] `filter` option on `TaskOptionsWithEvent`, stored in `EventSubscription.filter` during deploy
- [x] `events.match(pattern)` SDK helper for wildcard subscriptions
- [x] `PublishEventService` evaluates filters and patterns during fan-out
- [x] 58 unit tests (28 filter + 30 pattern) + 7 integration tests (3 filter + 4 pattern)
- [x] Changeset added

---

## Phase 3: Event Persistence + Replay — COMPLETE

> **Goal**: Store all published events, enable replay.
> **Requires**: Phase 0

All sub-steps 3.1–3.4 implemented and committed. See `pubsub-progress.md` for details.

Key deliverables:
- [x] ClickHouse `event_log_v1` table (MergeTree, 90-day TTL, bloom filter indexes)
- [x] `event_counts_v1` + `event_counts_mv_v1` materialized view for per-type counts
- [x] `insertEventLog` function + `eventLog` getter on ClickHouse class
- [x] `EventLogWriter` callback in `PublishEventService` — fire-and-forget ClickHouse writes
- [x] `writeEventLog` singleton wired into publish + batchPublish routes
- [x] `GET /api/v1/events/:eventId/history` — paginated event history from ClickHouse
- [x] `ReplayEventsService` — replay events in date range with filter/tasks/dryRun
- [x] `POST /api/v1/events/:eventId/replay` endpoint
- [x] API client methods: `getEventHistory`, `replayEvents`
- [x] Response schemas: `EventHistoryItem`, `GetEventHistoryResponseBody`, `ReplayEventsRequestBody`, `ReplayEventsResponseBody`
- [x] Changeset added

---

## Phase 4: Dead Letter Queue — COMPLETE

> **Goal**: Events that fail after all retries go to a DLQ for inspection and reprocessing.
> **Requires**: Phase 0, Phase 3 (for persistence)

All sub-steps 4.1–4.3 implemented and committed. See `pubsub-progress.md` for details.

Key deliverables:
- [x] `DeadLetterEvent` model + `DeadLetterStatus` enum + migration
- [x] `$$event` metadata on event-triggered runs for identification
- [x] `DeadLetterService` hooks into `FinalizeTaskRunService` on run failure
- [x] `DeadLetterManagementService` with list, retry, discard, retryAll
- [x] `GET /api/v1/events/dlq` — list DLQ entries (paginated, filterable)
- [x] `POST /api/v1/events/dlq/:id/retry` — retry single entry
- [x] `POST /api/v1/events/dlq/:id/discard` — discard single entry
- [x] `POST /api/v1/events/dlq/retry-all` — batch retry
- [x] API client methods: `listDeadLetterEvents`, `retryDeadLetterEvent`, `discardDeadLetterEvent`, `retryAllDeadLetterEvents`
- [x] Response schemas added to core
- [x] Changeset added
- Note: Phase 4.4 (SDK event() DLQ config) deferred to Phase 8 (DX)

---

## Phase 5: Ordering + Consumer Groups — COMPLETE

> **Goal**: Order guarantees by partition key. Competing consumers for load balancing.
> **Requires**: Phase 0

All sub-steps 5.1–5.3 implemented and committed. See `pubsub-progress.md` for details.

Key deliverables:
- [x] `orderingKey` in publish options, mapped to `concurrencyKey` on triggered runs
- [x] `consumerGroup` option on `TaskOptionsWithEvent`, stored in `EventSubscription.consumerGroup` during deploy
- [x] `PublishEventService.applyConsumerGroups()` — within a group, only one task receives each event
- [x] 3 integration tests for ordering + consumer groups
- [x] Changeset added

---

## Phase 6: Publish-and-Wait (Fan-out / Fan-in) — COMPLETE

> **Goal**: Publish an event and wait for all consumers to finish.
> **Requires**: Phase 0

### 6.1 — Runtime waitForEvent — DONE

**File modified**: `packages/core/src/v3/runtime/sharedRuntimeManager.ts`

Tasks:
- [x] `waitForEvent` implemented in `SharedRuntimeManager` with resolvers, suspendable, lifecycle hooks
- [x] `NoopRuntimeManager` returns empty results as fallback
- [x] `RuntimeAPI` exposes `waitForEvent` as public method

### 6.2 — Backend: publishAndWait endpoint — DONE

Tasks:
- [x] `POST /api/v1/events/:eventId/publishAndWait` endpoint
- [x] Reuses `PublishEventService` with `parentRunId` option
- [x] Each triggered run gets `parentRunId` + `resumeParentOnCompletion: true`
- [x] Run engine creates waitpoints automatically via existing infrastructure
- [x] API client method `publishAndWaitEvent()`

### 6.3 — SDK publishAndWait — DONE

**File modified**: `packages/trigger-sdk/src/v3/events.ts`

Tasks:
- [x] `EventDefinition.publishAndWait()` implemented
- [x] Validates payload, calls API with `parentRunId: ctx.run.id`
- [x] Waits via `runtime.waitForEvent()` which registers resolvers for all runs
- [x] Returns aggregated `PublishAndWaitResult` with results keyed by task slug
- [x] Throws if called outside `task.run()` (needs task context for waitpoints)

### 6.tests — DONE
- [x] 3 integration tests: waitpoints per subscriber, no-subscribers empty, event log writer fanOutCount

---

## Phase 7: Rate Limiting + Backpressure — PARTIAL

> **Goal**: Control publish and consume speed. Detect lag.
> **Requires**: Phase 0

### 7.1 — Publish rate limiting — DONE

**File created**: `apps/webapp/app/v3/services/events/eventRateLimiter.server.ts`

Tasks:
- [x] Implement sliding window rate limiter:
  - `InMemoryEventRateLimitChecker` for dev/testing
  - `RedisEventRateLimitChecker` using `@upstash/ratelimit` for production (Phase 9.1)
  - Key: `{projectId}:{eventSlug}`
  - Configurable per-event via `EventDefinition.rateLimit` JSON field
- [x] Response headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `retry-after` on publish endpoints
- [x] When exceeded: HTTP 429 with `Retry-After` header
- [x] 11 unit tests + 2 integration tests

**File modified**: `packages/trigger-sdk/src/v3/events.ts`

Tasks:
- [x] Extend `event()`:
  ```typescript
  event({
    id: "order.created",
    schema: orderSchema,
    rateLimit: {
      limit: 500,
      window: "1m",
    },
  });
  ```

### 7.2 — Consumer rate limiting — NOT DONE (deferred)

**File to modify**: `packages/trigger-sdk/src/v3/shared.ts`

Tasks:
- [ ] Extend task with per-event rate limit:
  ```typescript
  task({
    on: orderCreated,
    rateLimit: { limit: 100, window: "1m" },
    run: async (payload) => { ... },
  });
  ```
- [ ] Implement as queue with rate limit (reuse concurrency limits infra)
- [ ] Events that exceed the rate are enqueued (not lost), processed when capacity is available

### 7.3 — Backpressure detection + metrics — NOT DONE (deferred)

**New file**: `apps/webapp/app/v3/services/events/backpressureMonitor.server.ts`

Tasks:
- [ ] Monitor lag per consumer: `pendingRuns = publishedEvents - processedEvents`
- [ ] Metrics in ClickHouse:
  - `event_publish_rate` per type
  - `event_consume_rate` per consumer
  - `event_consumer_lag` (difference)
- [ ] Alerts when lag exceeds configurable threshold
- [ ] Expose metrics in API: `GET /api/v1/events/:eventId/metrics`

---

## Phase 8: Observability + Developer Experience — PARTIAL

> **Goal**: Dashboard, CLI, full traceability, documentation.
> **Requires**: Phases 0-7 (gradual, can start earlier)

### 8.1 — Event stats API + SDK validate — DONE

Tasks:
- [x] ClickHouse `event_counts_v1` query builder
- [x] `GET /api/v1/events/:eventId/stats` endpoint (time-bucketed metrics, periods: 1h/6h/24h/7d/30d)
- [x] `getEventStats()` API client method
- [x] SDK `validate()` method for pre-flight payload validation

### 8.2 — Trace propagation — PARTIAL

**File modified**: `apps/webapp/app/v3/services/events/publishEvent.server.ts`

Tasks:
- [x] Span attributes on publish: `eventSlug`, `eventDefinitionId`, `subscriberCount`, `matchingSubscriberCount`, `filteredOutCount`, `consumerGroupSkipped`, `rateLimited`, `orderingKey`
- [x] `$$event` metadata on each triggered run: `{ eventId, eventType, sourceEventId }` — used by DLQ for identification
- [ ] Propagate `traceId` from publisher to all consumer runs (currently inherits from span context)
- [ ] Named span attributes `trigger.event.id` and `trigger.event.type` (currently uses `eventSlug`)
- [ ] In run dashboard: show "Triggered by event: order.created" (UI work)
- [ ] In event dashboard: show all runs it generated (UI work)

### 8.3 — Events dashboard (webapp) — NOT DONE (deferred)

**New files in**: `apps/webapp/app/routes/`

Tasks:
- [ ] Event list view: `/orgs/:orgSlug/projects/:projectSlug/events`
  - List of EventDefinitions with stats (publish count, last published, subscriber count)
- [ ] Event detail view: `.../events/:eventSlug`
  - Schema (formatted)
  - List of subscribers (tasks)
  - Recent publication history (from ClickHouse)
  - Metrics: publish rate, consumer lag
- [ ] DLQ view: `.../events/dlq`
  - List of dead letter events, filterable by type/status
  - Actions: retry, discard, retry all
- [ ] Corresponding presenters in `apps/webapp/app/v3/presenters/`

### 8.4 — CLI commands — PARTIAL

**Files created**: `packages/cli-v3/src/commands/events/`

Tasks:
- [x] `trigger events list` — list project events
- [x] `trigger events publish <eventId> --payload '{...}'` — publish from CLI
- [ ] `trigger events history <eventId> --from --to` — view history
- [ ] `trigger events replay <eventId> --from --to` — replay
- [ ] `trigger events dlq list` — view dead letter queue
- [ ] `trigger events dlq retry <dlqId>` — retry DLQ item

### 8.5 — SDK helpers and DX — PARTIAL

**File modified**: `packages/trigger-sdk/src/v3/events.ts`

Tasks:
- [x] SDK `validate()` method for pre-flight payload validation
- [x] Full type inference: consumer payload typed from event schema (`TaskOptionsWithEvent<..., TPayload>` flows from `EventSource<TPayload>`)
- [x] Descriptive error messages when schema validation fails (422 with field paths from ajv)
- [ ] Helper for local testing:
  ```typescript
  import { testEvent } from "@trigger.dev/sdk/testing";

  // In tests
  const result = await testEvent(orderCreated, { orderId: "123", amount: 50 });
  expect(result.runs).toHaveLength(2);
  ```
- [ ] Complete JSDoc on all public functions

### 8.6 — Documentation — DONE

**Files created**: `rules/4.4.0/events.md`

Tasks:
- [x] Event system documentation: `rules/4.4.0/events.md` — single comprehensive file covering all features (define, publish, subscribe, filters, patterns, ordering, consumer groups, DLQ, replay)
- [x] Update `.claude/skills/trigger-dev-tasks/SKILL.md` with events section and reference
- [x] Update `manifest.json` with new version 4.4.0

### 8.7 — Reference project — DONE

**Directory created**: `references/event-system/`

Tasks:
- [x] Reference project demonstrating:
  - Definition of multiple events with schemas and rate limits
  - Basic fan-out (multiple subscribers)
  - Content-based filtering
  - Wildcard pattern subscriptions
  - Publish-and-wait (scatter-gather)
  - Consumer groups (load balancing)
  - Ordering keys (sequential per entity)
- [x] Use as manual testing project (similar to hello-world)

---

## Phase dependencies

```
Phase 0 (Core) ─────┬── Phase 1 (Schema Registry)
                     ├── Phase 2 (Smart Routing)
                     ├── Phase 3 (Persistence + Replay)
                     │       └── Phase 4 (DLQ) ← needs persistence
                     ├── Phase 5 (Ordering + Consumer Groups)
                     ├── Phase 6 (Publish-and-Wait)
                     ├── Phase 7 (Rate Limiting)
                     └── Phase 8 (DX) ← gradual, can start with Phase 0
```

Phases 1-7 are mostly independent of each other (all depend on Phase 0).
Phase 4 (DLQ) benefits from Phase 3 (persistence) but can work without it.
Phase 8 (DX) is built incrementally with each phase.

---

## Key files to create/modify (summary)

### New files
| File | Phase |
|------|-------|
| `packages/trigger-sdk/src/v3/events.ts` | 0 |
| `packages/core/src/v3/events/schemaUtils.ts` | 1 |
| `packages/core/src/v3/events/filterEvaluator.ts` | 2 |
| `apps/webapp/app/routes/api.v1.events.$eventId.publish.ts` | 0 |
| `apps/webapp/app/routes/api.v1.events.$eventId.batchPublish.ts` | 0 |
| `apps/webapp/app/routes/api.v1.events.$eventId.history.ts` | 3 |
| `apps/webapp/app/routes/api.v1.events.$eventId.replay.ts` | 3 |
| `apps/webapp/app/routes/api.v1.events.ts` | 1 |
| `apps/webapp/app/routes/api.v1.events.dlq.ts` | 4 |
| `apps/webapp/app/v3/services/events/publishEvent.server.ts` | 0 |
| `apps/webapp/app/v3/services/events/schemaRegistry.server.ts` | 1 |
| `apps/webapp/app/v3/services/events/deadLetterService.server.ts` | 4 |
| `apps/webapp/app/v3/services/events/deadLetterManagement.server.ts` | 4 |
| `apps/webapp/app/v3/services/events/replayEvents.server.ts` | 3 |
| `apps/webapp/app/v3/services/events/eventRateLimiter.server.ts` | 7 |
| `apps/webapp/app/v3/services/events/eventRateLimiterGlobal.server.ts` | 7 |
| `apps/webapp/app/v3/services/events/eventLogWriter.server.ts` | 3 |
| `apps/webapp/app/routes/api.v1.events.$eventId.publishAndWait.ts` | 6 |
| `apps/webapp/app/routes/api.v1.events.$eventId.stats.ts` | 8 |
| `apps/webapp/app/routes/api.v1.events.dlq.$id.retry.ts` | 4 |
| `apps/webapp/app/routes/api.v1.events.dlq.$id.discard.ts` | 4 |
| `apps/webapp/app/routes/api.v1.events.dlq.retry-all.ts` | 4 |
| `internal-packages/clickhouse/schema/021_event_log_v1.sql` | 3 |
| `internal-packages/clickhouse/schema/022_event_counts_mv_v1.sql` | 3 |
| `internal-packages/clickhouse/src/eventLog.ts` | 3 |
| `internal-packages/clickhouse/src/eventCounts.ts` | 8 |
| `apps/webapp/app/v3/services/events/backpressureMonitor.server.ts` | 7 (not done) |
| `references/event-system/` | 8 (not done) |

### Files to modify
| File | Phase |
|------|-------|
| `packages/trigger-sdk/src/v3/index.ts` | 0 |
| `packages/trigger-sdk/src/v3/shared.ts` | 0, 2, 5 |
| `packages/core/src/v3/schemas/resources.ts` | 0 |
| `packages/core/src/v3/schemas/schemas.ts` | 0, 7 |
| `packages/core/src/v3/schemas/api.ts` | 3, 4, 6, 8 |
| `packages/core/src/v3/resource-catalog/catalog.ts` | 0, 7 |
| `packages/core/src/v3/resource-catalog/standardResourceCatalog.ts` | 0, 7 |
| `packages/core/src/v3/apiClient/index.ts` | 0, 3, 4, 6, 8 |
| `packages/core/src/v3/runtime/sharedRuntimeManager.ts` | 6 |
| `packages/core/src/v3/runtime/noopRuntimeManager.ts` | 6 |
| `packages/core/src/v3/index.ts` | 6 |
| `internal-packages/database/prisma/schema.prisma` | 0, 1, 4, 7 |
| `internal-packages/clickhouse/src/index.ts` | 3, 8 |
| `apps/webapp/app/v3/services/createBackgroundWorker.server.ts` | 0, 7 |
| `apps/webapp/app/v3/services/finalizeTaskRun.server.ts` | 4 |

### Tests
| File | Tests |
|------|-------|
| `apps/webapp/test/engine/publishEvent.test.ts` | 24 integration tests |
| `apps/webapp/test/engine/eventRateLimiter.test.ts` | 11 unit tests |
| Core filter/pattern tests | 58 + 30 unit tests |
| Core SchemaRegistryService tests | 12 unit tests |
