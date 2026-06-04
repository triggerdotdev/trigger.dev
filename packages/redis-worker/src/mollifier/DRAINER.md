# Mollifier — the drainer (Redis → Postgres)

Once runs are diverted into the Redis buffer (see [TRIP.md](./TRIP.md)), the
**drainer** pulls them back out and materialises a real run row in Postgres by
calling `engine.trigger()`. This doc covers the **egress** half: the rates and
sizes at which work transfers from Redis to Postgres, and how to tune them.

The drainer is a polling loop (`MollifierDrainer` in `drainer.ts`). It runs on the
webapp pods where `TRIGGER_MOLLIFIER_DRAINER_ENABLED=1` — usually a dedicated
worker, so its polling + engine load stays off the request-serving replicas. Note it
takes **both** flags: `TRIGGER_MOLLIFIER_ENABLED` is the master switch (with it off,
the drainer never constructs regardless of `DRAINER_ENABLED`), and `DRAINER_ENABLED`
selects which pods run the loop (defaulting to inherit `TRIGGER_MOLLIFIER_ENABLED`).

## The path

```
   Redis buffer                                                         Postgres
   ┌──────────────────────────────┐
   │ mollifier:queue:{envId} LISTs │
   │ (one FIFO per env, grouped    │
   │  under mollifier:orgs / -envs)│
   └───────────────┬──────────────┘
                   │
                   │  runOnce() — one tick
                   │  cadence: DRAIN_POLL_INTERVAL_MS (100ms) when a tick drains
                   │           nothing; back-to-back (no sleep) while a backlog exists
                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ SELECT WORK (fairness)                                         │
   │   • take ≤ DRAIN_MAX_ORGS_PER_TICK (500) orgs, round-robin     │
   │   • one env per org per tick, round-robin within the org       │
   │   • give each chosen env a budget of DRAIN_BATCH_SIZE (50) pops │
   │                                                                │
   │   per-tick ceiling = min(MAX_ORGS_PER_TICK, #orgs) × BATCH_SIZE│
   └───────────────────────────────┬────────────────────────────────┘
                                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ WORKER POOL                                                    │
   │   workers = min(DRAIN_CONCURRENCY (50), orgs × BATCH_SIZE)     │
   │   each worker loops: pick next env with budget → RPOP 1 (FIFO) │
   │                      → engine.trigger() ───────────────────────────────▶ INSERT run row
   │                      → buffer.ack()                            │           (materialised)
   └───────────────────────────────┬────────────────────────────────┘
                                   │
   ack → entry stays in Redis for ACK_GRACE_TTL_SECONDS (30s) as a read fallback
         while PG replica lag settles, then expires
                                   │
   retryable engine error  ───────▶ requeue, attempts++ (up to DRAIN_MAX_ATTEMPTS = 3
                                     total attempts, i.e. 2 requeues, then terminal)
   terminal / attempts spent ─────▶ write SYSTEM_FAILURE run row, drop the entry
   runOnce() Redis error   ───────▶ exponential backoff: base max(POLL_INTERVAL,
                                     BACKOFF_FLOOR 100ms) ×2 per error, capped at
                                     MAX_BACKOFF_MS (5000ms)
```

## How fast does it actually drain?

Two facts set the real ceiling:

1. **No idle sleep under load.** The loop only waits `DRAIN_POLL_INTERVAL_MS` when a
   tick drained *nothing*. With a backlog, ticks run back-to-back.
2. **`DRAIN_CONCURRENCY` bounds in-flight `engine.trigger()` calls.** The worker pool
   is capped at `DRAIN_CONCURRENCY`, and that's also the max entries in
   popped-but-not-yet-acked (DRAINING) state at any instant.

So the steady-state ceiling is:

```
throughput  ≈  DRAIN_CONCURRENCY  /  engine.trigger() latency
            =  50 / ~50ms  ≈  ~1000 runs/sec   (illustrative; PG-bound)
```

`DRAIN_BATCH_SIZE` and `DRAIN_MAX_ORGS_PER_TICK` do **not** raise this ceiling —
`DRAIN_CONCURRENCY` caps it. What they shape is **fairness and blast radius**:

