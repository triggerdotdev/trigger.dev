# Mollifier Ops Manual

The mollifier is a Redis-backed buffer that sits in front of the Postgres
trigger-task path. When the per-env trigger rate exceeds the configured
threshold, the gate diverts the trigger into a Redis ZSET; a drainer
later materialises the buffered entry as a real PG `TaskRun` via
`engine.trigger`. This document covers what to watch, how to recognise
each failure mode, and how to recover.

## Architecture at a glance

```
client.trigger()
   |
   v
triggerTask.server.ts ── traceEventConcern.traceRun (writes run span to ClickHouse)
   |                          |
   |     gate evaluates per-env rate
   |          |
   |   ┌──────┴───────┐
   |   |              |
   |  PASS         MOLLIFY
   |   |              |
   |  engine.trigger  mollifier:queue:<envId>  (ZSET, score = createdAtMicros)
   |  → PG TaskRun    mollifier:entries:<runId> (hash, snapshot payload)
   v
   PG TaskRun + Electric stream + dashboard
                                ^
                                |
                                mollifier drainer (when buffered)
                                  - pops oldest entry from ZSET
                                  - calls engine.trigger with snapshot
                                  - writes PG TaskRun
```

Key flag: `TRIGGER_MOLLIFIER_ENABLED=1` turns the whole system on. With it
off the gate short-circuits and every trigger goes straight to PG.

## Key Redis keys

| Key pattern | Type | Purpose |
|---|---|---|
| `mollifier:queue:<envId>` | ZSET | Per-env queue. Score is `createdAtMicros`. Member is the runId. |
| `mollifier:entries:<runId>` | HASH | Snapshot payload + metadata for one buffered run. |
| `mollifier:orgs` | SET | Tracks orgs with non-empty buffers (for drainer fairness). |
| `mollifier:envs:<orgId>` | SET | Tracks envs with non-empty buffers under each org. |
| `mollifier:idempotency:<envId>:<taskId>:<key>` | STRING | SETNX for buffered-window idempotency dedup. |

The drainer pops `(orgId, envId)` pairs fairly, pulls oldest member from
the env queue, reads the snapshot hash, and replays it. On success it
deletes the hash and the ZSET member; on retryable error it requeues.

## Metrics

### Alertable signals

| Metric | Type | Labels | Alert pattern |
|---|---|---|---|
| `mollifier.stale_entries.current` | Gauge | `envId` | `> 0 for 5m` — drainer is offline or falling behind |
| `mollifier.realtime_subscriptions.buffered` | Counter | `envId` | rate climbing — many customers hitting the buffered-window |

### Diagnostic signals

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `mollifier.decisions` | Counter | `outcome` (`pass_through`, `mollify`, `shadow_log`), `reason` (e.g. `per_env_rate`) | Gate decisions over time |
| `mollifier.stale_entries` | Counter | `envId` | Per-sweep stale-entry events. **Not directly alertable** — see `…current` gauge instead |

The gate-decisions counter is the primary throughput view: when the
mollifier is doing its job the `mollify` slice climbs in lockstep with
the trigger burst.

### Structured logs

| Message | Level | Fields |
|---|---|---|
| `mollifier.buffered` | info | `runId`, `envId`, `orgId`, `taskId`, `reason` |
| `mollifier.stale_entry` | warn | `runId`, `envId`, `orgId`, `dwellMs`, `staleThresholdMs` |
| `mollifier.realtime.buffered_subscription` | info | `runId`, `envId`, `bufferDwellMs` |

The stale-entry log emits **one line per stale entry per sweep tick**.
A single stuck entry will emit ~once every `TRIGGER_MOLLIFIER_STALE_SWEEP_INTERVAL_MS`
(default 5min) until it drains. For alert routing, prefer the gauge.

## Configuration

The mollifier-related env vars live in `apps/webapp/app/env.server.ts`.
Defaults are tuned for production; tune below for incident response.

| Var | Default | Purpose |
|---|---|---|
| `TRIGGER_MOLLIFIER_ENABLED` | `0` | Master switch |
| `TRIGGER_MOLLIFIER_DRAINER_ENABLED` | inherits | Which replicas run the drainer loop. Set to `1` on dedicated drainer replicas only in multi-replica deployments |
| `TRIGGER_MOLLIFIER_TRIP_WINDOW_MS` | `200` | Sliding window for per-env trigger rate |
| `TRIGGER_MOLLIFIER_TRIP_THRESHOLD` | `100` | Trigger count that trips the gate within the window |
| `TRIGGER_MOLLIFIER_HOLD_MS` | `500` | How long the gate stays tripped once it's tripped |
| `TRIGGER_MOLLIFIER_DRAIN_CONCURRENCY` | `50` | Parallel drains per replica |
| `TRIGGER_MOLLIFIER_DRAIN_MAX_ATTEMPTS` | `3` | Retries before terminal failure → `SYSTEM_FAILURE` PG row |
| `TRIGGER_MOLLIFIER_STALE_SWEEP_ENABLED` | inherits | Run the alerting sweep |
| `TRIGGER_MOLLIFIER_STALE_SWEEP_INTERVAL_MS` | `300_000` | Sweep cadence |
| `TRIGGER_MOLLIFIER_STALE_SWEEP_THRESHOLD_MS` | (unset) | Dwell threshold. Defaults to half of `entryTtlSeconds` when unset |

