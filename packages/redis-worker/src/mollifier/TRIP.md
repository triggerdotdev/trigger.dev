# Mollifier — the trip (how runs enter the buffer)

The mollifier is a **burst buffer** in front of Postgres. When a single environment
triggers runs faster than a threshold, new triggers are *diverted* ("mollified")
into a Redis buffer and acknowledged to the SDK immediately, instead of writing a
run row to Postgres synchronously. A separate process drains the buffer back into
Postgres at a controlled rate — see [DRAINER.md](./DRAINER.md).

This doc covers the **ingress** half: what trips mollification and how a run lands
in the buffer. Every lever below is an env var read on the webapp side; the actual
rate counter is a Lua script in `buffer.ts` (`mollifierEvaluateTrip`).

## The path

```
                         every trigger call
                                │
                                ▼
                 ┌───────────────────────────┐
                 │ mollifier gate (per call)  │   apps/webapp/.../mollifierGate.server.ts
                 │ enabled? bypass? trip?     │
                 └─────────────┬─────────────┘
                               │
          ┌────────────────────┼─────────────────────┐
          │                    │                     │
      OFF / bypass          not tripped              tripped
          │                    │              (rate exceeded within
          ▼                    ▼               the last HOLD_MS)
   ┌────────────┐       ┌────────────┐               │
   │ normal PG  │       │ normal PG  │               ▼
   │  trigger   │       │  trigger   │      ┌──────────────────────┐    200 OK
   │ (write run)│       │(pass-thru) │      │  buffer.accept()      │ ─────────────────▶ SDK
   └────────────┘       └────────────┘      │  snapshot → Redis     │    (immediate, no PG)
                                             └──────────┬───────────┘
                                                        ▼
                                          ┌──────────────────────────────┐
                                          │ Redis buffer                  │
                                          │  entries  mollifier:entries:{runId}  (hash)
                                          │  queues   mollifier:queue:{envId}    (LIST, FIFO)
                                          │  index    mollifier:orgs / org-envs  (SETs)
                                          └──────────────┬───────────────┘
                                                         │
                                                         ▼   drained back to Postgres
                                                   see DRAINER.md
```

## What trips a divert

The trip decision is a **per-environment fixed-window rate counter** in Redis,
shared across all webapp replicas (so the threshold is fleet-wide, not per-pod):

```
INCR mollifier:rate:{envId}                         -- once per trigger
if count == 1:  PEXPIRE key  TRIP_WINDOW_MS          -- start the window
if count > TRIP_THRESHOLD:  set mollifier:tripped:{envId} for HOLD_MS
divert  ⇔  mollifier:tripped:{envId} exists
```

So: once an env exceeds `TRIP_THRESHOLD` triggers within a `TRIP_WINDOW_MS` window,
the `tripped` key is set and **every** trigger for that env is diverted for the next
`HOLD_MS` — regardless of that individual trigger's own count. The divert decision is
"does the `tripped` key exist?", not a per-trigger threshold comparison.

The gate is **fail-open**: any Redis error during evaluation falls through to the
normal Postgres trigger path. Some triggers always bypass the gate regardless of
rate: `debounce`, one-time-use tokens, and a single `triggerAndWait`.

## Levers (ingress)

| Env var | Default | What it controls |
| --- | --- | --- |
| `TRIGGER_MOLLIFIER_ENABLED` | `0` | Master kill switch. `0` = every trigger goes straight to PG. |
| `Organization.featureFlags.mollifierEnabled` | — | Per-org opt-in (DB JSON, not an env var). Lets you stage the rollout org-by-org. |
| `TRIGGER_MOLLIFIER_SHADOW_MODE` | `0` | Evaluate the trip and log "would mollify" but **never divert**. For observing trip rates before turning it on. (Still increments the Redis rate counter — it's observation-only at the trigger level, not side-effect-free in Redis.) |
| `TRIGGER_MOLLIFIER_TRIP_WINDOW_MS` | `200` | Width of the rate-counter window. |
| `TRIGGER_MOLLIFIER_TRIP_THRESHOLD` | `100` | Triggers-per-window an env may do before diverting. Raise to mollify less often. |
| `TRIGGER_MOLLIFIER_HOLD_MS` | `500` | How long diverting stays on after the threshold is crossed. |

Default behaviour: an env diverts once it exceeds **~100 triggers per 200 ms**, and
keeps diverting for 500 ms after.

### Tuning the trip

- **Mollifying too aggressively** (diverting normal traffic): raise
  `TRIGGER_MOLLIFIER_TRIP_THRESHOLD`, or widen `TRIGGER_MOLLIFIER_TRIP_WINDOW_MS`.
- **Not catching bursts**: lower the threshold or shorten the window.
- **Flapping** (rapid on/off at the boundary): raise `TRIGGER_MOLLIFIER_HOLD_MS` so a
  burst stays diverted instead of toggling each window.

Note the window is *fixed*, not sliding: two adjacent windows can briefly admit up to
~2× the threshold before the counter resets.

## Idempotency claim (same-key bursts)

Triggers carrying an idempotency key serialise through a pre-gate Redis claim so a
burst of duplicates resolves to one run instead of N buffered entries. Its levers:

| Env var | Default | What it controls |
| --- | --- | --- |
| `TRIGGER_MOLLIFIER_CLAIM_TTL_SECONDS` | `30` | Claim-slot lock TTL (also the upper clamp on the customer-derived TTL). Auto-expires if a claimant crashes. |
| `TRIGGER_MOLLIFIER_CLAIM_WAIT_MS` | `5000` | How long a second caller waits for the first to resolve before giving up. |
| `TRIGGER_MOLLIFIER_CLAIM_POLL_MS` | `25` | Poll interval while waiting. |

The claim only guards the in-flight slot (it is not the dedup window). Its actual TTL
is `min(TRIGGER_MOLLIFIER_CLAIM_TTL_SECONDS, customer idempotency-key remaining lifetime)`,
so the env var is the **upper bound** — a shorter customer expiry clamps it down, but it
can never extend past the env var.