- One env per org per tick means an org with 20 envs gets the same scheduling slot as
  an org with 1 — tenant fairness is by org count, not env count.
- `DRAIN_BATCH_SIZE` caps how many entries a single env can drain per tick, so one hot
  env can't monopolise the worker pool within a tick. A single-env backlog still uses
  the *full* `DRAIN_CONCURRENCY` (all workers pull from that one env).
- A crash mid-tick strands at most `DRAIN_CONCURRENCY` entries in DRAINING (recoverable
  by the stale sweep), not `MAX_ORGS_PER_TICK × BATCH_SIZE`.

## Levers (egress)

| Env var | Default | What it controls |
| --- | --- | --- |
| `TRIGGER_MOLLIFIER_DRAINER_ENABLED` | inherits `TRIGGER_MOLLIFIER_ENABLED` | Whether this pod runs the drain loop. Set `1` on the dedicated drainer, `0` elsewhere. |
| `TRIGGER_MOLLIFIER_DRAIN_CONCURRENCY` | `50` | **The throughput ceiling** — max parallel `engine.trigger()` calls (and max DRAINING entries). |
| `TRIGGER_MOLLIFIER_DRAIN_BATCH_SIZE` | `50` | Max pops per env per tick (fairness / blast-radius knob). |
| `TRIGGER_MOLLIFIER_DRAIN_MAX_ORGS_PER_TICK` | `500` | How many orgs a tick scans. |
| `TRIGGER_MOLLIFIER_DRAIN_POLL_INTERVAL_MS` | `100` | Tick gap **only when idle**; ignored under backlog. |
| `TRIGGER_MOLLIFIER_DRAIN_MAX_ATTEMPTS` | `3` | Total attempts on a retryable PG/engine error before SYSTEM_FAILURE (3 attempts = 2 requeues). |
| `TRIGGER_MOLLIFIER_DRAIN_MAX_BACKOFF_MS` | `5000` | Cap on the error backoff after consecutive `runOnce` failures. |
| `TRIGGER_MOLLIFIER_DRAIN_BACKOFF_FLOOR_MS` | `100` | Floor for the backoff base, so a tiny poll interval doesn't collapse it. |
| `TRIGGER_MOLLIFIER_ACK_GRACE_TTL_SECONDS` | `30` | How long an acked entry lingers in Redis as a read fallback before expiring. |
| `TRIGGER_MOLLIFIER_DRAIN_SHUTDOWN_TIMEOUT_MS` | `30000` | Grace window for in-flight handlers on SIGTERM. |
| `TRIGGER_MOLLIFIER_DRAIN_SHUTDOWN_MARGIN_MS` | `1000` | Required headroom below `GRACEFUL_SHUTDOWN_TIMEOUT`; boot fails loud if violated. |

The drainer's Redis client tuning (`TRIGGER_MOLLIFIER_REDIS_MAX_RETRIES_PER_REQUEST`,
`…_RECONNECT_STEP_MS`, `…_RECONNECT_MAX_MS`) is shared with the buffer client.

### Tuning throughput

- **Backlog growing / drainer falling behind**: raise `TRIGGER_MOLLIFIER_DRAIN_CONCURRENCY`
  first — it's the ceiling. Watch the `mollifier:draining` gauge and PG write load.
- **Protecting Postgres**: lower `TRIGGER_MOLLIFIER_DRAIN_CONCURRENCY`.
- **One big tenant starving others**: lower `TRIGGER_MOLLIFIER_DRAIN_BATCH_SIZE` (tightens
  per-env-per-tick fairness) or raise `TRIGGER_MOLLIFIER_DRAIN_MAX_ORGS_PER_TICK`.
- **Single-env backlog draining slowly**: raise `DRAIN_BATCH_SIZE` so that env can use
  more of the concurrency budget per tick.

A stale-entry sweep (separate loop, `TRIGGER_MOLLIFIER_STALE_SWEEP_*`) watches for
entries dwelling in the buffer too long — the early warning that the drainer can't
keep up before the ack-grace TTL would otherwise lose them.
