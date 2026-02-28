# Trigger.dev Pub/Sub Event System — Complete Roadmap

## Vision

First-class pub/sub event system within Trigger.dev that enables:
- Defining events with typed schemas
- Declaratively subscribing tasks to events
- Publishing events from any task (or externally via API)
- Automatic fan-out to all subscribed consumers
- Delivery guarantees, ordering, replay, DLQ
- Replacing the need for Kafka/RabbitMQ/EventBridge for most use cases

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

## Phase 5: Ordering + Consumer Groups

> **Goal**: Order guarantees by partition key. Competing consumers for load balancing.
> **Requires**: Phase 0

### 5.1 — Ordering keys

**File to modify**: `packages/trigger-sdk/src/v3/events.ts`

Tasks:
- [ ] Extend `event()`:
  ```typescript
  event({
    id: "order.updated",
    schema: orderSchema,
    orderingKey: (payload) => payload.orderId,
    // Events with the same orderId are processed sequentially
  });
  ```
- [ ] Alternative: ordering at publish time:
  ```typescript
  await orderUpdated.publish(payload, {
    orderingKey: payload.orderId,
  });
  ```

**File to modify**: `apps/webapp/app/v3/services/events/publishEvent.server.ts`

Tasks:
- [ ] When ordering key is present:
  - Derive queue name: `event:{eventSlug}:order:{orderingKeyHash}`
  - Use queue with `concurrencyLimit: 1` to guarantee sequence
  - Each subscribed consumer uses this queue
- [ ] Reuse existing `RunQueue` with named queues
- [ ] Ordering is per-consumer: each consumer processes in order within its partition

### 5.2 — Consumer Groups

**File to modify**: `internal-packages/database/prisma/schema.prisma`

Tasks:
- [ ] `consumerGroup` field already defined in Phase 0.4 on `EventSubscription`
- [ ] Constraint: within a consumer group, only 1 run per event

**File to modify**: `packages/trigger-sdk/src/v3/shared.ts`

Tasks:
- [ ] Extend task options:
  ```typescript
  task({
    on: orderCreated,
    consumerGroup: "order-processors",
    run: async (payload) => { ... },
  });
  ```

**File to modify**: `apps/webapp/app/v3/services/events/publishEvent.server.ts`

Tasks:
- [ ] In fan-out:
  - Group subscriptions by `consumerGroup`
  - For subscriptions WITHOUT a group: normal fan-out (1 run each)
  - For subscriptions WITH a group: pick 1 subscription from the group (round-robin or random)
  - Reuse `FairQueueSelectionStrategy` for fair selection
- [ ] Persist selection so replay uses the same consumer

Tests:
- [ ] Test: 3 tasks in the same consumer group → only 1 receives each event
- [ ] Test: fair distribution among group members
- [ ] Test: task without group + task with group both work on the same event

---

## Phase 6: Publish-and-Wait (Fan-out / Fan-in)

> **Goal**: Publish an event and wait for all consumers to finish.
> **Requires**: Phase 0

### 6.1 — publishAndWait in the SDK

**File to modify**: `packages/trigger-sdk/src/v3/events.ts`

Tasks:
- [ ] Implement `EventDefinition.publishAndWait()`:
  ```typescript
  const results = await orderCreated.publishAndWait(payload, {
    timeout: "5m", // optional
  });
  // results: Record<taskSlug, { ok: boolean, output?: any, error?: any }>
  ```
- [ ] Internally:
  - Call special endpoint `POST /api/v1/events/:eventId/publishAndWait`
  - The endpoint creates runs + waitpoints
  - Returns when all waitpoints complete

### 6.2 — Backend: publish with waitpoints

**New file**: `apps/webapp/app/v3/services/events/publishAndWait.server.ts`

Tasks:
- [ ] Reuse existing `WaitpointSystem`:
  1. Create a coordinator "event waitpoint"
  2. Fan-out: create a run per consumer
  3. For each run, create a child waitpoint linked to the coordinator
  4. The caller is blocked on the coordinator waitpoint
  5. When each consumer finishes → completes its waitpoint
  6. When all child waitpoints complete → completes the coordinator
- [ ] Timeout: if a consumer doesn't finish, complete with partial error
- [ ] Result: aggregate outputs from each consumer

### 6.3 — Timeout and error handling

Tasks:
- [ ] If a consumer fails definitively (exhausted retries) → its result is error
- [ ] If timeout is reached before all finish → partial result with status of each
- [ ] The caller decides what to do with partial results

---

## Phase 7: Rate Limiting + Backpressure

> **Goal**: Control publish and consume speed. Detect lag.
> **Requires**: Phase 0

### 7.1 — Publish rate limiting

**New file**: `apps/webapp/app/v3/services/events/rateLimiter.server.ts`

