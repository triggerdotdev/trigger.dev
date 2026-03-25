# Run Engine 2.0

Core run lifecycle management system (`@internal/run-engine`). This is where ALL new run lifecycle logic should go - not in `apps/webapp/app/v3/services/` directly.

## Architecture

The `RunEngine` class (`src/engine/index.ts`) orchestrates modular systems:

### Systems (`src/engine/systems/`)

Each system handles one concern:
- **BatchSystem**: Batch trigger processing with DRR (Deficit Round Robin)
- **CheckpointSystem**: Execution checkpoints for recovery
- **DebounceSystem**: Configurable debouncing with delay
- **DelayedRunSystem**: TTL-based delayed execution
- **DequeueSystem**: Pulls runs from queue, assigns to workers
- **EnqueueSystem**: Adds runs to queue with ordering
- **ExecutionSnapshotSystem**: Stores/restores run state for warm restarts
- **PendingVersionSystem**: Version management for deployments
- **RunAttemptSystem**: Individual execution attempts (retries, heartbeats)
- **TTLSystem**: Automatic run expiration
- **WaitpointSystem**: Synchronization primitive for waiting between tasks

### Queue and Locking

- **RunQueue** (`src/run-queue/`): Redis-backed fair queue with concurrency management
- **BatchQueue** (`src/batch-queue/`): Batch processing queue
- **RunLocker** (`src/locking.ts`): Redis locks preventing concurrent run execution

## Key Design Patterns

- Event-driven via EventBus
- OpenTelemetry tracer/meter integration
- Redis for distributed locks and queues
- Prisma for persistence with read-only replica support (`readOnlyPrisma`)

## Testing

Tests live in `src/engine/tests/` and use testcontainers (Redis + PostgreSQL):

```bash
cd internal-packages/run-engine
pnpm run test ./src/engine/tests/ttl.test.ts --run
```

May need to build dependencies first: `pnpm run build --filter @internal/run-engine`
