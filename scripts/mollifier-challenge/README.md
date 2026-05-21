# Mollifier Challenge Suite

Manual scenario probes for the mollifier API-parity work. Each script tests
one concrete behaviour that a customer SDK would hit. Designed to be run by
hand against a local webapp with the mollifier flipped on.

## Prerequisites

Webapp running locally with:

```bash
TRIGGER_MOLLIFIER_ENABLED=1 \
TRIGGER_MOLLIFIER_TRIP_THRESHOLD=2 \
TRIGGER_MOLLIFIER_TRIP_WINDOW_MS=2000 \
TRIGGER_MOLLIFIER_HOLD_MS=10000 \
TRIGGER_MOLLIFIER_DRAINER_ENABLED=0 \
pnpm run dev --filter webapp
```

A seeded org with `featureFlags.mollifierEnabled = true`, and an API key.

## Common environment

```bash
export API_BASE=http://localhost:3030
export API_KEY=tr_dev_…
export ENV_ID=…          # optional, used by some scripts for Redis introspection
export TASK_ID=hello-world
```

## Scripts

| # | Script | Drainer | What it checks |
|---|---|---|---|
| 01 | `01-burst-baseline.sh` | OFF | Fire a burst, capture a buffered runId, sanity-check the response shape. The setup probe — all later scripts assume this works. |
| 02 | `02-reads-on-buffered.sh` | OFF | Each read endpoint (`retrieve`, `trace`, `events`, `attempts`, `metadata`, `result`) returns the right shape on a buffered run. |
| 03 | `03-mutations-on-buffered.sh` | OFF | Each mutation (`tags`, `metadata-put`, `reschedule`, `cancel`) lands on the snapshot — verified by a follow-up read. |
| 04 | `04-idempotency-collision.sh` | OFF | Two triggers with the same idempotencyKey in a burst return the same runId. |
| 05 | `05-drainer-roundtrip.sh` | ON | Pre-mutate a buffered run with tags + metadata. Toggle drainer on. Verify the materialised PG row carries the mutations. |
| 06 | `06-cancel-bifurcation.sh` | ON | Cancel a buffered run, drain, verify the PG row lands in `CANCELED` state with `runCancelled` event side effects. |
| 07 | `07-replay-buffered.sh` | OFF | Replay a buffered run produces a fresh PG run; the original buffered entry is untouched. |
| 08 | `08-listing-merge.sh` | OFF | Buffered runs appear in `/api/v1/runs` listings with correct createdAt ordering and pagination across the buffer/PG boundary. |
| 09 | `09-concurrent-metadata.sh` | OFF | 50 concurrent `metadata.increment` calls against one buffered run land all 50 deltas (CAS retry loop). |
| 10 | `10-idempotency-reset.sh` | OFF | `POST /api/v1/idempotencyKeys/{key}/reset` clears the key in both stores; re-trigger produces a fresh runId. |
| 11 | `11-parent-metadata-operations.sh` | OFF | `body.parentOperations` on a buffered child fans out to the PG parent run via the existing service. |
| 12 | `12-state3-replay.sh` | OFF + redis-cli | Direct Redis HSET status=FAILED to manufacture state 3 (Q2). Replay still produces a fresh run. |
| 13 | `13-resume-parent-guard.sh` | OFF | triggerAndWait with an idempotency key matching a buffered run produces a fresh PG run (B6b guard). |
| 14 | `14-dashboard-routes.sh` | OFF + session cookie | D1 cancel, D2 replay, D3 idempotencyKey reset via the `/resources/...` dashboard routes (session-cookie auth). |

**Toggling the drainer:** restart the webapp with `TRIGGER_MOLLIFIER_DRAINER_ENABLED=1`
for scripts that need it. Scripts 05 and 06 are the only ones that need it ON.

**Script 12 prerequisites:** sets `REDIS_CLI` env var, or has `redis-cli` on PATH,
or a docker container named `redis` reachable via `docker exec`.

**Script 14 prerequisites:** session-cookie value (the `__session` cookie from a
logged-in browser) plus org/project/env slugs. Easiest way: navigate to `/login`
in a browser, complete the magic-link with `local@trigger.dev`, then read
`document.cookie` in DevTools. Or use the Playwright MCP to script it.

```bash
export SESSION_COOKIE='…'
export ORG_SLUG='references-…'
export PROJECT_SLUG='hello-world-…'
export ENV_SLUG='dev'
./scripts/mollifier-challenge/14-dashboard-routes.sh
```

## Deliberately not covered

These behaviours exist in the implementation but aren't covered by the bash
suite. They're documented here so future readers know what's checked elsewhere
vs what's genuinely uncovered.

- **`mutateWithFallback` "busy" wait-and-bounce path.** Triggers only when an
  entry is in DRAINING state — racy from bash since only the drainer can flip
  the status. Covered by unit tests in `apps/webapp/test/mollifierMutateWithFallback.test.ts`.
- **Buffer outage / fail-open.** Stopping Redis takes down the run engine,
  queue, and locks too — the system can't function for a meaningful end-to-end
  scenario. Covered by unit tests that pass a buffer that throws.
- **Forward-compat rolling-update skew.** Old-drainer / new-API and vice versa
  simulations require running two webapp versions side-by-side. Out of scope
  for a single-process local probe; would be a CI matrix or a manual two-version
  test.
- **F2 CI invocation of this suite.** The team chose not to wire the bash suite
  into GitHub Actions — it stays a local diagnostic. CI runs the vitest
  unit tests instead.

## Output convention

Each script prints colour-coded `✓` / `✗` lines and exits 0 on full success,
1 on any failure. Verbose mode: `VERBOSE=1 ./scripts/mollifier-challenge/XX-*.sh`.

## Sanity check before running

```bash
curl -s "$API_BASE/healthcheck"
```

Should respond. If not, the webapp isn't up.
