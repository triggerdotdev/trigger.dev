# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Trigger.dev is an open source platform and SDK for creating long-running background jobs. The codebase is a pnpm monorepo using Turborepo with TypeScript/JavaScript across multiple apps and packages.

## Key Architecture

### Core Components
- **webapp** (apps/webapp): Remix 2.1.0 app serving as the main API and dashboard
- **supervisor** (apps/supervisor): Node.js app handling task execution and interfacing with Docker/Kubernetes
- **@trigger.dev/sdk** (packages/trigger-sdk): Main SDK package for v3
- **@trigger.dev/core** (packages/core): Shared code between SDK and other packages
- **@internal/run-engine**: Run Engine 2.0 - handles complete run lifecycle
- **@trigger.dev/database**: Prisma 5.4.1 client for PostgreSQL

### Important Patterns
- Environment variables accessed through `app/env.server.ts` in webapp, never directly via `process.env`
- Service/configuration separation for testability
- "Presenters" used for complex loader logic in `app/v3/presenters/`
- Legacy run engine being replaced by Run Engine 2.0 in `@internal/run-engine`

## Common Commands

### Development
```bash
# Start development environment
pnpm run dev

# Start specific app
pnpm run dev --filter webapp

# Docker services (PostgreSQL, Redis, Electric)
pnpm run docker
```

### Building and Testing
```bash
# Build all packages
pnpm run build

# Run all tests (use --concurrency=1 for stability)
pnpm run test --concurrency=1

# Test specific workspace
pnpm run test --filter webapp
pnpm run test --filter "@trigger.dev/*"

# Lint and typecheck
pnpm run lint
pnpm run typecheck
```

### Database Operations
```bash
# Run migrations and generate client
pnpm run db:migrate

# Seed database
pnpm run db:seed

# Open Prisma Studio
pnpm run db:studio
```

### Working with Specific Tests
```bash
# Navigate to package directory for single file testing
cd apps/webapp
pnpm run test --run

# Run specific test file
cd internal-packages/run-engine
pnpm run test ./src/engine/tests/ttl.test.ts --run
```

## Writing Trigger.dev Tasks

### Critical Requirements
- **MUST** use `@trigger.dev/sdk/v3`
- **MUST** export every task (including subtasks)
- **NEVER** use deprecated `client.defineJob` patterns

### Correct Task Pattern
```ts
import { task } from "@trigger.dev/sdk/v3";

export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { message: string }) => {
    console.log(payload.message);
  },
});
```

### Key Features Available
- Scheduled tasks with `schedules.task()`
- Schema validation with `schemaTask()`
- Metadata system for run data
- Realtime subscriptions and streaming
- Retry configuration and error handling
- Queue concurrency controls
- Machine resource specifications
- Idempotency keys

## Testing Guidelines

### Webapp Testing
- Never import `env.server.ts` in tests directly or indirectly
- Pass environment configuration as options to maintain service/configuration separation
- Follow examples in `realtimeClient.server.ts` vs `realtimeClientGlobal.server.ts`

### Test Infrastructure
- Use `@internal/testcontainers` for spinning up services in tests
- Tests use Vitest framework
- Testcontainers available for PostgreSQL, Redis, and other services

## Important File Locations

### API Endpoints
- Task triggering: `apps/webapp/app/routes/api.v1.tasks.$taskId.trigger.ts`
- Batch triggering: `apps/webapp/app/routes/api.v1.tasks.batch.ts`
- OTEL endpoints: `apps/webapp/app/routes/otel.v1.logs.ts` and `otel.v1.traces.ts`

### Core Services
- Database client: `apps/webapp/app/db.server.ts`
- Run engine config: `apps/webapp/app/v3/runEngine.server.ts`
- Event handling: `apps/webapp/app/v3/eventRepository.server.ts`
- OTEL processing: `apps/webapp/app/v3/otlpExporter.server.ts`

### Configuration
- Webapp uses subpath exports from `@trigger.dev/core` (never root import)
- Run Engine 2.0 is the active system, legacy run engine being deprecated
- Build extensions available in `packages/build` for custom requirements

## Deployment and Environments

- Supports Development, Staging, and Production environments
- Uses `trigger.config.ts` for project configuration
- CLI available via `trigger.dev` package for deployments
- Self-hosting supported via Docker/Kubernetes

## Railway Deployment Best Practices

### Environment Variables
- **ALWAYS use Railway template variables** for cross-service references:
  - `${{Postgres.DATABASE_URL}}` - PostgreSQL connection string
  - `${{Redis.RAILWAY_PRIVATE_DOMAIN}}` - Redis hostname
  - `${{Redis.REDISPORT}}` - Redis port
  - `${{Redis.REDISPASSWORD}}` - Redis password
  - `${{RAILWAY_PUBLIC_DOMAIN}}` - Service public domain
- **NEVER hardcode connection strings** - they change between deployments
- Use `railway variables --set KEY=value` for application-specific variables
- Generate secrets with `openssl rand -hex 16`

### Common Railway Issues
- ClickHouse validation: Set `CLICKHOUSE_URL=` (empty) to bypass v4-beta validation bug
- Missing domains: Run `railway domain` to generate public domain for service
- Cross-service references: Ensure service names match exactly (case-sensitive)

## Development Best Practices

- Use appropriate machine presets (micro to large-2x) based on resource needs
- Implement proper error handling and retry strategies
- Leverage metadata system for run progress tracking
- Use realtime features for UI updates
- Follow idempotency patterns for reliability