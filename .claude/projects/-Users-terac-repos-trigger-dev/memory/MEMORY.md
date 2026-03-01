# Memory Index

## Pub/Sub Event System
- [Roadmap & Status](pubsub-roadmap.md) — phases 0-8 complete, pending items identified
- [Detailed Progress](pubsub-progress.md) — per-phase notes, commits, decisions
- [Pending Items](pubsub-pending.md) — Redis rate limiter, consumer groups, dashboard, etc.
- Repo conventions: [repo-conventions.md](repo-conventions.md)
- Branch: `feat/pubsub-event-system`

## Repo Quick Reference

- Build: `pnpm run build --filter <pkg>`, Test: `pnpm run test --filter <pkg>`
- Build order: core → sdk → cli → run-engine → webapp
- Services extend `WithRunEngine`, use `traceWithEnv()`, throw `ServiceValidationError`
- API routes use `createActionApiRoute()` builder
- Tests use testcontainers (never mocks), vitest
- Import `@trigger.dev/core` subpaths only, never root
- Migrations: clean extraneous lines, indexes need CONCURRENTLY in separate files
- Changesets required for `packages/*` changes (default: patch)
- Tags in integration tests: avoid `tags` option in trigger calls — `createTag` uses global prisma mock `{}`

## Rate Limiting Patterns in Codebase
- `apps/webapp/app/services/rateLimiter.server.ts` — Upstash `@upstash/ratelimit` wrapper (sliding window, token bucket, fixed window)
- `apps/webapp/app/v3/GCRARateLimiter.server.ts` — Custom GCRA with Redis Lua scripts
- Both use dedicated Redis connection (`RATE_LIMIT_REDIS_HOST` env vars)
- Good reference implementations: `mfaRateLimiter.server.ts`, `magicLinkRateLimiter.server.ts`

## User Preferences

- Documentation and roadmap files must be written in English
- Commit frequently (per sub-step)
- Never commit broken code
