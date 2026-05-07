# Redis Worker

`@trigger.dev/redis-worker` - custom Redis-based background job system. **This replaces graphile-worker/zodworker** for all new background job needs.

## Key Files

- `src/worker.ts` - Worker loop and job processing with concurrency control
- `src/queue.ts` - Redis-backed job queue abstraction
- `src/fair-queue/` - Fair dequeueing algorithm for queue selection

## Usage

Used by the webapp for background jobs (alerting, batch processing, common tasks) and by the run engine for TTL expiration and batch operations.

All new background jobs in the webapp should use redis-worker. Do NOT add new jobs to zodworker (`@internal/zodworker`) or graphile-worker.

## Testing

Uses ioredis. Tests use testcontainers for Redis.
