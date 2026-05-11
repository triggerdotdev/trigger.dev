# Stress-tasks — example payloads

Copy any of these into the dashboard test UI (Tasks → pick the task → Test).
The trigger.dev test UI defaults to the most recent run's payload, so once
you've fired a particular shape once, it'll be remembered.

## `stress-fan-out-trigger` — N individual `.trigger()` calls in a single trace

Mirrors the production failure mode (events 1–10 in
`prisma-connection-investigation-results.md`) where one trace fans out N HTTP
triggers and exhausts the api-prod Prisma connection pool.

### Smoke test (use this first to confirm wiring)

```json
{ "count": 10 }
```

### Reproduce the prod fan-out — 1,000 all at once

```json
{ "count": 1000 }
```

### Bounded producer — only 100 in-flight at a time

```json
{ "count": 1000, "concurrency": 100 }
```

### Exercise the `runTags ||` row-lock contention path (events 3, 4, 5, 7)

```json
{ "count": 1000, "tags": ["stress-test", "burst-2026-05-08"] }
```

### Children doing real work — 500 triggers, 2 s child sleep, 200 in flight

```json
{ "count": 500, "concurrency": 200, "childSleepMs": 2000 }
```

### Large payloads — 200 triggers, 50 KB pad each

```json
{ "count": 200, "childPayloadBytes": 50000 }
```

### Combined contention — fan-out + tags + child work

```json
{ "count": 1000, "concurrency": 250, "childSleepMs": 500, "tags": ["combined"] }
```

---

## `stress-fan-out-batch` — N triggers via chunked `batchTrigger`

Different server-side code path: one HTTP request per chunk, server-side
bulk insert. Useful contrast for understanding whether pool pressure is
specific to the N-trigger path or surfaces here too.

### Smoke test

```json
{ "count": 10, "batchSize": 10 }
```

### Default — 1,000 across two sequential 500-payload batches

```json
{ "count": 1000 }
```

### Parallel batches — same volume, two batchTrigger calls in flight

```json
{ "count": 1000, "chunkConcurrency": 2 }
```

### Many small batches — 100 chunks of 10, sequential

```json
{ "count": 1000, "batchSize": 10 }
```

### Many small batches in parallel — 100 chunks of 10, 8 in flight

```json
{ "count": 1000, "batchSize": 10, "chunkConcurrency": 8 }
```

### With tags — exercise `runTags ||` contention via the batch path

```json
{ "count": 1000, "tags": ["stress-batch"] }
```

### Children doing real work

```json
{ "count": 500, "batchSize": 100, "chunkConcurrency": 5, "childSleepMs": 2000 }
```

---

## What to watch while these run

- **Axiom** (`['trigger-cloud-prod']` equivalent locally — wherever your local
  OTel goes): `prisma:engine:connection` span durations on `trigger-api-prod`
  / engine. Baseline is sub-millisecond; > 100 ms is the early signal.
- **Webapp logs**: P2024 ("Timed out fetching a new connection from the
  connection pool") and P1001 ("Can't reach database server") surfaces during
  the burst.
- **Postgres** (`docker exec database psql -U postgres -d postgres`):
  `SELECT count(*) FROM pg_stat_activity;` — connection count under load.
- **Run dashboard**: how many runs queued vs. executing vs. failed; the spread
  is what tells you whether the producer-side bottleneck (trigger plumbing)
  or the consumer-side bottleneck (worker concurrency) was hit first.
