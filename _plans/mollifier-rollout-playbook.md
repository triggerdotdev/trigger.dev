# Mollifier rollout playbook (TRI-8654)

Operator procedure for turning the trigger-burst mollifier on across the
Trigger Cloud fleet. The mollifier sits in front of `engine.trigger` —
when a per-env trigger rate trips the configured threshold, requests are
written to a Redis buffer and replayed asynchronously by a drainer
worker. The customer gets a synthesised `mollifier.queued` response; the
buffered run materialises in Postgres once the drainer pops the entry.

This playbook reflects the controls that actually shipped on the
`mollifier-phase-2` / `mollifier-phase-3` PR series. The plan's original
design called for per-env keys in the global `FeatureFlag` table; the
shipped implementation uses **per-org JSON** (`Organization.featureFlags`)
to keep the trigger hot path free of an extra DB query. The functional
shape is the same; the granularity is org-level, not env-level.

---

## Knobs

| Control | Type | Effect when set |
|---|---|---|
| `TRIGGER_MOLLIFIER_ENABLED` | env | Master kill. `"0"` → gate never runs anywhere. `"1"` → gate consults per-org flag. |
| `TRIGGER_MOLLIFIER_SHADOW_MODE` | env | `"1"` + master on + org flag off → log `mollifier.would_mollify` on trip, **no** divert. `"0"` → live mode (divert when org flag is on). |
| `TRIGGER_MOLLIFIER_DRAINER_ENABLED` | env | Per-replica drainer switch. Unset inherits `TRIGGER_MOLLIFIER_ENABLED`. Set to `"0"` on every replica except the dedicated drainer service to avoid races; set to `"1"` (or leave unset) on the one replica that should run the polling loop. |
| `Organization.featureFlags.mollifierEnabled` | DB JSON | Per-org opt-in. `true` → divert this org's over-threshold triggers into the buffer. `false`/absent → pass through. |
| `TRIGGER_MOLLIFIER_TRIP_THRESHOLD` | env (default `100`) | Triggers per `TRIP_WINDOW_MS` per env before tripping. |
| `TRIGGER_MOLLIFIER_TRIP_WINDOW_MS` | env (default `200`) | Sliding-window length used for the trip rate. |
| `TRIGGER_MOLLIFIER_HOLD_MS` | env (default `500`) | How long a tripped env stays tripped after the last over-threshold trigger. |
| `TRIGGER_MOLLIFIER_ENTRY_TTL_S` | env (default `600`) | Buffer-entry TTL. Entries the drainer fails to drain within this window are dropped. |
| `TRIGGER_MOLLIFIER_DRAIN_CONCURRENCY` | env (default `50`) | Drainer's pLimit cap on in-flight replays. |
| `TRIGGER_MOLLIFIER_DRAIN_SHUTDOWN_TIMEOUT_MS` | env (default `30000`) | Must be ≥ 1s below `GRACEFUL_SHUTDOWN_TIMEOUT`. Validated at boot via `MollifierConfigurationError` — misconfig fails health-check loud. |

---

## Pre-rollout

- [ ] Phase-3 PR validation gates passed: read-fallback shape sanity (Task 4), mollify-produces-buffer-entries + synthesised responses (Task 9), drainer persists buffered runs into PG (Task 13), OTEL spans + notice field visible (Task 16), dashboard visual checks (Task 22), Aurora-impact stress test (Task 23).
- [ ] Axiom dashboards live: `mollifier.decisions{outcome}` (rate by `pass_through`/`shadow_log`/`mollify`), `mollifier.buffered`/`mollifier.drained` log volume, drainer `dwell_ms` p99.
- [ ] Alerts armed:
  - `mollifier.drained.dwell_ms` p99 > 2000ms (drainer is falling behind).
  - `mollifier.buffer_accept_failed` rate > 0 over 5min (Redis or buffer issue — fail-open means triggers still succeed, but the audit signal is lost).
  - `mollifier.drainer.misconfigured` (the boot-time `MollifierConfigurationError` we now throw on shutdown-timeout misconfig).
- [ ] `TRIGGER_MOLLIFIER_REDIS_*` env vars set in the target environment (test cloud first). Default falls back to `REDIS_*`; only override when running mollifier on a dedicated Redis cluster.
- [ ] `TRIGGER_MOLLIFIER_DRAINER_ENABLED` explicitly set to `"0"` on every non-drainer service; `"1"` (or unset to inherit) on exactly one replica.

---

## Test cloud

