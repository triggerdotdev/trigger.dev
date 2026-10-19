# Redis Worker

`@trigger.dev/redis-worker` - custom Redis-based background job system. This is the background job system for the webapp and run engine.

## Key Files

- `src/worker.ts` - Worker loop and job processing with concurrency control
- `src/queue.ts` - Redis-backed job queue abstraction
- `src/fair-queue/` - Fair dequeueing algorithm for queue selection

## Usage

Used by the webapp for background jobs (alerting, batch processing, common tasks) and by the run engine for TTL expiration and batch operations.

All background jobs in the webapp use redis-worker.

## Testing

Uses ioredis. Tests use testcontainers for Redis.
