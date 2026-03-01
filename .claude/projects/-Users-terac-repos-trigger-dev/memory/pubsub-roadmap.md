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

## Implementation Status

### Phases 0–8: CORE IMPLEMENTATION COMPLETE

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
| 8 | Observability + Developer Experience | DONE (API only, no UI/CLI/docs) |

### Phase 9: Production Hardening — PENDING

See [pubsub-pending.md](pubsub-pending.md) for detailed items:
- 9.1 — Redis-backed rate limiter (LOW complexity)
- 9.2 — Consumer group improvement (MEDIUM complexity)
- 9.3 — Integration tests verified (DONE)
- 9.4 — Dashboard UI, CLI commands, reference project, documentation (HIGH complexity)
- 9.5 — Consumer-side rate limiting + backpressure monitor (MEDIUM complexity)

---

## Known Limitations

### Rate Limiter: In-Memory Only
- `InMemoryEventRateLimitChecker` uses sliding window in memory
- Lost on process restart, doesn't work with multiple instances
- Interface `EventRateLimitChecker` ready for Redis swap-in
- Codebase has proven patterns: Upstash `@upstash/ratelimit` + GCRA with Redis Lua scripts

### Consumer Groups: Simplistic Round-Robin
- Selection: `Math.floor(Date.now() / 1000) % members.length`
- Not true consumer groups (no persistent state, no rebalancing)
- Within same second, all events go to same consumer

### Phase 7 Partial
- Only publish-side rate limiting implemented
- No consumer-side rate limiting
- No backpressure monitor service

### Phase 8 Partial
- Only API-level observability (stats endpoint, SDK validate())
- No dashboard UI, no CLI commands, no reference project, no documentation

---

## Implementation Guidelines (preserved for reference)

### Code conventions (match existing codebase)
- Services go in `apps/webapp/app/v3/services/` with `.server.ts` suffix
- API routes follow Remix flat file convention in `apps/webapp/app/routes/`
- Use `env` from `apps/webapp/app/env.server.ts`, never `process.env`
- For testable code, pass config as options (never import env.server.ts in tests)
- Zod schemas go in `packages/core/src/v3/schemas/`
- Commit message format: `feat(events): phase X.Y — <description>`

### Quality gates
1. All affected packages build successfully
2. All new tests pass
3. All existing tests still pass (no regressions)
4. No TypeScript errors in affected packages
5. All changes are committed to the feature branch

### Database migration rules
- Clean generated migrations of extraneous lines (see CLAUDE.md for list)
- Indexes MUST use CONCURRENTLY and be in their own separate migration file
- Run `pnpm run db:migrate:deploy && pnpm run generate` after each migration

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

---

## Key files created

### Services
| File | Phase |
|------|-------|
| `apps/webapp/app/v3/services/events/publishEvent.server.ts` | 0 |
| `apps/webapp/app/v3/services/events/schemaRegistry.server.ts` | 1 |
| `apps/webapp/app/v3/services/events/deadLetterService.server.ts` | 4 |
| `apps/webapp/app/v3/services/events/deadLetterManagement.server.ts` | 4 |
| `apps/webapp/app/v3/services/events/replayEvents.server.ts` | 3 |
| `apps/webapp/app/v3/services/events/eventRateLimiter.server.ts` | 7 |
| `apps/webapp/app/v3/services/events/eventRateLimiterGlobal.server.ts` | 7 |
| `apps/webapp/app/v3/services/events/eventLogWriter.server.ts` | 3 |

### API Routes
| File | Phase |
|------|-------|
| `apps/webapp/app/routes/api.v1.events.ts` | 1 |
| `apps/webapp/app/routes/api.v1.events.$eventId.ts` | 1 |
| `apps/webapp/app/routes/api.v1.events.$eventId.schema.ts` | 1 |
| `apps/webapp/app/routes/api.v1.events.$eventId.publish.ts` | 0 |
| `apps/webapp/app/routes/api.v1.events.$eventId.batchPublish.ts` | 0 |
| `apps/webapp/app/routes/api.v1.events.$eventId.publishAndWait.ts` | 6 |
| `apps/webapp/app/routes/api.v1.events.$eventId.history.ts` | 3 |
| `apps/webapp/app/routes/api.v1.events.$eventId.replay.ts` | 3 |
| `apps/webapp/app/routes/api.v1.events.$eventId.stats.ts` | 8 |
| `apps/webapp/app/routes/api.v1.events.dlq.ts` | 4 |
| `apps/webapp/app/routes/api.v1.events.dlq.$id.retry.ts` | 4 |
| `apps/webapp/app/routes/api.v1.events.dlq.$id.discard.ts` | 4 |
| `apps/webapp/app/routes/api.v1.events.dlq.retry-all.ts` | 4 |

### SDK / Core
| File | Phase |
|------|-------|
| `packages/trigger-sdk/src/v3/events.ts` | 0 |
| `packages/core/src/v3/events/filterEvaluator.ts` | 2 |
| `packages/core/src/v3/events/patternMatcher.ts` | 2 |
| `internal-packages/clickhouse/src/eventLog.ts` | 3 |
| `internal-packages/clickhouse/src/eventCounts.ts` | 8 |

### Tests
| File | Tests |
|------|-------|
| `apps/webapp/test/engine/publishEvent.test.ts` | 24 integration tests |
| `apps/webapp/test/engine/eventRateLimiter.test.ts` | 11 unit tests |