## Failure modes & recovery

### Drainer is stopped / falling behind

**Signal**: `mollifier_stale_entries_current{envId=...} > 0 for 5m`
plus `mollifier.stale_entry` warn logs.

**Triage**:
1. Check drainer health on each replica — is the polling loop running?
   `grep "Initializing mollifier drainer"` near boot logs; recent
   `recordRunDebugLog` entries from `mollifier.drained` spans in
   Axiom.
2. Check Redis reachability from the drainer replica.
3. Check `TRIGGER_MOLLIFIER_DRAINER_ENABLED` — accidentally turned off?

**Recovery**: bring the drainer back up. It will drain the backlog at
`TRIGGER_MOLLIFIER_DRAIN_CONCURRENCY` per replica. The gauge clears as
each env's stale count drops to 0.

### Buffer growing in Redis

**Signal**: Redis memory pressure alerts (separate from mollifier).

**Triage**:
```sh
redis-cli ZCARD "mollifier:queue:<envId>"   # depth for one env
redis-cli SCARD "mollifier:orgs"            # orgs with non-empty buffers
```

**Recovery**: drainer pickup is the only mechanism that removes entries.
If Redis is about to OOM, the safest option is to scale up the drainer
replica count temporarily (raise `TRIGGER_MOLLIFIER_DRAIN_CONCURRENCY`
or add replicas).

### Terminal drainer failure on a non-retryable error

**Signal**: `SYSTEM_FAILURE` PG rows with `error.raw` matching
`Mollifier drainer terminal failure: …`. Existing alerts pipeline picks
these up via `runFailed`.

**Triage**: the snapshot was structurally valid enough to reach
`engine.trigger`, but engine.trigger threw a non-retryable error
(schema drift, version-locked-task race, etc.). The drainer writes the
SYSTEM_FAILURE row via `engine.createFailedTaskRun` so the customer
sees the run in their dashboard rather than nothing.

**Recovery**: case-by-case. Read the error message in the SYSTEM_FAILURE
row; fix the underlying issue.

### Cancel-before-PG (Q4 bifurcation)

A customer cancelling a buffered run patches the snapshot with
`cancelledAt` + `cancelReason`. When the drainer next picks it up, it
takes the cancel-bifurcation path: writes a `CANCELED` PG row via
`engine.createCancelledRun` instead of triggering. Electric streams the
INSERT to `useRealtimeRun` subscribers.

If the drainer is offline, the snapshot just sits in Redis with
`cancelledAt` set. The customer's API cancel call already returned
success (synthesised from the snapshot), but the realtime hook stays
unpopulated until the drainer materialises the row.

### Realtime subscription opened during the buffered window

`useRealtimeRun(bufferedRunId)` keeps the Electric subscription open
against `WHERE id=<id>` even though no PG row exists yet. Each initial
subscription increments `mollifier.realtime_subscriptions.buffered` and
logs `mollifier.realtime.buffered_subscription`. When the drainer
INSERTs the PG row, Electric streams it to the client.

This is normal behaviour — only worth investigating if the counter
climbs disproportionately to the gate's `mollify` outcomes (suggests
customers are subscribing inside the buffered window faster than the
drainer can materialise).

## Manual buffer inspection

```sh
# Latest member of an env's queue (newest first by score)
redis-cli -p 6379 ZRANGE "mollifier:queue:<envId>" -1 -1 WITHSCORES

# Full payload for one buffered run
redis-cli -p 6379 HGETALL "mollifier:entries:<runId>"

# Depth per env
for k in $(redis-cli -p 6379 --scan --pattern 'mollifier:queue:*'); do
  echo "$k $(redis-cli -p 6379 ZCARD $k)"
done

# Orgs with non-empty buffers
redis-cli -p 6379 SMEMBERS "mollifier:orgs"
```

A phantom ZSET member (`ZSCORE` returns a value but the entry hash is
empty) used to be possible when entry-hash TTLs expired ahead of the
queue ZSET. The entry TTL has since been removed; entries persist
until the drainer ACKs them. If you see a phantom in prod, that
indicates a real bug — investigate before manually `ZREM`-ing.

## Related code

- Drainer loop: `internal-packages/redis-worker/src/mollifier/drainer.ts`
- Drainer handler: `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`
- Gate: `apps/webapp/app/v3/mollifier/mollifierGate.server.ts`
- Mollify (write to buffer): `apps/webapp/app/v3/mollifier/mollifierMollify.server.ts`
- Sweep: `apps/webapp/app/v3/mollifier/mollifierStaleSweep.server.ts`
- Telemetry: `apps/webapp/app/v3/mollifier/mollifierTelemetry.server.ts`
- Realtime buffered-fallback: `apps/webapp/app/routes/realtime.v1.runs.$runId.ts`
- Test helpers: `apps/webapp/test/mollifier*.test.ts`