Tasks:
- [ ] Implement sliding window rate limiter (Redis):
  - Key: `ratelimit:publish:{projectId}:{eventSlug}`
  - Configurable per-event
  - Default: 1000 events/minute per type
- [ ] Response header `X-RateLimit-Remaining` on publish endpoint
- [ ] When exceeded: HTTP 429 with `Retry-After` header

**File to modify**: `packages/trigger-sdk/src/v3/events.ts`

Tasks:
- [ ] Extend `event()`:
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

### 7.2 — Consumer rate limiting

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

### 7.3 — Backpressure detection + metrics

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

## Phase 8: Observability + Developer Experience

> **Goal**: Dashboard, CLI, full traceability, documentation.
> **Requires**: Phases 0-7 (gradual, can start earlier)

### 8.1 — Trace propagation

**File to modify**: `apps/webapp/app/v3/services/events/publishEvent.server.ts`

Tasks:
- [ ] Propagate `traceId` from publisher to all consumer runs
- [ ] Add span attribute `trigger.event.id` and `trigger.event.type` to each run
- [ ] Add `sourceEventId` to TaskRun metadata
- [ ] In run dashboard: show "Triggered by event: order.created"
- [ ] In event dashboard: show all runs it generated

### 8.2 — Events dashboard (webapp)

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

### 8.3 — CLI commands

**File to modify**: `packages/cli-v3/src/commands/`

Tasks:
- [ ] `trigger events list` — list project events
- [ ] `trigger events publish <eventId> --payload '{...}'` — publish from CLI
- [ ] `trigger events history <eventId> --from --to` — view history
- [ ] `trigger events replay <eventId> --from --to` — replay
- [ ] `trigger events dlq list` — view dead letter queue
- [ ] `trigger events dlq retry <dlqId>` — retry DLQ item

### 8.4 — SDK helpers and DX

**File to modify**: `packages/trigger-sdk/src/v3/events.ts`

Tasks:
- [ ] Helper for local testing:
  ```typescript
  import { testEvent } from "@trigger.dev/sdk/testing";

  // In tests
  const result = await testEvent(orderCreated, { orderId: "123", amount: 50 });
  expect(result.runs).toHaveLength(2);
  ```
- [ ] Full type inference: consumer payload typed from event schema
- [ ] Descriptive error messages when schema validation fails
- [ ] Complete JSDoc on all public functions

### 8.5 — Documentation

**New files in**: `rules/` (next version)

Tasks:
- [ ] Event system documentation for SDK rules:
  - `events-basic.md` — define events, publish, subscribe
  - `events-advanced.md` — filters, wildcards, ordering, consumer groups
  - `events-reliability.md` — DLQ, replay, idempotency
  - `events-patterns.md` — common patterns (saga, CQRS, event sourcing)
- [ ] Update `.claude/skills/trigger-dev-tasks/SKILL.md` with event examples
- [ ] Update `manifest.json` with new version

### 8.6 — Reference project

**New directory**: `references/event-system/`

Tasks:
- [ ] Reference project demonstrating:
  - Definition of multiple events
  - Tasks subscribed with filters
  - Publish from a task
  - Publish-and-wait pattern
  - DLQ handler
- [ ] Use as manual testing project (similar to hello-world)

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
| `apps/webapp/app/v3/services/events/publishAndWait.server.ts` | 6 |
| `apps/webapp/app/v3/services/events/schemaRegistry.server.ts` | 1 |
| `apps/webapp/app/v3/services/events/deadLetterService.server.ts` | 4 |
| `apps/webapp/app/v3/services/events/replayEvents.server.ts` | 3 |
| `apps/webapp/app/v3/services/events/rateLimiter.server.ts` | 7 |
| `apps/webapp/app/v3/services/events/backpressureMonitor.server.ts` | 7 |
| `internal-packages/clickhouse/schema/XXX_event_log_v1.sql` | 3 |
| `internal-packages/run-engine/src/engine/tests/events.test.ts` | 0 |
| `references/event-system/` | 8 |

### Files to modify
| File | Phase |
|------|-------|
| `packages/trigger-sdk/src/v3/index.ts` | 0 |
| `packages/trigger-sdk/src/v3/shared.ts` | 0, 2, 5 |
| `packages/core/src/v3/schemas/resources.ts` | 0 |
| `packages/core/src/v3/resource-catalog/catalog.ts` | 0 |
| `packages/core/src/v3/resource-catalog/standardCatalog.ts` | 0 |
| `internal-packages/database/prisma/schema.prisma` | 0, 1, 4, 5 |
| `apps/webapp/app/v3/services/createBackgroundWorker.server.ts` | 0 |
| `apps/webapp/app/v3/services/createDeploymentBackgroundWorkerV4.server.ts` | 0 |