1. Deploy with `TRIGGER_MOLLIFIER_ENABLED=1`, `TRIGGER_MOLLIFIER_SHADOW_MODE=1`. Master on, shadow active, no org flags set — every trigger evaluates the rate counter but nothing diverts.
2. Watch `mollifier.would_mollify` log volume for 24h. Threshold/window defaults should produce signal proportional to known burst events (TRI-8654-style fan-outs). If `would_mollify` fires constantly under steady load → threshold too low. If it never fires under known bursts → too high.
3. Once thresholds look right, flip one internal test org to live: `UPDATE "Organization" SET "featureFlags" = jsonb_set(COALESCE("featureFlags", '{}'::jsonb), '{mollifierEnabled}', 'true'::jsonb) WHERE id = '<test-org-id>'`. No webapp restart — the gate reads the JSON per request.
4. Set `TRIGGER_MOLLIFIER_SHADOW_MODE=0` and restart. Burst the test org from `references/stress-tasks` (the `MOLLIFIER_E2E` example payload in `src/trigger/fanout.ts`).
5. Expected signals:
   - `mollifier.decisions{outcome="mollify"}` > 0 during the burst.
   - Synthesised responses returned to the trigger HTTP API include `notice.code = "mollifier.queued"`.
   - `mollifier.drained` log emits within `dwell_ms` p99 < 2s; matching `runId` between `mollifier.buffered`/`mollifier.drained` pairs.
   - The run-detail dashboard page renders the dismissible `MollifierBanner` until the drainer materialises the PG row.
   - No `FAILED` entries in the buffer.
   - `mollifier.buffer.oldest_age_ms` returns to 0 between bursts.
6. Leave running for 24h.

---

## Production — first customer

- [ ] Pick one of the orgs that triggered the original TRI-8654 incidents.
- [ ] Customer-comms judgement call: short note ("we're rolling out a burst-handling improvement") if the relationship benefits from a heads-up; otherwise rely on the synthesised `mollifier.queued` notice + dashboard banner being self-explanatory.
- [ ] Flip the org flag in prod: `UPDATE "Organization" SET "featureFlags" = jsonb_set(COALESCE("featureFlags", '{}'::jsonb), '{mollifierEnabled}', 'true'::jsonb) WHERE id = '<customer-org-id>'`.
- [ ] Observe for 24h: `mollifier.decisions{outcome="mollify",orgId="..."}`, drainer dwell p99, `mollifier.buffer.oldest_age_ms`. Spot-check the customer's run-list dashboard.
- [ ] Confirm with the customer (or via support channel) that nothing regressed.

---

## Production — expansion

- [ ] Enable for the remaining TRI-8654-correlated customers, org-by-org. 24h soak each.
- [ ] Decide global rollout vs. continuing selective. Defaults are conservative (threshold 100/200ms = ~500 triggers/sec/env before tripping) so a global flip should be safe, but the per-org pattern gives you a softer escalation curve.

---

## Kill switches

In escalating order of blast radius:

1. **Single-org off** — `UPDATE "Organization" SET "featureFlags" = "featureFlags" - 'mollifierEnabled' WHERE id = '<orgId>'`. Effect is immediate (gate reads per-request). The drainer continues flushing any residual buffered entries for that org.

2. **Back to shadow** — set `TRIGGER_MOLLIFIER_SHADOW_MODE=1` and restart. Org flags still trigger the mollify action; combine with #1 if you want to fully revert a single org while leaving observability on for everyone else.

3. **Hard global off** — set `TRIGGER_MOLLIFIER_ENABLED=0` and restart. Gate never runs; trip counter stops; drainer's `getMollifierDrainer()` returns null and the polling loop exits. Existing buffer entries TTL out at `TRIGGER_MOLLIFIER_ENTRY_TTL_S` (default 600s = 10min).

4. **Redis cleanup** — only if entries are stuck and #3 isn't draining them: `redis-cli --scan --pattern 'mollifier:*' | xargs redis-cli DEL`. Safe in this design because no customer state depends on these keys — every buffered trigger's canonical state is either in Postgres (already drained) or in the buffer entry (will TTL out). Drop entries → at-worst-once delivery for those triggers, which is the same guarantee as a process crash.

State matrix:

| `TRIGGER_MOLLIFIER_ENABLED` | `mollifierEnabled` (per-org) | `TRIGGER_MOLLIFIER_DRAINER_ENABLED` | meaning |
|---|---|---|---|
| `1` | `true` | `1` | Normal Phase 2: divert on trip, drainer materialises. |
| `1` | `true` | `0` | Degraded: triggers go to buffer, nothing drains. Buffer grows until TTL. Use briefly during drainer-specific incident. |
| `1` | `false` / absent | `1` | Pass-through for this org; drainer flushes any residue from a previous live window. |
| `1` | — | `0` (everywhere) | Buffer fills, nothing drains, entries TTL out. |
| `0` | — | — | Mollifier fully off. Pre-rollout behaviour. |
