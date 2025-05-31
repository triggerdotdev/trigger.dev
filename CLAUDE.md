# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Initial Setup

```bash
pnpm i                                    # Install dependencies
cp .env.example .env                      # Create environment file
pnpm run docker                           # Start Docker services (Postgres, Redis, Clickhouse, Electric)
pnpm run db:migrate                       # Run database migrations
```

### Build Commands

```bash
pnpm run build --filter webapp && pnpm run build --filter trigger.dev && pnpm run build --filter @trigger.dev/sdk
pnpm run build --filter "@trigger.dev/*"  # Build all public packages
pnpm run typecheck                        # Type check all packages
```

### Development

```bash
pnpm run dev --filter webapp              # Start webapp development server (port 3030)
pnpm run dev --filter trigger.dev --filter "@trigger.dev/*"  # Watch CLI and packages for changes
```

### Testing

```bash
pnpm run test                             # Run all tests
pnpm run test --filter webapp              # Test webapp only
pnpm run test --filter "@trigger.dev/*"    # Test public packages
pnpm run test --filter @internal/run-engine   # Test internal packages
```

## Architecture Overview

### Monorepo Structure

- **Apps**: Production services (`webapp`, `supervisor`)
- **Packages**: Public npm packages (`@trigger.dev/sdk`, `trigger.dev` CLI, `@trigger.dev/core`)
- **Internal Packages**: Shared internal code (database, run-engine, redis, clickhouse, tracing)
- **References**: Testing and example projects (hello-world)

### Key Components

- **Webapp** (`apps/webapp`): Remix-based dashboard and API platform
- **Run Engine** (`internal-packages/run-engine`): Task execution lifecycle management
- **SDK** (`packages/trigger-sdk`): Main developer SDK (`@trigger.dev/sdk`)
- **CLI** (`packages/cli-v3`): Development and deployment tool (`trigger.dev`)
- **Database** (`internal-packages/database`): Prisma schema and client

### Build System

- **Turborepo** for build orchestration with dependency graph
- **TypeScript 5.5.4** across all packages
- **Vitest** for testing
- **PNPM 8.15.5** workspace with locked version

## Development Workflows

### Making Changes to SDK/CLI

1. Make changes in `packages/trigger-sdk` or `packages/cli-v3`
2. Run `pnpm run dev --filter trigger.dev --filter "@trigger.dev/*"` to watch for changes
3. Test in `references/v3-catalog` using `pnpm exec trigger dev`
4. Restart trigger dev command to pick up CLI/SDK changes

### Database Migrations

1. Modify `internal-packages/database/prisma/schema.prisma`
2. `cd internal-packages/database`
3. `pnpm run db:migrate:dev:create` (creates migration file)
4. `pnpm run db:migrate:deploy && pnpm run generate`

### Adding Changesets

```bash
pnpm run changeset:add                    # Add changeset for version management
```

### Testing Strategy

- Unit tests with Vitest
- Integration tests using testcontainers
- E2E tests with Playwright
- Manual testing via reference projects

## Special Requirements

### Prerequisites

- Node.js 20.11.1 (enforced via .nvmrc)
- pnpm 8.15.5 (via corepack enable)
- Docker for local services
- Protocol Buffers for gRPC

### Environment Variables

- `ENCRYPTION_KEY`: Generate with `openssl rand -hex 16`
- Database runs on Docker at localhost:5432
- Webapp runs on port 3030

## Package Dependencies

- Internal packages use `workspace:*` protocol
- Shared TypeScript config and tooling
- Patches in `patches/` directory for external dependencies
- Build outputs cached by Turborepo
