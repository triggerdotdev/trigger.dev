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

### How railway.json Works
- **railway.json is a TEMPLATE, not a variable creator**
- It defines variable mapping but doesn't create the variables
- Variables must exist first before railway.json can reference them
- Cross-service references work automatically: `${{Postgres.DATABASE_URL}}`
- Service variables must be set manually: `railway variables --set SESSION_SECRET=value`
- **CRITICAL: railway.json only applies during `railway up`, not `railway redeploy`**
- Use `railway up --detach` to deploy with railway.json changes
- Use `railway redeploy` only to restart existing deployment without config changes

### Environment Variable Categories
**Railway Auto-Provided (✅ Work automatically):**
- `${{PORT}}` - Service port (but set PORT=3030 for Remix apps)
- `${{Postgres.DATABASE_URL}}` - PostgreSQL connection string
- `${{Redis.RAILWAY_PRIVATE_DOMAIN}}` - Redis hostname
- `${{Redis.REDISPORT}}` - Redis port
- `${{Redis.REDISPASSWORD}}` - Redis password
- `${{RAILWAY_PUBLIC_DOMAIN}}` - Service public domain

**Manual Required (❌ Must set with CLI):**
- `SESSION_SECRET`, `MAGIC_LINK_SECRET`, `ENCRYPTION_KEY`, `MANAGED_WORKER_SECRET`
- Generate with: `openssl rand -hex 16`
- Set with: `railway variables --set KEY=value`

### Critical railway.json Syntax Rules
- ✅ **Correct**: `"SESSION_SECRET": "${{SESSION_SECRET}}"`
- ❌ **Invalid**: `"SESSION_SECRET": "${{shared.SESSION_SECRET}}"` (breaks parsing)
- **NEVER use `${{shared.*}}` syntax** - not supported by Railway
- **NEVER hardcode connection strings** - they change between deployments
- Service names are case-sensitive: `Postgres` not `PostgreSQL`

### Common Railway Issues
- **Port validation**: Set `PORT=3030` explicitly for Remix apps
- **ClickHouse validation**: Set `CLICKHOUSE_URL=` (empty) or real cloud URL to bypass v4-beta validation bug  
- **Missing domains**: Run `railway domain` to generate public domain for service
- **Service creation**: Create separate webapp service, don't deploy to Redis/Postgres services
- **railway.json not applying**: Variables must exist before railway.json can reference them
- **Build failures**: Ensure `.env.example` exists and symlinks resolve correctly

### Railway Deployment Troubleshooting

#### Redis DNS Resolution Issues
**Problem:** `getaddrinfo ENOTFOUND redis.railway.internal` errors

**Root Cause:** Railway's internal DNS provides IPv6-only addresses, but ioredis defaults to IPv4-only DNS lookups.

**✅ SOLUTION IMPLEMENTED:** The `@internal/redis` package now includes `family: 0` in defaultOptions (internal-packages/redis/src/index.ts:12), which enables dual-stack IPv4/IPv6 DNS resolution for ALL Redis clients system-wide.

**What this fixes:**
- `engine:run-attempt-system:cache:` (RedisCacheStore)
- `engine:runqueue:`, `engine:worker:` (Run Engine systems)
- `schedule:schedule:` (ScheduleEngineWorker)
- All webapp Redis clients (MarQS, Socket.IO, workers, etc.)

**Architecture:** Railway internal DNS usage is CORRECT - all Redis communication should use `${{Redis.RAILWAY_PRIVATE_DOMAIN}}` for security and performance.

```typescript
// @internal/redis defaultOptions now includes:
const defaultOptions: Partial<RedisOptions> = {
  // ... other options
  family: 0, // Support both IPv4 and IPv6 (Railway internal DNS)
};
```

**If issues persist:**
```bash
# 1. Verify Redis service is running
railway service Redis
railway status

# 2. Check deployment includes latest @internal/redis fix
git log --oneline | grep "Fix Railway internal DNS resolution for all Redis clients"
```

**Deployment failing with "PORT must be integer":**
```bash
railway variables --set "PORT=3030"  # Remix apps need explicit port
```

**Environment variables not applying from railway.json:**
```bash
# Variables must exist first, then railway.json can reference them
railway variables --set "SESSION_SECRET=$(openssl rand -hex 16)"
railway variables --set "MAGIC_LINK_SECRET=$(openssl rand -hex 16)"
railway variables --set "ENCRYPTION_KEY=$(openssl rand -hex 16)"
railway variables --set "MANAGED_WORKER_SECRET=$(openssl rand -hex 16)"
```

**ClickHouse validation error:**
```bash
# v4-beta bug - either disable or use real instance
railway variables --set "CLICKHOUSE_URL="  # Empty to bypass
# OR
railway variables --set "CLICKHOUSE_URL=https://user:pass@host:8443"  # Real instance
```

**Missing public domain:**
```bash
railway domain  # Generates Railway-provided domain
```

**Database migration failures:**
```bash
# If migrations fail partway through, force schema sync
DATABASE_URL="<public_postgres_url>" npx prisma db push --schema=./internal-packages/database/prisma/schema.prisma --accept-data-loss

# Note: Use public Postgres endpoint for migrations if needed due to potential timeout issues
# Postgres: trolley.proxy.rlwy.net:14560
# Redis should always use internal DNS (DNS issues are now resolved)
```

## Redis Architecture

### Central Redis Client Factory
All Redis connections use the `@internal/redis` package's `createRedisClient` function, which provides:
- Automatic retry strategies
- IPv4/IPv6 dual-stack DNS support (`family: 0`)
- Consistent error handling and logging
- Environment-specific configuration

### Redis Connection Patterns
- **Main Redis client**: `apps/webapp/app/redis.server.ts` (webapp-specific with additional DNS logging)
- **Internal packages**: All use `@internal/redis` createRedisClient (cache, run-engine, workers)
- **Environment variables**: All inherit from base `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`

### Railway-Specific Configuration
- Uses Railway internal DNS: `${{Redis.RAILWAY_PRIVATE_DOMAIN}}`
- All server-side Redis communication (no client-side Redis connections exist)
- IPv6 DNS resolution handled automatically by `@internal/redis` defaultOptions

### Adding New Redis Clients
When adding new Redis connections, use the existing patterns:
```typescript
// For webapp-specific clients
import { createRedisClient } from "./redis.server";

// For internal packages  
import { createRedisClient } from "@internal/redis";
```

## Development Best Practices

- Use appropriate machine presets (micro to large-2x) based on resource needs
- Implement proper error handling and retry strategies
- Leverage metadata system for run progress tracking
- Use realtime features for UI updates
- Follow idempotency patterns for reliability