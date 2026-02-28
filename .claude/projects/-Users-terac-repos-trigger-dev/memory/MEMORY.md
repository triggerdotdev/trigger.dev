# Memory Index

## Active Projects

- **Pub/Sub Event System**: Full roadmap for implementing publish/subscribe in Trigger.dev
  - Roadmap: [pubsub-roadmap.md](pubsub-roadmap.md) (in English)
  - Repo conventions: [repo-conventions.md](repo-conventions.md)
  - Progress: [pubsub-progress.md](pubsub-progress.md)
  - Status: Phase 0 + Phase 1 + Phase 2 + Phase 3 complete
  - Current phase: Phase 3 done → next is Phase 4 (Dead Letter Queue)
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

## User Preferences

- Documentation and roadmap files must be written in English
- Commit frequently (per sub-step)
- Never commit broken code
