# Trigger Mollifier — Phase 2 Implementation Plan (Live Mollifier)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Naming note:** the file is named `phase-3` for internal sequencing (it follows two prior planning files), but the work it describes is publicly framed as **Phase 2**. All section headings, commit messages, server-changes notes, and rollout-playbook references use "Phase 2".

## What Phase 1 actually shipped (vs what this plan was written against)

Phase 1 evolved into a **controlled dual-write** rather than log-only shadow mode. Concretely:

- When the per-org `mollifierEnabled` feature flag is on AND the trip evaluator says divert, the call site (`apps/webapp/app/runEngine/services/triggerTask.server.ts`, mollify branch inside the `traceRun` callback) calls **`buffer.accept(canonicalPayload)` AND continues to `engine.trigger`**. The customer's run reaches Postgres via the existing path; the buffer entry is an audit/preview copy.
- The drainer's handler in `mollifierDrainer.server.ts` is a **no-op-ack with structured `mollifier.drained` log**. It does NOT replay through `engine.trigger`. Its purpose is to prove the dequeue mechanism works end-to-end without duplicating the run.
- The canonical payload shape (`BufferedTriggerPayload` in `apps/webapp/app/v3/mollifier/bufferedTriggerPayload.server.ts`) contains everything needed to reconstruct an equivalent `engine.trigger` input. Phase 3 may extend it.
- Structured logs `mollifier.buffered` (write) and `mollifier.drained` (consume) form the audit trail. Operators can join by `runId` against TaskRun lifecycle events to confirm "no data loss would have occurred if phase 3 were active during this window."
- Test-cloud rollout pattern: flip `mollifierEnabled` for one org at a time, observe `mollifier.buffered`/`mollifier.drained` log pair completeness, confirm the dequeue path is exercised under real traffic, then expand.

Phase 2 therefore swaps two specific things:

1. **Trigger call site** (`triggerTask.server.ts`): after `buffer.accept`, **return a synthesised `TriggerTaskServiceResult`** with the upfront-generated `runFriendlyId` INSTEAD OF continuing to `engine.trigger`. The customer no longer waits on the Postgres write — the run becomes visible via read-fallback until the drainer persists it.
2. **Drainer handler** (`mollifierDrainer.server.ts`): replace the no-op-ack with a function that deserialises `BufferedTriggerPayload` and calls `engine.trigger(...)` — without a second gate evaluation and without re-running the idempotency-key resolver (the key is already captured in the payload).

The buffer's `accept`, `pop`, `ack`, `requeue`, `fail`, `evaluateTrip`, idempotency guard, envs-set lifecycle, and orphan handling are already production-hardened in Phase 1 (40+ unit tests + 2 temporary fuzz suites under `*.fuzz.test.ts`). Phase 2 should not need to touch the buffer or drainer primitives.

**Goal:** Activate the mollifier end-to-end. When the gate decides to divert, the request's `engine.trigger()` input is snapshotted into the Redis buffer and the API returns a synthesised `TriggerTaskResponse` with the same `id` shape it would have today. The drainer replays from the buffer through `engine.trigger()` to persist the run. Read paths (`GET /api/v1/runs/...`, dashboard run-detail) fall back to the buffer for `QUEUED` synthesis when Postgres has no row yet. The dashboard renders a `QUEUED` "Recently queued" section and a dismissible banner on mollified run details. OTEL spans (`mollifier.queued`, `mollifier.drained`) emit on the caller's trace. Per-org gating uses the `Organization.featureFlags` JSON blob so we can toggle one customer at a time from the admin UI.

**Architecture:** The mollify code path constructs the same `engine.trigger()` input the pass-through path builds, serialises it as the buffer snapshot, calls `MollifierBuffer.accept()`, and returns a synthesised `TriggerTaskServiceResult` with a stub run carrying the upfront-generated `friendlyId`. The drainer's handler (currently `throw "phase 1: no handler wired"`) is replaced with a function that calls the webapp's `runEngine.trigger()` directly on the deserialised snapshot — no second gate evaluation, no idempotency re-check. Read-fallback (currently `return null` stub) reads the buffer hash, auth-checks against `envId`/`orgId`, and synthesises a run object that the existing presenter consumes unchanged.

**Tech Stack:** Same as phases 1–2.

**Source spec:** `/Users/dcs/Development/trigger.dev/_plans/trigger-mollifier-design.md` — sections "Buffer & drainer", "Read-path fallback & state surface", "Transparency surfaces", and "Feature flags & rollout > Phase 3" are load-bearing.

**Sibling briefs (load-bearing context for design concerns C1–C5 below):**
- `_plans/2026-05-13-mollifier-debounce-protection.md` — C1, debounce bypass.
- `_plans/2026-05-13-mollifier-otu-protection.md` — C3, OneTimeUseToken bypass.
- `_plans/2026-05-13-mollifier-trigger-and-wait-protection.md` — F4, `triggerAndWait` bypass.
- `_plans/2026-05-13-mollifier-electric-integration.md` — F1/F3, realtime / dashboard live-stream deferral.

**Engine scope:** Phase 2 only protects the V2 run engine path (`RunEngineTriggerTaskService.call`). The legacy V1 branch (`triggerTask.server.ts` callV1) doesn't go through `evaluateGate` and is out of scope. The TRI-8654 incident customers are all V2, so the scope limit is theoretical in practice — but document it.

---

## Design concerns

These are the load-bearing decisions made during the Phase 2 brainstorm. Every task below assumes these.

### C1 — Debounce

Skip mollifier on debounced triggers. Brief: `_plans/2026-05-13-mollifier-debounce-protection.md`.

Rationale: the dominant TRI-8654 burst is **non-debounced fan-out** (8 of 11 incidents). Debounce protection is a different optimisation path with non-trivial waitpoint semantics (`onDebounced` is a closure over webapp state and cannot be serialised into a buffer snapshot). Gate adds a one-line bypass:

```ts
if (options.debounce) return passThrough();
```

The bypass lives in `evaluateGate` so it short-circuits before any trip evaluation.

### C2 — Idempotency Redis index

A single Lua script does atomic claim + entry-accept in one round-trip. Returns `{ status: "fresh" | "claimed", runFriendlyId }`.

- On `claimed`: caller fetches the existing entry by `runFriendlyId` and builds a cache-hit response shape (same shape the existing idempotency path returns from Postgres).
- Redis claim value is **just the `runFriendlyId`** — no payload duplication. The entry hash is the single source of truth.
- **TTL coupling:** same Redis cluster, so claim TTL = entry TTL = `MOLLIFIER_BUFFER_TTL_SECONDS` (default 3600s — see O3). No TTL refresh on conflict; first claim wins.
- **Cleanup:** on terminal drain, the claim is deleted atomically alongside the entry's status transition (single cleanup Lua — see new task below).
- **Conflict response shape:** the same `readFallback` path covers both fresh mollified runs and cache-hit mollified runs — no second code path needed.

### C3 — OneTimeUseToken

Skip mollifier on OTU-bearing triggers. Brief: `_plans/2026-05-13-mollifier-otu-protection.md`.

Rationale: OTU is a security feature on the PUBLIC_JWT auth path, not a high-throughput pattern. The synchronous-rejection contract is materially worse to break than the idempotency-key cache-hit contract (an OTU consumed twice is a security regression; an idempotent payload run twice is a duplicate that customers already defend against). Gate adds:

```ts
if (options.oneTimeUseToken) return passThrough();
```

### C4 — Read-fallback + FAILED state durability

A new engine method `engine.recordBufferedRunFailure(payload, error)` writes a SYSTEM_FAILURE row to Postgres when the drainer hits a terminal failure. Single Prisma create, hydrated from the buffered payload, `friendlyId` reused. Idempotent via `friendlyId`-uniqueness + P2002 catch. **No alerting / realtime / webhook side effects** from this path (deliberately bypasses the normal run-lifecycle pipeline — those signals would be misleading for runs that never reached the engine).

Telemetry: `mollifier.drain_failed` structured log + `mollifier.drain_failures_total` counter, labelled by classified error reason.

**Race fix:** the entry is **NOT deleted** on terminal state — it stays as `DONE` / `FAILED` status until TTL. Postgres becomes durable truth; Redis is a redundant cache during the grace window. (Note: the idempotency **claim** is still deleted on terminal state per C2; only the entry hash is preserved.) Read order: Postgres → Redis fallback. No race re-check needed because Redis isn't deleted out from under callers.

### C5 — TaskRunStatus

Reuse `QUEUED` for buffered runs in synthesised responses.

- **No new `BUFFERED` enum value** — avoids a soft-breaking API change to SDK consumers parsing `TaskRunStatus`.
- **No `wasBuffered` Postgres column** — Aurora is the very thing this work is protecting; don't add columns under the same pressure window.
- Detection of "was this run buffered?" comes from OTel events (`mollifier.buffered`, `mollifier.drained` with `runFriendlyId` as a structured attribute).
- Acceptable trade: per-run "was buffered" is answerable only within the OTel retention window.

---

## Operational concerns

### O1 — Drainer concurrency

Two env vars:

- `MOLLIFIER_DRAIN_CONCURRENCY` — default 4, per webapp instance.
- `MOLLIFIER_DRAIN_PER_ENV_CONCURRENCY` — default 2, per env per instance.

With ~20 webapp instances in prod, total parallel `engine.trigger` calls = 80; sustained drain throughput ~2,600 calls/sec at engine.trigger's measured latency. Per-env cap prevents one noisy env from monopolising drain capacity. Implementation: round-robin per-env iteration in the drainer with an in-flight counter per env (new task below).

These are educated defaults; **expect to tune in prod**. First week's observability informs final tuning.

### O2 — Kill switches via per-env feature flags

Both gate and drain flags become **per-env** (not per-org, as Phase 1 used):

- `mollifierEnabled:{envId}` in the FeatureFlag table.
- `mollifierDrainEnabled:{envId}` in the FeatureFlag table.

Both default `true` once Phase 2 ships.

**Migration:** Phase 1's global `mollifierEnabled` key must be migrated to per-env keys via a one-time data migration that seeds every existing env with the current global value. Admin tooling provides bulk operations (kill drain everywhere, enable for canary cohort, etc.) by fanning out to per-env writes.

**Operator state matrix:**

| gate | drain | meaning |
| --- | --- | --- |
| true | true | normal Phase 2 |
| true | false | degraded — accepting works, nothing drains; buffer fills, entries TTL. Use briefly during a drain-specific incident. |
| false | true | safe — direct trigger; drainer flushes residual buffered entries. |
| false | false | full off; residual entries TTL out. |

### O3 — Buffer TTL

`MOLLIFIER_BUFFER_TTL_SECONDS` env var, default 3600 (1 hour, up from Phase 1's 600). Rationale:

- Drain catch-up after a sustained burst (drain-rate math handles even extreme bursts in seconds-to-minutes, so TTL is not the binding constraint).
- Operator pause-debug-resume during incident response (**this is the binding constraint**).
- Customer expectation of eventual processing within an hour.

Memory: worst-case bounded by Redis cluster size; realistic steady-state is small. No TTL refresh on drainer retry attempts.

### O4 — Metrics and alerting

**Counters:** `mollifier.decisions{outcome}`, `mollifier.buffer.accepts`, `mollifier.drain.successes`, `mollifier.drain.failures{reason}`, `mollifier.idem.cache_hits`.

**Gauges:** `mollifier.buffer.depth`, `mollifier.buffer.oldest_age_ms`, `mollifier.drain.in_flight`. `mollifier.buffer.oldest_age_ms` is the key alerting signal — computed by piggybacking the drainer's per-iteration scan, so no extra Redis budget.

**Histograms:** `mollifier.drain.latency_ms` (accept → terminal), `mollifier.buffer.entry_age_ms_at_pop`.

**Structured logs** (Axiom-bound, `envId` / `orgId` / `taskId` / `runFriendlyId` as structured fields): `mollifier.would_mollify`, `mollifier.buffered`, `mollifier.drained`, `mollifier.drain_failed`.

**Cardinality decision:** aggregate metrics (no `envId` label) go to the CloudWatch-style metrics pipeline. Axiom carries high-cardinality envId-scoped data via structured logs. Per-env queries go to Axiom, not metrics dashboards. **Exception:** `mollifier.buffer.oldest_age_ms` and `mollifier.buffer.depth` may carry `envId` as labels — they justify per-env breakdown for operations.

**Alerts — P1 (page on-call):**
- `mollifier.buffer.oldest_age_ms > 1,800,000` (30 min, half of TTL) for 1 min.
- `mollifier.drain.failures` rate > 5% of total drain attempts over 5 min.

**Alerts — P2 (notify, not page):**
- `mollifier.buffer.depth` growing monotonically for 10 min.
- `mollifier.idem.cache_hits` rate spike.

**Dashboard:** at least three panels in Axiom — decisions over time (passthrough vs mollify); buffer depth + oldest age (dual-axis); drain success vs failure with reason breakdown.

Alerts terminate at the **existing webapp on-call rotation** (not a dedicated mollifier rotation).

---

## API surface coverage for buffered runs

Every customer-facing API endpoint that takes a `runId` must transparently fall back to the Redis buffer if the row isn't in Postgres yet. **The mollifier is invisible from the API.**

**Shared resolver:** `resolveRunHandle(friendlyId) → { source: "postgres", run } | { source: "redis", entry } | { source: "not_found" }`. Postgres-first, Redis fallback on miss. Implemented once and reused across all endpoints.

### Read endpoints (synthesise from entry)

- `api.v3.runs.$runId` retrieve — Phase 1 `readFallback` foundation, extended.
- `api.v1.runs.$runParam.attempts` — empty array.
- `api.v1.runs.$runId.events` — empty array.
- `api.v1.runs.$runId.spans.$spanId` — 404.
- `api.v1.runs.$runId.trace` — synthesised stub trace, no children.
- `api.v1.runs.$runId.tags` (GET) — tags from buffered entry.
- `api.v1.runs.$runId.metadata` (GET) — metadata from buffered entry.

### Mutation endpoints (write to entry via Lua; drainer applies on replay)

- `api.v2.runs.$runParam.cancel` (F2) — Lua sets `cancelled=true` on entry. Drainer reads the cancellation flag on pop; if cancelled, calls new `engine.recordBufferedRunCancelled()` (sibling to `engine.recordBufferedRunFailure`) to write a CANCELED row.
- `api.v1.runs.$runId.tags` (PUT) — Lua updates the `tags` field on entry.
- `api.v1.runs.$runId.metadata` (PUT) — Lua updates the `metadata` field on entry.
- `api.v1.runs.$runParam.replay` — read payload from entry, call `trigger()` with a new `friendlyId` (same logic as Postgres-resolved replay).
- `api.v1.runs.$runParam.reschedule` — buffered runs aren't `DELAYED`; return 400 with the existing "not a scheduled run" message.

All mutations are **atomic via Lua** (entry-status check + field update in one script) so cannot race the drainer.

### Wait endpoints (simple long-poll in webapp request handler)

- `api.v1.runs.$runParam.result` (F4) — long-poll the resolver until the entry transitions to drained state (Postgres row exists OR entry status = `FAILED`/`CANCELED`), then forward to the existing waitpoint flow.
- `api.v1.runs.$runFriendlyId.input-streams.wait` — same long-poll mechanism.
- `api.v1.runs.$runFriendlyId.session-streams.wait` — same long-poll mechanism.

Long-poll is sufficient (not pub-sub) because `triggerAndWait` — the high-volume waiter — is skipped at the gate (see F4 below), so wait-endpoint traffic during buffered windows is low.

### List endpoint

`api.v1.runs` — UNION Postgres results with buffered Redis entries matching the filter. Status filters that include `QUEUED` must UNION; terminal-status filters are Postgres-only.

---

## Customer-facing concerns (F-scope)

### F1 — Realtime SDK streams

**Deferred.** Brief: `_plans/2026-05-13-mollifier-electric-integration.md`. Phase 2 customer-facing API endpoints (above) all work via the resolver; only the live-streaming surface degrades. Customer docs should note: *"During platform-imposed buffering windows, realtime streams may be temporarily silent."*

### F2 — Cancel

**In scope.** See "Mutation endpoints" above. Buffered cancel writes a flag on the entry; the drainer detects on pop and routes to `engine.recordBufferedRunCancelled`.

### F3 — Dashboard live updates

**Deferred.** Same brief as F1.

### F4 — `triggerAndWait`

**Skip at the gate.** Brief: `_plans/2026-05-13-mollifier-trigger-and-wait-protection.md`.

Rationale: the dominant TRI-8654 burst is `batchTriggerAndWait`, which is **already covered** by the mollifier — every batch path funnels through `TriggerTaskService.call()` per item. Single `triggerAndWait` fan-out outside the batch API is uncommon, so the gain from supporting it doesn't justify the cost at Phase 2. (See the brief for the corrected cost estimate — the SDK-level happy path actually works without engine surgery; the real costs are failure-propagation glue in the `recordBufferedRun*` helpers and worker-slot occupancy during buffered waits. Lower than originally framed, but still non-zero.) Gate adds:

```ts
if (options.parentTaskRunId && options.resumeParentOnCompletion) return passThrough();
```

The rump case (fire-and-forget customer who immediately polls `result()`) is handled by the long-poll wait endpoint above.

---

## Engine helpers (new)

Two new methods on the engine surface, both invoked from the drainer path:

- `engine.recordBufferedRunFailure(payload, error)` — C4. Terminal drain failure → write SYSTEM_FAILURE row.
- `engine.recordBufferedRunCancelled(payload)` — F2. Buffered cancellation → write CANCELED row.

Both:
- Single Prisma create, hydrated from the buffered payload.
- `friendlyId` reused from the buffered entry.
- Idempotent via `friendlyId`-uniqueness + P2002 catch.
- **Bypass normal trigger-lifecycle side effects** — no alerting, no realtime broadcast, no webhook. These rows represent runs that never reached the engine; the normal pipeline's assumptions don't hold.
- Tests required: terminal write, idempotent re-write, no side-effects, P2002 catch.

---

## Sidecar (not blocking Phase 2)

`apps/webapp/app/v3/services/batchTriggerV3.server.ts:109` defaults to `"parallel"` strategy, which is a known burst source. **Recommendation:** leave unchanged for Phase 2 (decision logged). Revisit only if telemetry shows a meaningful punch-through window at burst onset. This is a parallel decision, not a blocker.

---

## Preconditions (Phase 1 final state)

This plan assumes Phase 1 has landed. From `/Users/dcs/Development/trigger.dev/_plans/2026-05-11-trigger-mollifier-phase-2.md` "Phase 1 final state (contract for Phase 2)":

- `MollifierBuffer.evaluateTrip(envId, options)` returns `{ tripped, count }` atomically via Lua.
- `evaluateGate(inputs, evaluator)` calls `createRealTripEvaluator(...)` by default. `TripDecision` carries `count` and `threshold` on divert-true.
- `mollifier.decisions` counter wired via OTEL. `mollifier.would_mollify` structured log fires on `shadow_log`.
- Threshold defaults validated against the stress harness.
- `triggerTask.server.ts` calls `evaluateGate` before `traceEventConcern.traceRun`. The `mollify` branch throws — Phase 2 replaces this.
- `MollifierDrainer` singleton in `mollifierDrainer.server.ts` starts on first access when `MOLLIFIER_ENABLED=1`. Its handler throws — Phase 2 replaces this.
- `findRunByIdWithMollifierFallback(input)` exists at `readFallback.server.ts` and returns `null` — Phase 2 implements.

**If any of these is not true, stop and complete the prerequisite phase first.**

---

## File Structure

```
packages/redis-worker/                             # no changes — phase 1+2 primitives are sufficient

apps/webapp/app/v3/mollifier/
├── mollifierSnapshot.server.ts                    # CREATE: shared Snapshot type + serialise/deserialise
├── mollifierMollify.server.ts                     # CREATE: the divert execution path (buffer.accept + synthesised result)
├── mollifierMollify.test.ts                       # CREATE: unit tests for the mollify path
├── mollifierDrainerHandler.server.ts              # CREATE: engine.trigger replay handler + isRetryable
├── mollifierDrainerHandler.test.ts                # CREATE: tests for the handler
├── mollifierDrainer.server.ts                     # MODIFY: replace placeholder handler with the real one
├── readFallback.server.ts                         # MODIFY: implement (replace null stub)
├── readFallback.test.ts                           # CREATE: tests for fallback synthesis
├── mollifierGate.server.ts                        # MODIFY: per-env FeatureFlag keying + C1/C3/F4 bypasses (Task 17)
└── mollifierGate.test.ts                          # MODIFY: per-env + bypass tests (Task 17)

apps/webapp/app/runEngine/services/
└── triggerTask.server.ts                          # MODIFY: build engine.trigger input synchronously; wire mollify branch

apps/webapp/app/v3/presenters/                     # MODIFY (location TBD by grep — see Task 17)
└── <run retrieve presenter>.server.ts             # wire findRunByIdWithMollifierFallback into PG-miss path

apps/webapp/app/routes/
├── _app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam._index.tsx
│                                                  # MODIFY: wire fallback into loader; render banner on QUEUED runs sourced from buffer
└── _app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index.tsx
                                                   # MODIFY: add "Recently queued" section above paginated list

apps/webapp/app/components/runs/                   # CREATE (or modify if components exist)
├── MollifierBanner.tsx                            # CREATE: dismissible banner component
└── RecentlyQueuedSection.tsx                      # CREATE: "Recently queued" list component

packages/core/src/v3/schemas/
└── api.ts                                         # MODIFY: add optional notice field to TriggerTaskResponse

.changeset/
└── <generated>.md                                 # CREATE: patch changeset for @trigger.dev/core (additive schema field)

.server-changes/
└── mollifier-phase-3-live.md                      # CREATE: server-changes note

references/stress-tasks/src/trigger/
└── fanout.ts                                      # MODIFY: example payload + comment describing the live mode validation

_plans/
└── mollifier-rollout-playbook.md                  # CREATE: per-org rollout procedure
```

**Order of merge:** Phase 2 is intended as one PR. Internal task ordering means each task ends in a commit so the reviewer can step through.

---

## Task 1: Define the shared Snapshot type

The snapshot is the serialised form of the `engine.trigger()` input. Both the mollify path (writes the snapshot) and the drainer handler (deserialises and replays) need a stable type. Defining this once avoids drift.

**Files:**
- Create: `apps/webapp/app/v3/mollifier/mollifierSnapshot.server.ts`

- [ ] **Step 1: Grep for the trigger input type**

Run:
```bash
grep -n "this.engine.trigger" apps/webapp/app/runEngine/services/triggerTask.server.ts
grep -rn "TriggerOptions\|export.*TriggerParams\|trigger(\\s*params:" internal-packages/run-engine/src/engine/ 2>/dev/null | head -10
```
Note where the input type lives in `@internal/run-engine`. It's likely exported from the engine's index.

- [ ] **Step 2: Create the snapshot module**

Create `apps/webapp/app/v3/mollifier/mollifierSnapshot.server.ts`:

```ts
import { serialiseSnapshot, deserialiseSnapshot } from "@trigger.dev/redis-worker";

// MollifierSnapshot is the JSON-serialisable shape of the input that would be
// passed to engine.trigger(). The drainer deserialises and replays it.
// Kept as Record<string, unknown> at this layer — the engine.trigger call site
// casts it to the engine's typed input. This keeps the mollifier subdirectory
// from depending on @internal/run-engine internals.
export type MollifierSnapshot = Record<string, unknown>;

export function serialiseMollifierSnapshot(input: MollifierSnapshot): string {
  return serialiseSnapshot(input);
}

export function deserialiseMollifierSnapshot(serialised: string): MollifierSnapshot {
  return deserialiseSnapshot<MollifierSnapshot>(serialised);
}
```

- [ ] **Step 3: Run typecheck**

Run:
```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/webapp/app/v3/mollifier/mollifierSnapshot.server.ts
git commit -m "feat(webapp): MollifierSnapshot shared type for mollify + drainer"
```

---

## Task 2: Implement read-fallback (replace phase 1 stub) — failing tests first

**Design note (C4):** the entry is kept in Redis on terminal state (DONE / FAILED) until TTL — Postgres becomes durable truth; Redis is a redundant cache during the grace window. This task's tests assert that FAILED entries remain readable after the drainer transitions them. Read order is **Postgres → Redis fallback**, so callers see the Postgres row once it lands and the Redis copy only during the buffered window or after a terminal-fail write. No race re-check needed because Redis isn't deleted out from under callers.

**Files:**
- Create: `apps/webapp/app/v3/mollifier/readFallback.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/webapp/app/v3/mollifier/readFallback.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { findRunByIdWithMollifierFallback } from "./readFallback.server";
import type { MollifierBuffer, BufferEntry } from "@trigger.dev/redis-worker";

function fakeBuffer(entry: BufferEntry | null): MollifierBuffer {
  return {
    getEntry: vi.fn(async () => entry),
  } as unknown as MollifierBuffer;
}

const NOW = new Date("2026-05-11T12:00:00Z");

describe("findRunByIdWithMollifierFallback", () => {
  it("returns null when buffer is unavailable (mollifier disabled)", async () => {
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => null },
    );
    expect(result).toBeNull();
  });

  it("returns null when no buffer entry exists", async () => {
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(null) },
    );
    expect(result).toBeNull();
  });

  it("returns null when buffer entry envId does not match caller (auth mismatch)", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_OTHER",
      orgId: "org_1",
      payload: JSON.stringify({ taskIdentifier: "t" }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result).toBeNull();
  });

  it("returns synthesised QUEUED run when entry exists with matching auth", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({ taskIdentifier: "my-task" }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result).not.toBeNull();
    expect(result!.friendlyId).toBe("run_1");
    expect(result!.status).toBe("QUEUED");
    expect(result!.taskIdentifier).toBe("my-task");
    expect(result!.createdAt).toEqual(NOW);
  });

  it("returns synthesised QUEUED for DRAINING (internal state same externally)", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({ taskIdentifier: "t" }),
      status: "DRAINING",
      attempts: 1,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.status).toBe("QUEUED");
  });

  it("returns FAILED state with structured error for FAILED entries", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({ taskIdentifier: "t" }),
      status: "FAILED",
      attempts: 3,
      createdAt: NOW,
      lastError: { code: "VALIDATION", message: "task not found" },
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.status).toBe("FAILED");
    expect(result!.error).toEqual({ code: "VALIDATION", message: "task not found" });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:
```bash
pnpm --filter webapp test app/v3/mollifier/readFallback.test.ts
```
Expected: FAIL — current phase 1 stub returns `null` unconditionally and takes a different signature.

- [ ] **Step 3: Commit the failing tests**

```bash
git add apps/webapp/app/v3/mollifier/readFallback.test.ts
git commit -m "test(webapp): failing tests for mollifier read-fallback"
```

---

## Task 3: Implement the read-fallback helper

**Files:**
- Modify: `apps/webapp/app/v3/mollifier/readFallback.server.ts`

- [ ] **Step 1: Replace the stub**

Replace `apps/webapp/app/v3/mollifier/readFallback.server.ts` entirely with:

```ts
import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import { deserialiseMollifierSnapshot } from "./mollifierSnapshot.server";

export type ReadFallbackInput = {
  runId: string;
  environmentId: string;
  organizationId: string;
};

export type SyntheticRun = {
  friendlyId: string;
  status: "QUEUED" | "FAILED";
  taskIdentifier: string | undefined;
  createdAt: Date;
  payload: unknown;
  error?: { code: string; message: string };
};

export type ReadFallbackDeps = {
  getBuffer?: () => MollifierBuffer | null;
};

export async function findRunByIdWithMollifierFallback(
  input: ReadFallbackInput,
  deps: ReadFallbackDeps = {},
): Promise<SyntheticRun | null> {
  const buffer = (deps.getBuffer ?? getMollifierBuffer)();
  if (!buffer) return null;

  try {
    const entry = await buffer.getEntry(input.runId);
    if (!entry) return null;

    if (entry.envId !== input.environmentId || entry.orgId !== input.organizationId) {
      logger.warn("mollifier read-fallback auth mismatch", {
        runId: input.runId,
        callerEnvId: input.environmentId,
        callerOrgId: input.organizationId,
      });
      return null;
    }

    const snapshot = deserialiseMollifierSnapshot(entry.payload);
    const taskIdentifier =
      typeof snapshot.taskIdentifier === "string" ? snapshot.taskIdentifier : undefined;

    return {
      friendlyId: entry.runId,
      status: entry.status === "FAILED" ? "FAILED" : "QUEUED",
      taskIdentifier,
      createdAt: entry.createdAt,
      payload: snapshot,
      error: entry.lastError,
    };
  } catch (err) {
    logger.error("mollifier read-fallback errored — fail-open to null", {
      runId: input.runId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
```

- [ ] **Step 2: Run the tests and confirm they pass**

Run:
```bash
pnpm --filter webapp test app/v3/mollifier/readFallback.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 3: Run typecheck**

Run:
```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/webapp/app/v3/mollifier/readFallback.server.ts
git commit -m "feat(webapp): implement read-fallback synthesising QUEUED/FAILED from buffer"
```

---

## Task 4: Manual validation gate — read-fallback shape sanity check

**WHO:** agent.

Confirm the fallback's synthesised object has the fields existing presenters/serialisers will read. We won't wire it into a route yet — this gate is just sanity-checking the shape.

- [ ] **Step 1: Inspect the existing run retrieve response**

Run:
```bash
grep -rln "TaskRun.*findFirst\|prisma.taskRun.findFirst" apps/webapp/app/v3/presenters/ 2>/dev/null | head -5
grep -rln "runs.\$runFriendlyId\|runFriendlyId.*retrieve" apps/webapp/app/routes/ 2>/dev/null | head -5
```

Find the presenter that backs the v1 retrieve endpoint. Open it, look at what fields it returns. Confirm `friendlyId`, `status`, `taskIdentifier`, `createdAt` are among them.

- [ ] **Step 2: Document any field gaps in this plan**

If the presenter reads fields not in `SyntheticRun` (e.g. `runtimeEnvironment.slug`, `project.slug`), note them. Phase 2 will likely need to extend `SyntheticRun` to carry these, or the wiring task will need to populate them differently.

Note any gaps in the PR description (not commit):

> "Read-fallback `SyntheticRun` shape covers `friendlyId, status, taskIdentifier, createdAt, payload, error`. Presenter at `<path>` additionally reads `<fields>` — wiring task plans to handle by `<approach>`."

**If a major field is missing:** stop and add it to `SyntheticRun` + tests in Task 2 + implementation in Task 3 before proceeding. Better than discovering it during route wiring.

- [ ] **Step 3: No commit — this is documentation, captured in the plan as a real artifact**

If gaps were found and fields added, commit those iterations under Tasks 2/3 as normal.

---

## Task 5: Extract engine.trigger input construction (refactor triggerTask.server.ts)

Today the engine.trigger input is built inside the `traceEventConcern.traceRun(...)` callback (lines ~352-454). The mollify path needs the same input *without* opening the run span. Refactor: build the input as a synchronous helper that both paths can call.

**Files:**
- Modify: `apps/webapp/app/runEngine/services/triggerTask.server.ts`

- [ ] **Step 1: Find the exact range to extract**

Open `apps/webapp/app/runEngine/services/triggerTask.server.ts`. Locate the `traceEventConcern.traceRun(...)` block (around line 348). The callback receives `(event, store)` and builds the `engine.trigger` input.

The fields of the engine.trigger input that depend on `event` are:
- `traceContext` — built via `this.#propagateExternalTraceContext(event.traceContext, parentRun?.traceContext, event.traceparent?.spanId)`
- `traceId: event.traceId`
- `spanId: event.spanId`
- `parentSpanId: options.parentAsLinkType === "replay" ? undefined : event.traceparent?.spanId`
- `taskEventStore: store`

Everything else is already in scope before the traceRun call.

- [ ] **Step 2: Refactor — pull input building into a private method**

Add a private method `#buildEngineTriggerInput` that takes the `(event, store)`-derived values as explicit params, plus all the existing synchronous values from `this.call()`'s scope.

Roughly (locate the existing `await this.engine.trigger({ ... })` call and convert the object literal into a method call):

```ts
  #buildEngineTriggerInput(args: {
    runFriendlyId: string;
    environment: AuthenticatedEnvironment;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    body: TriggerTaskRequestBody;
    options: TriggerTaskServiceOptions;
    queueName: string;
    lockedQueueId?: string;
    workerQueue?: string;
    enableFastPath: boolean;
    lockedToBackgroundWorker?: LockedBackgroundWorker | undefined;
    delayUntil?: Date;
    ttl?: string;
    metadataPacket?: { data: string; dataType: string };
    tags: string[];
    depth: number;
    parentRun?: PrismaTaskRun;
    annotations: RunAnnotations;
    planType?: string;
    payloadPacket: { data?: string; dataType: string };
    traceContext: TriggerTraceContext;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    taskEventStore: string;
  }) {
    return {
      friendlyId: args.runFriendlyId,
      environment: args.environment,
      idempotencyKey: args.idempotencyKey,
      idempotencyKeyExpiresAt: args.idempotencyKey ? args.idempotencyKeyExpiresAt : undefined,
      idempotencyKeyOptions: args.body.options?.idempotencyKeyOptions,
      taskIdentifier: args.options.taskId ?? args.body.options?.taskId,  // adjust to match existing
      payload: args.payloadPacket.data ?? "",
      payloadType: args.payloadPacket.dataType,
      context: args.body.context,
      traceContext: args.traceContext,
      traceId: args.traceId,
      spanId: args.spanId,
      parentSpanId: args.parentSpanId,
      replayedFromTaskRunFriendlyId: args.options.replayedFromTaskRunFriendlyId,
      lockedToVersionId: args.lockedToBackgroundWorker?.id,
      taskVersion: args.lockedToBackgroundWorker?.version,
      sdkVersion: args.lockedToBackgroundWorker?.sdkVersion,
      cliVersion: args.lockedToBackgroundWorker?.cliVersion,
      concurrencyKey: args.body.options?.concurrencyKey,
      queue: args.queueName,
      lockedQueueId: args.lockedQueueId,
      workerQueue: args.workerQueue,
      enableFastPath: args.enableFastPath,
      isTest: args.body.options?.test ?? false,
      delayUntil: args.delayUntil,
      queuedAt: args.delayUntil ? undefined : new Date(),
      maxAttempts: args.body.options?.maxAttempts,
      taskEventStore: args.taskEventStore,
      ttl: args.ttl,
      tags: args.tags,
      oneTimeUseToken: args.options.oneTimeUseToken,
      parentTaskRunId: args.parentRun?.id,
      rootTaskRunId: args.parentRun?.rootTaskRunId ?? args.parentRun?.id,
      batch: args.options?.batchId
        ? { id: args.options.batchId, index: args.options.batchIndex ?? 0 }
        : undefined,
      resumeParentOnCompletion: args.body.options?.resumeParentOnCompletion,
      depth: args.depth,
      metadata: args.metadataPacket?.data,
      metadataType: args.metadataPacket?.dataType,
      seedMetadata: args.metadataPacket?.data,
      seedMetadataType: args.metadataPacket?.dataType,
      maxDurationInSeconds: args.body.options?.maxDuration
        ? clampMaxDuration(args.body.options.maxDuration)
        : undefined,
      machine: args.body.options?.machine,
      priorityMs: args.body.options?.priority ? args.body.options.priority * 1_000 : undefined,
      queueTimestamp:
        args.options.queueTimestamp ??
        (args.parentRun && args.body.options?.resumeParentOnCompletion
          ? args.parentRun.queueTimestamp ?? undefined
          : undefined),
      scheduleId: args.options.scheduleId,
      scheduleInstanceId: args.options.scheduleInstanceId,
      createdAt: args.options.overrideCreatedAt,
      bulkActionId: args.body.options?.bulkActionId,
      planType: args.planType,
      realtimeStreamsVersion: args.options.realtimeStreamsVersion,
      streamBasinName: args.environment.organization.streamBasinName,
      debounce: args.body.options?.debounce,
      annotations: args.annotations,
      onDebounced: undefined, // see below — onDebounced is not snapshotted, pass-through path attaches it directly
    };
  }
```

**Important caveat:** the existing code's `onDebounced` callback is a closure over `triggerRequest` and `this.traceEventConcern`. It's stateful and cannot be serialised into the snapshot. For the mollify path, debounced requests should still be supported but the `onDebounced` callback for them is provided only when invoked through the pass-through path. If a debounced request hits the gate and gets diverted, the buffer entry doesn't carry the callback — the drainer's replay also won't have it. **This is largely resolved by Design concern 1 (lift `handleDebounce` upfront), but document any residual cases in the PR description.** Document it in the PR description; if it's a hard blocker, the alternative is to make `evaluateGate` return `pass_through` when `body.options?.debounce` is set (i.e. never mollify debounced triggers).

- [ ] **Step 3: Replace the inline object literal in the traceRun callback with a call to `#buildEngineTriggerInput`**

In the traceRun callback, replace `await this.engine.trigger({ ...inline object... }, this.prisma)` with:

```ts
            const input = this.#buildEngineTriggerInput({
              runFriendlyId,
              environment,
              idempotencyKey,
              idempotencyKeyExpiresAt,
              body,
              options,
              queueName,
              lockedQueueId,
              workerQueue,
              enableFastPath,
              lockedToBackgroundWorker: lockedToBackgroundWorker ?? undefined,
              delayUntil,
              ttl,
              metadataPacket,
              tags,
              depth,
              parentRun: parentRun ?? undefined,
              annotations,
              planType,
              payloadPacket,
              traceContext: this.#propagateExternalTraceContext(
                event.traceContext,
                parentRun?.traceContext,
                event.traceparent?.spanId,
              ),
              traceId: event.traceId,
              spanId: event.spanId,
              parentSpanId:
                options.parentAsLinkType === "replay" ? undefined : event.traceparent?.spanId,
              taskEventStore: store,
            });

            // Pass-through path keeps the onDebounced closure inline.
            const taskRun = await this.engine.trigger(
              {
                ...input,
                onDebounced:
                  body.options?.debounce && body.options?.resumeParentOnCompletion
                    ? async ({ existingRun, waitpoint, debounceKey }) => {
                        return await this.traceEventConcern.traceDebouncedRun(
                          triggerRequest,
                          parentRun?.taskEventStore,
                          {
                            existingRun,
                            debounceKey,
                            incomplete: waitpoint.status === "PENDING",
                            isError: waitpoint.outputIsError,
                          },
                          async (spanEvent) => {
                            const spanId =
                              options?.parentAsLinkType === "replay"
                                ? spanEvent.spanId
                                : spanEvent.traceparent?.spanId
                                ? `${spanEvent.traceparent.spanId}:${spanEvent.spanId}`
                                : spanEvent.spanId;
                            return spanId;
                          },
                        );
                      }
                    : undefined,
              },
              this.prisma,
            );
```

- [ ] **Step 4: Run typecheck**

Run:
```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 5: Run existing webapp tests as a regression smoke**

Run:
```bash
pnpm --filter webapp test app/v3/mollifier/
```
Expected: all Phase 1 tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/webapp/app/runEngine/services/triggerTask.server.ts
git commit -m "refactor(webapp): extract #buildEngineTriggerInput so mollify path can reuse"
```

---

## Task 6: Implement the mollify execution path — failing tests first

**Files:**
- Create: `apps/webapp/app/v3/mollifier/mollifierMollify.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/webapp/app/v3/mollifier/mollifierMollify.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { mollifyTrigger } from "./mollifierMollify.server";
import type { MollifierBuffer } from "@trigger.dev/redis-worker";

function fakeBuffer(): { buffer: MollifierBuffer; accept: ReturnType<typeof vi.fn> } {
  const accept = vi.fn(async () => undefined);
  return {
    buffer: { accept } as unknown as MollifierBuffer,
    accept,
  };
}

describe("mollifyTrigger", () => {
  it("writes the snapshot to buffer and returns synthesised result", async () => {
    const { buffer, accept } = fakeBuffer();
    const result = await mollifyTrigger({
      runFriendlyId: "run_friendly_1",
      environmentId: "env_a",
      organizationId: "org_1",
      engineTriggerInput: { taskIdentifier: "my-task", payload: '{"x":1}' },
      decision: {
        divert: true,
        reason: "per_env_rate",
        count: 150,
        threshold: 100,
      },
      buffer,
    });

    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith({
      runId: "run_friendly_1",
      envId: "env_a",
      orgId: "org_1",
      payload: expect.any(String),
    });
    expect(result.run.friendlyId).toBe("run_friendly_1");
    expect(result.error).toBeUndefined();
    expect(result.isCached).toBe(false);
    expect(result.notice).toEqual({
      code: "mollifier.queued",
      message: expect.stringContaining("burst buffer"),
      docs: expect.stringContaining("trigger.dev/docs"),
    });
  });

  it("snapshot is round-trippable: payload field is parseable JSON of engineTriggerInput", async () => {
    const { buffer, accept } = fakeBuffer();
    const engineInput = { taskIdentifier: "t", payload: "{}", tags: ["a", "b"] };
    await mollifyTrigger({
      runFriendlyId: "run_x",
      environmentId: "env_a",
      organizationId: "org_1",
      engineTriggerInput: engineInput,
      decision: { divert: true, reason: "per_env_rate", count: 1, threshold: 1 },
      buffer,
    });

    const callArg = accept.mock.calls[0][0] as { payload: string };
    expect(JSON.parse(callArg.payload)).toEqual(engineInput);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:
```bash
pnpm --filter webapp test app/v3/mollifier/mollifierMollify.test.ts
```
Expected: FAIL with "Cannot find module './mollifierMollify.server'".

- [ ] **Step 3: Commit**

```bash
git add apps/webapp/app/v3/mollifier/mollifierMollify.test.ts
git commit -m "test(webapp): failing tests for mollifyTrigger"
```

---

## Task 7: Implement the mollify function

**Files:**
- Create: `apps/webapp/app/v3/mollifier/mollifierMollify.server.ts`

- [ ] **Step 1: Implement**

Create `apps/webapp/app/v3/mollifier/mollifierMollify.server.ts`:

```ts
import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { serialiseMollifierSnapshot, type MollifierSnapshot } from "./mollifierSnapshot.server";
import type { TripDecision } from "./mollifierGate.server";

export type MollifyNotice = {
  code: "mollifier.queued";
  message: string;
  docs: string;
};

export type MollifySyntheticResult = {
  run: { friendlyId: string };
  error: undefined;
  isCached: false;
  notice: MollifyNotice;
};

const NOTICE: MollifyNotice = {
  code: "mollifier.queued",
  message:
    "Trigger accepted into burst buffer. Consider batchTrigger for fan-outs of 100+.",
  docs: "https://trigger.dev/docs/triggering#burst-handling",
};

export async function mollifyTrigger(args: {
  runFriendlyId: string;
  environmentId: string;
  organizationId: string;
  engineTriggerInput: MollifierSnapshot;
  decision: Extract<TripDecision, { divert: true }>;
  buffer: MollifierBuffer;
}): Promise<MollifySyntheticResult> {
  await args.buffer.accept({
    runId: args.runFriendlyId,
    envId: args.environmentId,
    orgId: args.organizationId,
    payload: serialiseMollifierSnapshot(args.engineTriggerInput),
  });

  return {
    run: { friendlyId: args.runFriendlyId },
    error: undefined,
    isCached: false,
    notice: NOTICE,
  };
}
```

- [ ] **Step 2: Run the tests and confirm they pass**

Run:
```bash
pnpm --filter webapp test app/v3/mollifier/mollifierMollify.test.ts
```
Expected: 2 tests pass.

- [ ] **Step 3: Run typecheck**

Run:
```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/webapp/app/v3/mollifier/mollifierMollify.server.ts
git commit -m "feat(webapp): mollifyTrigger writes snapshot to buffer + returns synthesised result"
```

---

## Task 8: Wire the mollify branch in triggerTask.server.ts (replace the throw)

**Files:**
- Modify: `apps/webapp/app/runEngine/services/triggerTask.server.ts`

This task replaces the phase 1 throw with a real divert path. The mollify path skips `traceEventConcern.traceRun` entirely — the run span is created by the drainer when it eventually invokes engine.trigger.

- [ ] **Step 1: Locate the gate-call site from phase 1**

Run:
```bash
grep -n "MollifierGate.mollify reached" apps/webapp/app/runEngine/services/triggerTask.server.ts
```
Note the line.

- [ ] **Step 2: Add imports**

Add at the top of the file:

```ts
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { mollifyTrigger } from "~/v3/mollifier/mollifierMollify.server";
import { startSpan } from "~/v3/tracing.server";
```

(if startSpan is already imported, skip that line).

- [ ] **Step 3: Replace the throw with the real mollify path**

For the mollify path we need the same `engine.trigger` input that pass-through builds, but constructed *without* `traceRun`. The cleanest approach: open a short `mollifier.queued` span via `startSpan` on the existing service-level `span` (the outer `call()` span). Extract `traceContext`/`traceId`/`spanId` from that span so the snapshot carries them.

Replace the existing block (where phase 1 threw) with the following — note this is INSIDE the `evaluateGate` outcome check, BEFORE the `try { ... traceEventConcern.traceRun }` block:

```ts
      const mollifierOutcome = await evaluateGate({
        envId: environment.id,
        orgId: environment.organizationId,
      });

      if (mollifierOutcome.action === "mollify") {
        const buffer = getMollifierBuffer();
        if (!buffer) {
          // Defensive: cascade should not produce 'mollify' when buffer is null.
          // Fall through to pass-through.
          logger.warn("mollifier gate said mollify but buffer is null — falling through");
        } else {
          return await startSpan(
            this.tracer,
            "mollifier.queued",
            async (mollifierSpan) => {
              mollifierSpan.setAttribute("mollifier.reason", mollifierOutcome.decision.reason);
              mollifierSpan.setAttribute("mollifier.count", mollifierOutcome.decision.count);
              mollifierSpan.setAttribute("mollifier.threshold", mollifierOutcome.decision.threshold);

              const payloadPacket = await this.payloadProcessor.process(triggerRequest);
              const taskEventStore =
                parentRun?.taskEventStore ?? environment.taskEventStoreVersion ?? "postgres";

              const traceContext = this.#propagateExternalTraceContext(
                {},
                parentRun?.traceContext,
                undefined,
              );

              const engineTriggerInput = this.#buildEngineTriggerInput({
                runFriendlyId,
                environment,
                idempotencyKey,
                idempotencyKeyExpiresAt,
                body,
                options,
                queueName,
                lockedQueueId,
                workerQueue,
                enableFastPath,
                lockedToBackgroundWorker: lockedToBackgroundWorker ?? undefined,
                delayUntil,
                ttl,
                metadataPacket,
                tags,
                depth,
                parentRun: parentRun ?? undefined,
                annotations,
                planType,
                payloadPacket,
                traceContext,
                traceId: mollifierSpan.spanContext().traceId,
                spanId: mollifierSpan.spanContext().spanId,
                parentSpanId: undefined,
                taskEventStore,
              });

              if (body.options?.debounce) {
                logger.warn(
                  "mollifier: debounce triggers fall through (onDebounced callback not snapshotted)",
                  { runFriendlyId, taskId },
                );
                // Fall through to the pass-through path below; signal by not returning.
                return undefined as any;
              }

              const result = await mollifyTrigger({
                runFriendlyId,
                environmentId: environment.id,
                organizationId: environment.organizationId,
                engineTriggerInput,
                decision: mollifierOutcome.decision,
                buffer,
              });

              return result as unknown as TriggerTaskServiceResult;
            },
          );
        }
      }
```

After this block, the existing `try { return await this.traceEventConcern.traceRun(...) ... }` block remains unchanged. The `if (mollifierOutcome.action === "mollify")` branch returns early when applicable; otherwise execution continues to the pass-through path.

**Note on the cast:** `as unknown as TriggerTaskServiceResult` is necessary because the synthetic result shape is structurally narrower than the full `TaskRun` Prisma model. The route handler only reads `result.run.friendlyId` for serialisation, so the cast is safe in practice. If TypeScript strictness in the project rejects this, widen `TriggerTaskServiceResult` to accept `{ friendlyId: string }` instead of `TaskRun`.

- [ ] **Step 4: Run typecheck**

Run:
```bash
pnpm run typecheck --filter webapp
```
Expected: PASS. If `TriggerTaskServiceResult` rejects the synthetic shape, adjust the type definition in `apps/webapp/app/v3/services/triggerTask.server.ts` to make `run` permissive enough (`{ friendlyId: string } & Partial<TaskRun>` is a reasonable shape).

- [ ] **Step 5: Run tests**

Run:
```bash
pnpm --filter webapp test app/v3/mollifier/
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/webapp/app/runEngine/services/triggerTask.server.ts
git commit -m "feat(webapp): wire real mollify branch in trigger hot path"
```

---

## Task 9: Manual validation gate — mollify produces buffer entries and synthesised responses

**WHO:** agent.

This is the first end-to-end behavioural check that mollification actually works. We enable for a specific local env, fire a fan-out big enough to trip the threshold, and observe both the buffer and the API response.

- [ ] **Step 1: Identify a test org's organizationId for local dev**

Run:
```bash
pnpm run db:seed  # if not already done
```

Then query the seeded org:

```bash
psql "$DATABASE_URL" -c "SELECT id, slug FROM \"Organization\" LIMIT 5;"
```

Note one organization's id (call it `<ORG_ID>`).

- [ ] **Step 2: Enable mollifierEnabled for that org via the admin UI or direct DB write**

Via DB (faster for local dev):
```bash
psql "$DATABASE_URL" -c "UPDATE \"Organization\" SET \"featureFlags\" = jsonb_set(coalesce(\"featureFlags\", '{}'::jsonb), '{mollifierEnabled}', 'true', true) WHERE id = '<ORG_ID>';"
```

(Phase 1's flag check uses the global `FeatureFlag` table. Task 17 of this plan switches it to per-org via `Organization.featureFlags`. For this gate, if Task 17 hasn't run yet, set the global flag instead via the admin UI at `http://localhost:3030/admin/feature-flags`.)

- [ ] **Step 3: Restart webapp with mollifier on (no shadow)**

```bash
MOLLIFIER_ENABLED=1 \
  MOLLIFIER_SHADOW_MODE=0 \
  MOLLIFIER_REDIS_HOST=localhost \
  MOLLIFIER_REDIS_PORT=6379 \
  MOLLIFIER_TRIP_WINDOW_MS=200 \
  MOLLIFIER_TRIP_THRESHOLD=20 \
  MOLLIFIER_HOLD_MS=500 \
  pnpm run dev --filter webapp
```

(Threshold lowered to 20 for the gate so a small fan-out is enough.)

- [ ] **Step 4: Fire a 100-fan-out from stress-tasks (running in dev mode)**

```
mcp__trigger__trigger_task(
  projectRef: "<stress-tasks projectRef in that ORG>",
  environment: "dev",
  taskId: "stress-fan-out-trigger",
  payload: { "count": 100, "concurrency": 100 }
)
```

- [ ] **Step 5: Confirm buffer entries appear in Redis**

```bash
redis-cli -h localhost -p 6379 --scan --pattern 'mollifier:entries:*' | wc -l
redis-cli -h localhost -p 6379 --scan --pattern 'mollifier:queue:*' | head
```

Expected: count > 0 (some triggers were diverted into the buffer). The exact count depends on threshold + drain speed. The queue keys should be empty or near-empty if Task 13 (real handler) hasn't been wired yet; otherwise entries are draining quickly.

- [ ] **Step 6: Confirm runs.retrieve returns QUEUED for a buffered run**

Pick a runId from the buffer:
```bash
redis-cli -h localhost -p 6379 --scan --pattern 'mollifier:entries:*' | head -1
```

Then call the runs retrieve API for that runId (note: the retrieve wiring lands in Task 16; for this gate the API still returns 404 because phase 1's stub helper returns null and isn't wired in yet). For this gate, **directly call** the read-fallback helper from a vitest one-off or from the webapp REPL, or skip the API call and just confirm the buffer state directly:

```bash
# inspect entry shape
redis-cli -h localhost -p 6379 HGETALL "<one of the entry keys>"
```

Expected fields: `runId`, `envId`, `orgId`, `payload`, `status=QUEUED`, `attempts=0`, `createdAt`.

- [ ] **Step 7: Confirm the API response carries `notice`**

Inspect the webapp logs for the trigger requests that mollified — the response body should include the `notice` field. (This requires looking at the actual HTTP response; if uncertain, capture one with `tcpdump` or a debug log temporarily added.)

**If the API response doesn't have `notice`**: the route handler isn't propagating it. The route at `apps/webapp/app/routes/api.v1.tasks.$taskId.trigger.ts` (or similar — grep for it) serialises `TriggerTaskResponse`. If it just reads `{ id }` and doesn't propagate `notice`, that's Task 14's fix.

- [ ] **Step 8: Document outcomes in the PR description**

Write down: number of buffer entries created, sample entry shape, whether the API response carries `notice`. If any check failed, fix before proceeding.

- [ ] **Step 9: Reset buffer state for subsequent gates**

```bash
redis-cli -h localhost -p 6379 --scan --pattern 'mollifier:*' | xargs -I {} redis-cli -h localhost -p 6379 del {}
```

---

## Task 10: Implement the drainer handler — failing tests first

**Files:**
- Create: `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createDrainerHandler, isRetryablePgError } from "./mollifierDrainerHandler.server";

describe("isRetryablePgError", () => {
  it("returns true for P2024 (connection pool timeout)", () => {
    const err = Object.assign(new Error("Timed out fetching a new connection"), {
      code: "P2024",
    });
    expect(isRetryablePgError(err)).toBe(true);
  });

  it("returns true for generic connection-lost messages", () => {
    expect(isRetryablePgError(new Error("Connection lost"))).toBe(true);
    expect(isRetryablePgError(new Error("Can't reach database server"))).toBe(true);
  });

  it("returns false for validation errors", () => {
    expect(isRetryablePgError(new Error("Invalid payload"))).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(isRetryablePgError("string error")).toBe(false);
    expect(isRetryablePgError({ message: "object" })).toBe(false);
  });
});

describe("createDrainerHandler", () => {
  it("invokes engine.trigger with the deserialised snapshot", async () => {
    const trigger = vi.fn(async () => ({ friendlyId: "run_x" }));
    const handler = createDrainerHandler({
      engine: { trigger } as any,
      prisma: {} as any,
    });

    await handler({
      runId: "run_x",
      envId: "env_a",
      orgId: "org_1",
      payload: { taskIdentifier: "t", payload: "{}" },
      attempts: 0,
      createdAt: new Date(),
    });

    expect(trigger).toHaveBeenCalledOnce();
    const callArg = trigger.mock.calls[0][0];
    expect(callArg.taskIdentifier).toBe("t");
  });

  it("propagates engine.trigger errors so MollifierDrainer can classify them", async () => {
    const trigger = vi.fn(async () => {
      throw new Error("boom");
    });
    const handler = createDrainerHandler({
      engine: { trigger } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: "run_x",
        envId: "env_a",
        orgId: "org_1",
        payload: { taskIdentifier: "t" },
        attempts: 0,
        createdAt: new Date(),
      }),
    ).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:
```bash
pnpm --filter webapp test app/v3/mollifier/mollifierDrainerHandler.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Commit**

```bash
git add apps/webapp/app/v3/mollifier/mollifierDrainerHandler.test.ts
git commit -m "test(webapp): failing tests for mollifier drainer handler"
```

---

## Task 11: Implement the drainer handler

**Files:**
- Create: `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`

- [ ] **Step 1: Implement**

Create `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`:

```ts
import type { RunEngine } from "@internal/run-engine";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type { MollifierDrainerHandler } from "@trigger.dev/redis-worker";
import type { MollifierSnapshot } from "./mollifierSnapshot.server";

export function isRetryablePgError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  const code = (err as { code?: string }).code;
  if (code === "P2024") return true;
  if (msg.includes("Can't reach database server")) return true;
  if (msg.includes("Connection lost")) return true;
  if (msg.includes("ECONNRESET")) return true;
  return false;
}

export function createDrainerHandler(deps: {
  engine: RunEngine;
  prisma: PrismaClientOrTransaction;
}): MollifierDrainerHandler<MollifierSnapshot> {
  return async (input) => {
    await deps.engine.trigger(input.payload as any, deps.prisma);
  };
}
```

The `as any` cast on `input.payload` is the boundary between the generic `MollifierSnapshot` (a JSON-shaped `Record<string, unknown>`) and the engine's typed input. The serialise/deserialise round-trip in phases 1+2 verified that the structure is preserved; the type narrowing happens by trust at this boundary.

- [ ] **Step 2: Run the tests and confirm they pass**

Run:
```bash
pnpm --filter webapp test app/v3/mollifier/mollifierDrainerHandler.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts
git commit -m "feat(webapp): drainer handler that replays engine.trigger from snapshot"
```

---

## Task 12: Wire the real handler into the drainer singleton

**Files:**
- Modify: `apps/webapp/app/v3/mollifier/mollifierDrainer.server.ts`

- [ ] **Step 1: Replace the placeholder handler**

Modify `apps/webapp/app/v3/mollifier/mollifierDrainer.server.ts`. Replace its contents with:

```ts
import { MollifierDrainer } from "@trigger.dev/redis-worker";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { runEngine } from "~/v3/runEngine.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import {
  createDrainerHandler,
  isRetryablePgError,
} from "./mollifierDrainerHandler.server";
import type { MollifierSnapshot } from "./mollifierSnapshot.server";

function initializeMollifierDrainer(): MollifierDrainer<MollifierSnapshot> | null {
  const buffer = getMollifierBuffer();
  if (!buffer) return null;

  logger.debug("Initializing mollifier drainer", {
    concurrency: env.MOLLIFIER_DRAIN_CONCURRENCY,
    maxAttempts: env.MOLLIFIER_DRAIN_MAX_ATTEMPTS,
  });

  const drainer = new MollifierDrainer<MollifierSnapshot>({
    buffer,
    handler: createDrainerHandler({ engine: runEngine, prisma }),
    concurrency: env.MOLLIFIER_DRAIN_CONCURRENCY,
    maxAttempts: env.MOLLIFIER_DRAIN_MAX_ATTEMPTS,
    isRetryable: isRetryablePgError,
  });

  drainer.start();
  return drainer;
}

export function getMollifierDrainer(): MollifierDrainer<MollifierSnapshot> | null {
  if (env.MOLLIFIER_ENABLED !== "1") return null;
  return singleton("mollifierDrainer", initializeMollifierDrainer);
}
```

- [ ] **Step 2: Run typecheck**

Run:
```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/webapp/app/v3/mollifier/mollifierDrainer.server.ts
git commit -m "feat(webapp): wire real engine.trigger replay into MollifierDrainer"
```

---

## Task 13: Manual validation gate — drainer persists buffered runs into PG

**WHO:** agent.

End-to-end: mollify a fan-out, watch the buffer drain into Postgres.

- [ ] **Step 1: Clear Redis state**

```bash
redis-cli -h localhost -p 6379 --scan --pattern 'mollifier:*' | xargs -I {} redis-cli -h localhost -p 6379 del {}
```

- [ ] **Step 2: Start webapp with mollifier enabled + low threshold**

```bash
MOLLIFIER_ENABLED=1 MOLLIFIER_SHADOW_MODE=0 \
  MOLLIFIER_TRIP_WINDOW_MS=200 MOLLIFIER_TRIP_THRESHOLD=20 MOLLIFIER_HOLD_MS=500 \
  MOLLIFIER_DRAIN_CONCURRENCY=10 \
  pnpm run dev --filter webapp
```

- [ ] **Step 3: Fire a 100-fan-out**

```
mcp__trigger__trigger_task(
  projectRef: "<stress-tasks projectRef>",
  environment: "dev",
  taskId: "stress-fan-out-trigger",
  payload: { "count": 100, "concurrency": 100 }
)
```

- [ ] **Step 4: Within 10 seconds, verify Postgres has all 100 runs**

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"TaskRun\" WHERE \"taskIdentifier\" = 'stress-noop-child' AND \"createdAt\" > now() - interval '1 minute';"
```

Expected: count = 100. If less, the drainer either isn't draining fast enough (check `MOLLIFIER_DRAIN_CONCURRENCY`) or is hitting retryable errors (check webapp logs for `MollifierDrainer:` entries).

- [ ] **Step 5: Verify the buffer is empty after drain**

```bash
redis-cli -h localhost -p 6379 --scan --pattern 'mollifier:entries:*' | wc -l
redis-cli -h localhost -p 6379 --scan --pattern 'mollifier:queue:*' | wc -l
```

Expected: both 0.

- [ ] **Step 6: Verify no FAILED entries**

If any entries linger, check their status:
```bash
for k in $(redis-cli -h localhost -p 6379 --scan --pattern 'mollifier:entries:*'); do
  redis-cli -h localhost -p 6379 HGET "$k" status
done
```

Expected: empty output (all entries drained). Any `FAILED` indicates the engine.trigger replay is rejecting something — investigate before proceeding.

- [ ] **Step 7: Document in the PR description**

```
Phase 2 manual validation gate — end-to-end drain:
- 100-fan-out → all 100 runs appear in Postgres within ~Xs
- Buffer empty after drain
- Zero FAILED entries
- Drain throughput observed: ~Y runs/sec at concurrency=10
```

**If runs are missing or FAILED entries linger**: stop. The drainer handler has a bug, the engine.trigger replay is failing, or the isRetryable classification is wrong. Fix before proceeding.

---

## Task 14: Add optional `notice` field to TriggerTaskResponse

**Files:**
- Modify: `packages/core/src/v3/schemas/api.ts`
- Modify: `apps/webapp/app/routes/api.v1.tasks.$taskId.trigger.ts` (or whichever route handler serialises the response — grep to confirm)

- [ ] **Step 1: Extend the schema**

In `packages/core/src/v3/schemas/api.ts`, locate `TriggerTaskResponse` (around line 230). Modify it:

```ts
export const TriggerTaskResponse = z.object({
  id: z.string(),
  isCached: z.boolean().optional(),
  notice: z
    .object({
      code: z.string(),
      message: z.string(),
      docs: z.string().url(),
    })
    .optional(),
});
```

- [ ] **Step 2: Find the route handler that returns this response**

```bash
grep -rn "TriggerTaskResponse\|return.*Response.json.*id:" apps/webapp/app/routes/ 2>/dev/null | head -10
```

The handler is most likely at `apps/webapp/app/routes/api.v1.tasks.$taskId.trigger.ts`. Open it and find the response serialisation point.

- [ ] **Step 3: Propagate the `notice` from the service result to the response**

The service result (from Task 7) now carries `notice?: MollifyNotice` on the mollified path. In the route handler, when serialising, include `notice` if present:

```ts
// Pseudocode, adjust to the actual handler shape:
return json({
  id: result.run.friendlyId,
  isCached: result.isCached,
  ...(("notice" in result && result.notice) ? { notice: result.notice } : {}),
});
```

The exact shape depends on the existing handler — preserve all fields it currently returns.

- [ ] **Step 4: Build the core package to regenerate type definitions**

Run:
```bash
pnpm run build --filter @trigger.dev/core
```
Expected: build passes.

- [ ] **Step 5: Run typecheck on webapp**

Run:
```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 6: Add a changeset for @trigger.dev/core**

```bash
pnpm run changeset:add
```
Select `@trigger.dev/core`, type **patch**, summary: `Add optional notice field to TriggerTaskResponse for mollifier transparency.`

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/v3/schemas/api.ts apps/webapp/app/routes/ .changeset/
git commit -m "feat(core): optional notice field on TriggerTaskResponse"
```

---

## Task 15: Add OTEL drained-span attributes on the drainer side

**Files:**
- Modify: `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`

The `mollifier.queued` span on the caller's trace is already created in Task 8 (via `startSpan(this.tracer, "mollifier.queued", ...)`). The drainer side needs to attach `mollifier.drained=true` and `mollifier.dwell_ms` attributes to the run's OTEL span when engine.trigger creates it.

The engine itself opens the run's span. The drainer can't easily reach into that span. The most reliable place to record `mollifier.drained` and `dwell_ms` is the drainer-side wrapper: open a separate `mollifier.drained` span around the engine.trigger call so the drainer's view of the work is observable.

- [ ] **Step 1: Modify the handler to wrap in a drained span**

Update `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`:

```ts
import type { RunEngine } from "@internal/run-engine";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type { MollifierDrainerHandler } from "@trigger.dev/redis-worker";
import { startSpan, trace } from "@internal/tracing";
import type { MollifierSnapshot } from "./mollifierSnapshot.server";

const tracer = trace.getTracer("mollifier-drainer");

export function isRetryablePgError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  const code = (err as { code?: string }).code;
  if (code === "P2024") return true;
  if (msg.includes("Can't reach database server")) return true;
  if (msg.includes("Connection lost")) return true;
  if (msg.includes("ECONNRESET")) return true;
  return false;
}

export function createDrainerHandler(deps: {
  engine: RunEngine;
  prisma: PrismaClientOrTransaction;
}): MollifierDrainerHandler<MollifierSnapshot> {
  return async (input) => {
    const dwellMs = Date.now() - input.createdAt.getTime();

    await startSpan(
      tracer,
      "mollifier.drained",
      async (span) => {
        span.setAttribute("mollifier.drained", true);
        span.setAttribute("mollifier.dwell_ms", dwellMs);
        span.setAttribute("mollifier.attempts", input.attempts);
        span.setAttribute("mollifier.run_friendly_id", input.runId);

        await deps.engine.trigger(input.payload as any, deps.prisma);
      },
    );
  };
}
```

- [ ] **Step 2: Update tests to match (the handler now opens a span)**

The existing tests in Task 10 use `vi.fn` for trigger and don't observe spans. They still pass — the span is opened transparently. Re-run:

```bash
pnpm --filter webapp test app/v3/mollifier/mollifierDrainerHandler.test.ts
```
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts
git commit -m "feat(webapp): mollifier.drained OTEL span with dwell_ms + attempts"
```

---

## Task 16: Manual validation gate — OTEL spans + notice field visible

**WHO:** agent.

- [ ] **Step 1: Webapp is running from Task 13's gate (mollifier enabled)**

- [ ] **Step 2: Trigger one fan-out with a trace context attached**

If using the MCP tool, MCP propagates a trace by default. Otherwise, curl with `traceparent` header:
```bash
TRACEPARENT="00-$(openssl rand -hex 16)-$(openssl rand -hex 8)-01"
curl -X POST http://localhost:3030/api/v1/tasks/stress-fan-out-trigger/trigger \
  -H "Authorization: Bearer <api-key>" \
  -H "traceparent: $TRACEPARENT" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"count": 50, "concurrency": 50}}'
```

- [ ] **Step 3: Inspect the response body**

Look for `notice` field in the JSON response. Expected (for at least some of the 50 triggers, those that mollified):

```json
{
  "id": "run_...",
  "notice": {
    "code": "mollifier.queued",
    "message": "Trigger accepted into burst buffer...",
    "docs": "https://trigger.dev/docs/..."
  }
}
```

- [ ] **Step 4: Inspect OTEL traces**

Depending on the local OTEL setup, traces may be exported to:
- Console (if `OTEL_TRACES_EXPORTER=console`)
- Local Jaeger/OTLP collector (if configured)

Look for spans named `mollifier.queued` and `mollifier.drained` with the same trace ID as the API call. The `mollifier.drained` span should carry `mollifier.dwell_ms` > 0.

If no OTEL exporter is configured locally, this gate is satisfied by code inspection — confirm `startSpan(...)` is called in both the mollify path (`triggerTask.server.ts`, Task 8) and the drainer handler (Task 15). The production OTEL pipeline will surface them.

- [ ] **Step 5: Document outcomes**

PR description note:

```
Phase 2 manual validation gate — transparency:
- API response on mollified triggers carries `notice` field with code, message, docs
- OTEL spans `mollifier.queued` and `mollifier.drained` emit on the caller's trace
- Span attributes: mollifier.reason, mollifier.count, mollifier.threshold, mollifier.dwell_ms
```

---

## Task 17: Per-env gating via FeatureFlag table (gate + drain)

**Files:**
- Modify: `apps/webapp/app/v3/mollifier/mollifierGate.server.ts`
- Modify: `apps/webapp/app/v3/mollifier/mollifierGate.test.ts`

Phase 1 used a global `FeatureFlag` key (`mollifierEnabled`). Per the O2 operational decision, Phase 2 uses **per-env** keys: `mollifierEnabled:{envId}` (gate) and `mollifierDrainEnabled:{envId}` (drain — read elsewhere in Phase 2; see new task A1 for the data migration that seeds these from the global value, and new task A11 for the drainer side of this flag).

This task wires the gate side. C1 + C3 + F4 bypasses also land here.

- [ ] **Step 1: Add per-env helpers + the C1/C3/F4 bypasses to the gate**

In `apps/webapp/app/v3/mollifier/mollifierGate.server.ts`, replace the existing global flag check with a per-env lookup. Add the three bypasses up front so they short-circuit before the trip evaluator runs:

```ts
import { prisma } from "~/db.server";

export async function evaluateGate(
  inputs: { envId: string; orgId: string; options?: TriggerTaskServiceOptions },
  evaluator?: TripEvaluator,
): Promise<GateOutcome> {
  // C1 — debounce bypass. onDebounced callback is not snapshottable.
  if (inputs.options?.debounce) return { action: "pass_through" };
  // C3 — OneTimeUseToken bypass. Sync-rejection contract is load-bearing.
  if (inputs.options?.oneTimeUseToken) return { action: "pass_through" };
  // F4 — triggerAndWait bypass. batchTriggerAndWait still funnels through.
  if (inputs.options?.parentTaskRunId && inputs.options?.resumeParentOnCompletion) {
    return { action: "pass_through" };
  }

  const envFlagKey = `${FEATURE_FLAG.mollifierEnabled}:${inputs.envId}`;
  const envFlagEnabled = await flag({ key: envFlagKey, defaultValue: false });
  if (!envFlagEnabled) return { action: "pass_through" };

  // ...remainder of the existing logic (env-var short-circuit, evaluator call,
  // shadow vs mollify branch) is unchanged.
}
```

Note: the per-env flag is the **only** flag check here. There is no org-level fallback in Phase 2 — gating is intentionally env-scoped so canary cohorts can be expressed at the env granularity (one customer often has dev + staging + prod envs that should be enabled independently).

- [ ] **Step 2: Update the gate cascade tests for per-env behaviour + bypasses**

Replace the previous per-org tests in `apps/webapp/app/v3/mollifier/mollifierGate.test.ts` with per-env equivalents and add bypass tests:

```ts
describe("evaluateGate per-env flag + bypasses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOLLIFIER_ENABLED = "1";
    process.env.MOLLIFIER_SHADOW_MODE = "0";
  });

  it("C1: debounce trigger always passes through (no flag check)", async () => {
    const evaluator = vi.fn();
    const outcome = await evaluateGate(
      { envId: "e1", orgId: "o1", options: { debounce: { key: "k" } } as any },
      evaluator,
    );
    expect(outcome).toEqual({ action: "pass_through" });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("C3: oneTimeUseToken passes through", async () => {
    const outcome = await evaluateGate(
      { envId: "e1", orgId: "o1", options: { oneTimeUseToken: "t" } as any },
      vi.fn(),
    );
    expect(outcome).toEqual({ action: "pass_through" });
  });

  it("F4: triggerAndWait (parentTaskRunId + resumeParentOnCompletion) passes through", async () => {
    const outcome = await evaluateGate(
      {
        envId: "e1",
        orgId: "o1",
        options: { parentTaskRunId: "p", resumeParentOnCompletion: true } as any,
      },
      vi.fn(),
    );
    expect(outcome).toEqual({ action: "pass_through" });
  });

  it("per-env flag enabled → mollify when evaluator diverts", async () => {
    vi.mocked(flag).mockImplementation(async ({ key }) =>
      key === "mollifierEnabled:e1" ? true : false,
    );
    const evaluator = vi.fn(async () => ({
      divert: true as const,
      reason: "per_env_rate" as const,
      count: 150,
      threshold: 100,
    }));
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, evaluator);
    expect(outcome.action).toBe("mollify");
  });

  it("per-env flag disabled → pass_through even when evaluator would divert", async () => {
    vi.mocked(flag).mockResolvedValue(false);
    const evaluator = vi.fn();
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, evaluator);
    expect(outcome).toEqual({ action: "pass_through" });
    expect(evaluator).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
pnpm --filter webapp test app/v3/mollifier/mollifierGate.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/webapp/app/v3/mollifier/mollifierGate.server.ts apps/webapp/app/v3/mollifier/mollifierGate.test.ts
git commit -m "feat(webapp): per-env mollifier gate + C1/C3/F4 bypasses"
```

---

## Task 18: Wire read-fallback into the runs retrieve presenter

**Files:**
- Modify: `apps/webapp/app/v3/presenters/<runs retrieve presenter>.server.ts` (find via grep)
- Modify: `apps/webapp/app/routes/<runs retrieve route>.ts` (find via grep)

The exact presenter and route filenames depend on the codebase. Steps to find and wire:

- [ ] **Step 1: Find the run retrieve presenter and its route**

Run:
```bash
grep -rln "taskRun.findFirst\|prisma.taskRun.findFirst" apps/webapp/app/v3/presenters/ 2>/dev/null | head -5
grep -rln "ApiRetrieveRunPresenter\|RetrieveRunPresenter" apps/webapp/app/ 2>/dev/null | head -5
```

Open the presenter — locate where it queries Postgres for a TaskRun by friendlyId and where it would return null/404 on miss.

- [ ] **Step 2: Wire the fallback at the PG-miss point**

Add an import:
```ts
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
```

Replace the PG-miss return-null path with a call to the fallback. Roughly:

```ts
const pgRow = await this.prisma.taskRun.findFirst({
  where: { friendlyId: runId, runtimeEnvironmentId: environment.id },
  select: { /* existing select */ },
});

if (pgRow) {
  return this.formatExistingRow(pgRow);
}

const buffered = await findRunByIdWithMollifierFallback({
  runId,
  environmentId: environment.id,
  organizationId: environment.organizationId,
});

if (buffered) {
  return this.formatSyntheticRow(buffered);
}

return null;
```

You'll need to add a `formatSyntheticRow` method to the presenter that converts a `SyntheticRun` into the same shape `formatExistingRow` produces. Most fields default to sensible values: `attempts: 0`, `executionState: "QUEUED"`, `output: undefined`, etc. The dashboard already handles `QUEUED` runs that lack output/start time, so the synthetic shape just needs to populate the fields the formatter reads.

- [ ] **Step 3: Run typecheck**

```bash
pnpm run typecheck --filter webapp
```
Expected: PASS. Any type errors point to fields the presenter expects that `SyntheticRun` doesn't carry — extend `SyntheticRun` (and re-run Task 2/3 tests) to add them.

- [ ] **Step 4: Commit**

```bash
git add apps/webapp/app/v3/presenters/<file> apps/webapp/app/routes/<file>
git commit -m "feat(webapp): wire mollifier read-fallback into runs retrieve presenter"
```

---

## Task 19: Wire read-fallback into the dashboard run-detail loader

**Files:**
- Modify: `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam._index.tsx`

This route powers the dashboard run detail page. Its loader fetches the run from Postgres.

- [ ] **Step 1: Find the loader's PG fetch**

```bash
grep -n "taskRun.findFirst\|prisma.taskRun" apps/webapp/app/routes/_app.orgs.\$organizationSlug.projects.\$projectParam.env.\$envParam.runs.\$runParam._index.tsx
```

- [ ] **Step 2: Add the fallback at the PG-miss point**

Same pattern as Task 18: PG-miss → check `findRunByIdWithMollifierFallback` → format synthesised result.

The loader also needs to set a flag in the returned data so the page can render the MollifierBanner (Task 22):

```ts
const buffered = await findRunByIdWithMollifierFallback({
  runId,
  environmentId: env.id,
  organizationId: organization.id,
});

if (buffered) {
  return { run: synthesise(buffered), isMollified: true };
}
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/webapp/app/routes/_app.orgs.\$organizationSlug.projects.\$projectParam.env.\$envParam.runs.\$runParam._index.tsx
git commit -m "feat(webapp): wire mollifier read-fallback into dashboard run-detail loader"
```

---

## Task 20: Dashboard "Recently queued" section

**Files:**
- Create: `apps/webapp/app/components/runs/RecentlyQueuedSection.tsx`
- Modify: `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index.tsx`

The runs list query doesn't consult the buffer (it's paginated PG queries). Add a separate section above the list rendered from the buffer directly.

- [ ] **Step 1: Add a helper to list buffer entries for an env (read-only)**

The phase 1 `MollifierBuffer` doesn't have a "list entries for env" method. Add one to the buffer in `packages/redis-worker/src/mollifier/buffer.ts`:

```ts
  async listEntriesForEnv(envId: string, maxCount: number): Promise<BufferEntry[]> {
    const queueKey = `mollifier:queue:${envId}`;
    const runIds = await this.redis.lrange(queueKey, 0, maxCount - 1);
    const entries: BufferEntry[] = [];
    for (const runId of runIds) {
      const entry = await this.getEntry(runId);
      if (entry) entries.push(entry);
    }
    return entries;
  }
```

This uses `LRANGE` (non-destructive) so the entries stay in the queue and the drainer still picks them up.

Add a corresponding test in `buffer.test.ts`:

```ts
describe("MollifierBuffer.listEntriesForEnv", () => {
  redisTest("returns up to maxCount entries in queue order", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      entryTtlSeconds: 600,
      logger: new Logger("test", "log"),
    });

    try {
      await buffer.accept({ runId: "r1", envId: "env_a", orgId: "o1", payload: "{}" });
      await buffer.accept({ runId: "r2", envId: "env_a", orgId: "o1", payload: "{}" });
      await buffer.accept({ runId: "r3", envId: "env_a", orgId: "o1", payload: "{}" });

      const entries = await buffer.listEntriesForEnv("env_a", 2);
      expect(entries).toHaveLength(2);
      const runIds = entries.map((e) => e.runId);
      expect(new Set(runIds)).toEqual(new Set(["r1", "r2", "r3"]).difference(new Set([runIds[0], runIds[1]])));
      // (the exact order depends on LPUSH semantics; we only assert we got 2 of the 3)
    } finally {
      await buffer.close();
    }
  });
});
```

Run the test, confirm it fails, implement the method, confirm it passes, commit.

- [ ] **Step 2: Create the Recently Queued component**

Create `apps/webapp/app/components/runs/RecentlyQueuedSection.tsx`:

```tsx
import type { BufferEntry } from "@trigger.dev/redis-worker";

export function RecentlyQueuedSection({ entries }: { entries: BufferEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="rq-section">
      <h3>Recently queued</h3>
      <ul>
        {entries.map((entry) => (
          <li key={entry.runId}>
            <span className="rq-run-id">{entry.runId}</span>
            <span className="rq-status">{entry.status === "FAILED" ? "Failed" : "Queued"}</span>
            <span className="rq-time">{entry.createdAt.toISOString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

This is a minimal first cut; styling follows the existing dashboard conventions (look at adjacent components in `apps/webapp/app/components/runs/`).

- [ ] **Step 3: Wire into the run-list loader**

In the run-list route loader, after the paginated PG query, fetch buffer entries:

```ts
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";

const buffer = getMollifierBuffer();
const recentlyQueued = buffer ? await buffer.listEntriesForEnv(env.id, 50) : [];
```

Return `recentlyQueued` in the loader data. Render the component above the paginated table.

- [ ] **Step 4: Run typecheck**

```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/redis-worker/src/mollifier/buffer.ts packages/redis-worker/src/mollifier/buffer.test.ts apps/webapp/app/components/runs/RecentlyQueuedSection.tsx apps/webapp/app/routes/_app.orgs.\$organizationSlug.projects.\$projectParam.env.\$envParam.runs._index.tsx
git commit -m "feat(webapp): Recently queued section on run-list, listEntriesForEnv helper"
```

---

## Task 21: Dashboard dismissible banner on mollified run detail

**Files:**
- Create: `apps/webapp/app/components/runs/MollifierBanner.tsx`
- Modify: `apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam._index.tsx` (the run detail page from Task 19)

- [ ] **Step 1: Create the banner component**

Create `apps/webapp/app/components/runs/MollifierBanner.tsx`:

```tsx
import { useState } from "react";

const DISMISSED_KEY = "mollifier_banner_dismissed";

export function MollifierBanner({ orgFeatureFlags }: { orgFeatureFlags: Record<string, unknown> | null }) {
  const initiallyDismissed =
    (orgFeatureFlags as Record<string, unknown> | null)?.[DISMISSED_KEY] === true;
  const [dismissed, setDismissed] = useState(initiallyDismissed);

  if (dismissed) return null;

  return (
    <div className="mollifier-banner">
      <strong>This run was accepted into the burst buffer.</strong>
      <p>
        Your environment exceeded the burst threshold and we smoothed the write pressure to
        protect overall service health. For high-fan-out workloads, consider using{" "}
        <a href="https://trigger.dev/docs/triggering#batchtrigger">batchTrigger</a> which is
        optimised for this pattern.
      </p>
      <button
        onClick={async () => {
          await fetch("/api/v1/org/feature-flags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [DISMISSED_KEY]: true }),
          });
          setDismissed(true);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
```

This assumes an `/api/v1/org/feature-flags` endpoint exists or will be added. If no per-org-settable feature flag endpoint exists, the simplest path is to dismiss client-side via localStorage and skip server persistence for now. Choose the simpler path:

```tsx
// localStorage-only dismissal (no API call)
const [dismissed, setDismissed] = useState(() => {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem("mollifier_banner_dismissed") === "true";
});
// onClick: localStorage.setItem(..., "true") + setDismissed(true)
```

For Phase 2 default to localStorage; per-org server persistence can come in a follow-up.

- [ ] **Step 2: Render in the run-detail loader's view**

In the run-detail route, conditionally render the banner when `isMollified === true` (from Task 19's loader data):

```tsx
{loaderData.isMollified && <MollifierBanner orgFeatureFlags={null} />}
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm run typecheck --filter webapp
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/webapp/app/components/runs/MollifierBanner.tsx apps/webapp/app/routes/_app.orgs.\$organizationSlug.projects.\$projectParam.env.\$envParam.runs.\$runParam._index.tsx
git commit -m "feat(webapp): dismissible mollifier banner on mollified run detail"
```

---

## Task 22: Manual validation gate — dashboard visual checks

**WHO:** user (this requires viewing the dashboard).

Hand off to the user for visual confirmation. The agent cannot judge whether the layout reads naturally.

- [ ] **Step 1: Mollifier enabled for the test org**

Same setup as Task 13. With buffer entries still draining, navigate to the dashboard for that org's project/env.

- [ ] **Step 2: User confirms the following**

Ask the user to navigate to:

1. **Run list** (`http://localhost:3030/orgs/<slug>/projects/<slug>/env/dev/runs`) — confirm the "Recently queued" section appears above the paginated list when buffer has entries. Confirm it collapses/disappears when buffer is empty.
2. **Run detail** for a buffered run (`.../runs/<run_friendlyId>`) — confirm the banner renders, copy reads sensibly, "Dismiss" button works, dismissed state persists across page refresh.
3. **Run detail** for a normal (non-buffered) run — confirm no banner appears.

- [ ] **Step 3: User reports any UX issues**

If the user reports issues:
- Banner copy reads poorly → adjust the text in `MollifierBanner.tsx`
- Recently queued section is too prominent / hidden → adjust styling
- Banner doesn't dismiss → fix localStorage logic

Fix and re-run this gate before proceeding.

---

## Task 23: Stress harness validation — Aurora-impact test

**WHO:** agent.

The whole point of the mollifier is to flatten the Postgres write-rate curve during bursts. This gate confirms that empirically.

- [ ] **Step 1: Baseline measurement (mollifier off)**

```bash
# webapp running with MOLLIFIER_ENABLED=0
# in a separate shell, observe Postgres active connection / transaction rate via psql or pg_stat_activity
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity WHERE state='active';"
```

Fire a 1000-fan-out:

```
mcp__trigger__trigger_task(
  projectRef: "...",
  environment: "dev",
  taskId: "stress-fan-out-trigger",
  payload: { "count": 1000, "concurrency": 1000 }
)
```

During the burst, sample `pg_stat_activity` count every second for ~10 seconds. Note the peak and the time to "fulfilled: 1000".

- [ ] **Step 2: Comparison measurement (mollifier on)**

Restart webapp with mollifier enabled:
```bash
MOLLIFIER_ENABLED=1 MOLLIFIER_SHADOW_MODE=0 \
  MOLLIFIER_TRIP_WINDOW_MS=200 MOLLIFIER_TRIP_THRESHOLD=100 MOLLIFIER_HOLD_MS=500 \
  MOLLIFIER_DRAIN_CONCURRENCY=50 \
  pnpm run dev --filter webapp
```

Same fan-out, same observation method.

- [ ] **Step 3: Compare**

Expected (the whole point of this work):
- Mollifier-off: PG active-transaction peak is higher; total wall time to 1000 runs in PG may be similar or shorter.
- Mollifier-on: PG active-transaction peak is lower (flatter curve); total wall time slightly longer (the smoothing trade-off).

Document both runs in the PR description as before/after.

**If mollifier-on doesn't show a flatter curve**: the drainer's concurrency cap is too high or the trip threshold is too lax — neither would actually smooth anything. Investigate before merge.

---

## Task 24: Server-changes note + rollout playbook

**Files:**
- Create: `.server-changes/mollifier-phase-3-live.md`
- Create: `_plans/mollifier-rollout-playbook.md`

- [ ] **Step 1: Server-changes note**

Create `.server-changes/mollifier-phase-3-live.md`:

```markdown
---
area: webapp
type: feature
---

Activate the trigger mollifier end-to-end (Phase 2). When a per-env-enabled environment trips the per-env rate threshold, the trigger is diverted into a Redis buffer and drained back into Postgres at a controlled rate, smoothing burst-write pressure. Read paths (runs retrieve, list, attempts, events, trace, tags, metadata, result, dashboard run detail) transparently fall back to the buffer for `QUEUED` synthesis until persisted. Mutation paths (cancel, tags PUT, metadata PUT, replay) apply atomically to buffered entries via Lua. Optional `notice` field on `TriggerTaskResponse`. OTEL `mollifier.queued` / `mollifier.drained` / `mollifier.drain_failed` spans + structured logs. Dashboard renders a "Recently queued" section and a dismissible banner on mollified run details. Defaults to off; toggle per-env via the FeatureFlag table (`mollifierEnabled:{envId}` gate, `mollifierDrainEnabled:{envId}` drain).
```

- [ ] **Step 2: Rollout playbook**

Create `_plans/mollifier-rollout-playbook.md`:

```markdown
# Mollifier rollout playbook (TRI-8654)

## Pre-rollout
- [ ] All phase 3 PR validation gates passed (read fallback, drainer, OTEL spans, dashboard, Aurora-impact)
- [ ] `MOLLIFIER_REDIS_*` env vars set in target env (test cloud first, then prod)
- [ ] Alarms in Axiom for `mollifier.drained.dwell_ms` p99 (alarm threshold: > 2000ms) and `mollifier.decisions{outcome="mollify"}` rate baseline established

## Test cloud
- [ ] Set `MOLLIFIER_ENABLED=1`, `MOLLIFIER_SHADOW_MODE=0` in test cloud config
- [ ] Confirm Task A1 data migration has seeded `mollifierEnabled:{envId}` + `mollifierDrainEnabled:{envId}` for all existing envs at value `false` (gate) / `true` (drain) — verify no behavioural change for any env on boot
- [ ] Enable for one internal test env via admin tooling (A13): set `mollifierEnabled:{envId} = true`
- [ ] Run a synthetic burst from the stress-tasks project on test cloud
- [ ] Confirm dashboards (A12): trip rate > 0, dwell p99 < 2s, `mollifier.buffer.oldest_age_ms` returns to 0 between bursts, zero FAILED entries
- [ ] Leave running for 24h, monitor

## Production — first customer
- [ ] Identify the first affected customer (one of the orgs that triggered TRI-8654 incidents)
- [ ] Communicate with the customer if appropriate: "we're rolling out a burst-handling improvement"
- [ ] Set `mollifierEnabled:{envId} = true` for each of their envs via admin tooling (A13)
- [ ] Observe for 24h: dwell p99, trip rate, `mollifier.buffer.oldest_age_ms`, no anomalies in their dashboard
- [ ] Confirm with customer there are no reported regressions

## Production — expansion
- [ ] Enable for the remaining ~2 affected customers (per the TRI-8654 correlation set), env-by-env
- [ ] Observe for 24h each
- [ ] Decide global rollout vs. continuing selective-only

## Kill switches (per O2)
Operator state matrix:

| gate (`mollifierEnabled:{envId}`) | drain (`mollifierDrainEnabled:{envId}`) | meaning |
| --- | --- | --- |
| true | true | normal Phase 2 |
| true | false | degraded — accepting works, nothing drains; buffer fills, entries TTL. Use briefly during drain-specific incident. |
| false | true | safe — direct trigger; drainer flushes residual buffered entries. |
| false | false | full off; residual entries TTL out. |

- Single-env disable: flip that env's two flags via A13.
- Fleet-wide kill: use A13 bulk-flip CLI to set all `mollifierEnabled:*` to false (gate off everywhere; drain stays on to flush residue).
- Hard global off (process-level): set `MOLLIFIER_ENABLED=0` env var and restart webapp. Reverts to pre-Phase-1 behaviour everywhere.
```

- [ ] **Step 3: Commit**

```bash
git add .server-changes/mollifier-phase-3-live.md _plans/mollifier-rollout-playbook.md
git commit -m "docs: mollifier phase 3 server-changes + rollout playbook"
```

---

## Task 25: Final verification

**Files:** none

- [ ] **Step 1: Typecheck + build**

```bash
pnpm run typecheck --filter webapp &
pnpm run typecheck --filter @internal/run-engine &
pnpm run build --filter @trigger.dev/core &
pnpm run build --filter @trigger.dev/redis-worker &
wait
```
Expected: all exit 0.

- [ ] **Step 2: Tests**

```bash
pnpm run test --filter @trigger.dev/redis-worker
pnpm --filter webapp test app/v3/mollifier/
```
Expected: all pass.

- [ ] **Step 3: Behavioural equivalence with main when MOLLIFIER_ENABLED=0**

Restart with default env (no MOLLIFIER_ENABLED). Fire a 1000-fan-out. Confirm:
- All 1000 runs land in PG
- No `mollifier:*` keys in Redis
- No `mollifier.would_mollify` log entries
- Identical timing to main (within stress noise)

- [ ] **Step 4: Self-review the diff**

```bash
git log --oneline main..HEAD
git diff main..HEAD --stat
```

Sanity:
- All mollifier-related changes are under `apps/webapp/app/v3/mollifier/`, the route/presenter wiring in apps/webapp, the snapshot schema field in packages/core, the buffer.ts addition in redis-worker.
- The dashboard route changes are localised to the run-list and run-detail loaders.
- No `console.log` in production paths.
- No comments explaining what the code does — only why for non-obvious constraints.

- [ ] **Step 5: Mark this plan complete**

Append to the top of this plan document:

```markdown
> **Phase 2 status:** Implementation complete on commit `<sha>`. All manual validation gates passed on `<date>`. Per-org rollout playbook at `_plans/mollifier-rollout-playbook.md`. Ready for review.
```

Replace `<sha>` with `git rev-parse HEAD` and `<date>` with today.

- [ ] **Step 6: Commit**

```bash
git add _plans/2026-05-11-trigger-mollifier-phase-3.md
git commit -m "docs: mark mollifier Phase 2 implementation complete"
```

---

## Additional tasks (post-brainstorm)

The Tasks 1–25 above describe the core implementation. The brainstorm produced these additional tasks (A1–A14) that bolt on the C-concerns, O-concerns, F-concerns, API surface coverage, and engine helpers. They can be sequenced into the existing TDD flow — typically each is a failing-tests-first + implementation + commit pair, mirroring the Tasks 1–25 style.

Sequence guidance: A1 must run before any per-env-flag dependent task (i.e. before Task 17 in the rewritten form). A5 + A6 can land in parallel with the drainer-handler tasks (10–12). A9-* can land in parallel with the dashboard tasks (18–21). A11 lands with or right after Task 12.

---

### Task A1: Per-env FeatureFlag data migration

**Files:**
- Create: `apps/webapp/prisma/migrations/<timestamp>_mollifier_per_env_flags/migration.sql` (or whatever the Prisma migrations directory layout is — confirm via `ls internal-packages/database/prisma/migrations | tail -3`)

One-time data migration that seeds every existing environment with per-env flag rows derived from the Phase 1 global `mollifierEnabled` value.

- [ ] **Step 1: Read the Phase 1 global value**

```sql
SELECT value FROM "FeatureFlag" WHERE key = 'mollifierEnabled';
```

Capture as `<global_value>` (boolean — typically `false` at Phase 2 cutover).

- [ ] **Step 2: Insert per-env rows for both gate and drain**

```sql
INSERT INTO "FeatureFlag" (key, value)
SELECT 'mollifierEnabled:' || re.id, to_jsonb(<global_value>::boolean)
FROM "RuntimeEnvironment" re
ON CONFLICT (key) DO NOTHING;

INSERT INTO "FeatureFlag" (key, value)
SELECT 'mollifierDrainEnabled:' || re.id, to_jsonb(true)
FROM "RuntimeEnvironment" re
ON CONFLICT (key) DO NOTHING;
```

Drain defaults to `true` (so the drainer flushes anything that lands once Phase 2 is on); gate inherits the global. Both keys are idempotent on conflict.

- [ ] **Step 3: Leave the old global key in place during transition**

The global `mollifierEnabled` row stays for one release cycle as a safety net (cheap to re-seed from later). A follow-up cleanup removes it.

- [ ] **Step 4: Tests**

containerTest that fires the migration on a populated test DB and asserts row counts match `RuntimeEnvironment` count × 2.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(database): seed per-env mollifier feature flags from global value"
```

---

### Task A2: Shared `resolveRunHandle` resolver

**Files:**
- Create: `apps/webapp/app/v3/mollifier/resolveRunHandle.server.ts`
- Create: `apps/webapp/app/v3/mollifier/resolveRunHandle.test.ts`

Postgres-first, Redis fallback. Single helper reused by every endpoint listed in "API surface coverage" above.

- [ ] **Step 1: Failing tests for all three return shapes**

```ts
describe("resolveRunHandle", () => {
  it("returns { source: 'postgres', run } when row exists", async () => { /* ... */ });
  it("returns { source: 'redis', entry } when PG misses but buffer hits", async () => { /* ... */ });
  it("returns { source: 'not_found' } when both miss", async () => { /* ... */ });
  it("returns 'postgres' even if entry also exists (PG wins after drain)", async () => {
    // covers the C4 race: PG row exists, Redis entry retained until TTL.
  });
});
```

- [ ] **Step 2: Implement**

```ts
export async function resolveRunHandle(friendlyId: string, envId: string, orgId: string): Promise<
  | { source: "postgres"; run: PrismaTaskRun }
  | { source: "redis"; entry: BufferEntry }
  | { source: "not_found" }
> { /* ... */ }
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(webapp): resolveRunHandle shared resolver (Postgres → Redis fallback)"
```

---

### Task A3: Extend buffer accept Lua with idempotency claim + mutation fields

**Files:**
- Modify: `packages/redis-worker/src/mollifier/lua/accept.lua`
- Modify: `packages/redis-worker/src/mollifier/buffer.ts`
- Modify: `packages/redis-worker/src/mollifier/buffer.test.ts`

Per C2: single Lua script does atomic claim + entry-accept, returning `{status: "fresh" | "claimed", runFriendlyId}`.

- [ ] **Step 1: Failing test for the claim path**

```ts
redisTest("accept with idempotencyKey: first call returns fresh; second returns claimed with original runFriendlyId", async () => {
  const r1 = await buffer.accept({ runId: "r1", idempotencyKey: "k", ... });
  expect(r1).toEqual({ status: "fresh", runFriendlyId: "r1" });
  const r2 = await buffer.accept({ runId: "r2", idempotencyKey: "k", ... });
  expect(r2).toEqual({ status: "claimed", runFriendlyId: "r1" });
});
```

- [ ] **Step 2: Extend the Lua script**

Lua atomically:
1. If `idempotencyKey` provided, `SET mollifier:claim:{key} {runFriendlyId} NX EX {ttl}` — capture whether SET happened.
2. If claimed by another, return `{ "claimed", existingRunFriendlyId }`.
3. Otherwise, run the existing accept flow (write entry hash, LPUSH queue, SADD envs-set) and return `{ "fresh", runFriendlyId }`.

Also extend the entry hash schema with empty `tags`, `metadata`, `cancelled` fields for future Lua mutations (A7).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(redis-worker): atomic idempotency claim in accept Lua + entry mutation fields"
```

---

### Task A4: Cleanup Lua — atomic claim delete + entry status transition on terminal drain

**Files:**
- Create: `packages/redis-worker/src/mollifier/lua/cleanup.lua`
- Modify: `packages/redis-worker/src/mollifier/buffer.ts` (add `terminalAck` / `terminalFail` methods that invoke cleanup Lua)
- Modify: `packages/redis-worker/src/mollifier/buffer.test.ts`

On terminal drain (success, fail, or cancel), the claim is deleted and the entry's status transitions to DONE / FAILED / CANCELLED. Entry hash is **not** deleted (per C4 — retained until TTL).

- [ ] **Step 1: Failing test**

```ts
redisTest("terminalAck: deletes claim, sets entry status=DONE, keeps entry hash", async () => {
  await buffer.accept({ runId: "r1", idempotencyKey: "k", ... });
  await buffer.terminalAck("r1");
  expect(await redis.exists("mollifier:claim:k")).toBe(0);
  const entry = await buffer.getEntry("r1");
  expect(entry!.status).toBe("DONE");
});
```

- [ ] **Step 2: Implement cleanup Lua + buffer methods**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(redis-worker): cleanup Lua + terminalAck/terminalFail (retain entry, drop claim)"
```

---

### Task A5: `engine.recordBufferedRunFailure`

**Files:**
- Modify: `internal-packages/run-engine/src/engine/index.ts` (or the engine class file — grep `class RunEngine`)
- Modify: `internal-packages/run-engine/src/engine/tests/recordBufferedRunFailure.test.ts` (create)

Per C4. Writes a SYSTEM_FAILURE TaskRun row directly, hydrated from the buffered payload. **No** alerting / realtime / webhook side effects.

- [ ] **Step 1: Failing tests**

```ts
postgresTest("recordBufferedRunFailure writes a TaskRun row with SYSTEM_FAILURE status", async ({ prisma }) => { /* ... */ });
postgresTest("idempotent on friendlyId-uniqueness (P2002 caught)", async ({ prisma }) => { /* ... */ });
postgresTest("does NOT invoke alerting / realtime / webhook side effects", async ({ prisma }) => {
  // assert spies on alertingService / realtimeBroadcaster / webhookDispatcher are not called.
});
```

- [ ] **Step 2: Implement**

```ts
async recordBufferedRunFailure(payload: BufferedTriggerPayload, error: { code: string; message: string }) {
  try {
    await this.prisma.taskRun.create({ data: hydrateTaskRunFromBuffered(payload, "SYSTEM_FAILURE", error) });
  } catch (e) {
    if (isP2002(e)) return; // idempotent
    throw e;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(run-engine): recordBufferedRunFailure writes SYSTEM_FAILURE for terminal drain failures"
```

---

### Task A6: `engine.recordBufferedRunCancelled`

**Files:**
- Modify: same engine file as A5.
- Create: matching test.

Mirror of A5 — writes a CANCELED TaskRun row. Same idempotency + same side-effect-free contract.

- [ ] **Step 1: Failing tests** (analogous to A5).
- [ ] **Step 2: Implement** (analogous to A5).
- [ ] **Step 3: Commit:** `feat(run-engine): recordBufferedRunCancelled for buffered-cancel terminal drain`.

---

### Task A7: Mutation Lua scripts (cancel-entry, set-tags, set-metadata)

**Files:**
- Create: `packages/redis-worker/src/mollifier/lua/mutateEntry.lua`
- Modify: `packages/redis-worker/src/mollifier/buffer.ts` (add `cancelEntry`, `setTags`, `setMetadata`)
- Modify: `packages/redis-worker/src/mollifier/buffer.test.ts`

Each mutation is atomic: entry-status check + field update in one script. Cannot race the drainer (drainer pops with WATCH-equivalent semantics; mutations only succeed against QUEUED status).

- [ ] **Step 1: Failing tests**

```ts
redisTest("cancelEntry sets cancelled=true on QUEUED entry", async () => { /* ... */ });
redisTest("cancelEntry no-ops if entry status != QUEUED", async () => { /* ... */ });
redisTest("setTags merges tags atomically", async () => { /* ... */ });
redisTest("setMetadata replaces metadata atomically", async () => { /* ... */ });
```

- [ ] **Step 2: Implement mutateEntry.lua + buffer methods**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(redis-worker): atomic entry mutations (cancel, tags, metadata) via Lua"
```

---

### Task A8: Drainer reads mutated fields on pop

**Files:**
- Modify: `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`
- Modify: `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.test.ts`

When the drainer pops an entry, it reads:
- `cancelled` flag → if true, call `engine.recordBufferedRunCancelled(payload)` and short-circuit (no `engine.trigger`).
- Updated `tags` / `metadata` → propagate into the `engine.trigger(...)` call (override the snapshot's original values).

- [ ] **Step 1: Failing tests**

```ts
it("cancelled entry: calls recordBufferedRunCancelled, not engine.trigger", async () => { /* ... */ });
it("mutated tags propagate into engine.trigger call", async () => { /* ... */ });
it("mutated metadata propagates into engine.trigger call", async () => { /* ... */ });
```

- [ ] **Step 2: Implement** — extend the handler created in Tasks 11/15 to branch on `input.cancelled` and merge `input.tags` / `input.metadata` into the payload before invoking `engine.trigger`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(webapp): drainer applies buffered cancel + propagates mutated tags/metadata"
```

---

### Task A9: API endpoint coverage for buffered runs

Split into four sub-tasks for landing-in-pieces. Each sub-task is a TDD round (failing endpoint test → resolver wiring → green).

#### A9-reads: read endpoints (`api.v1.runs.$runId.attempts`, `.events`, `.spans.$spanId`, `.trace`, `.tags`, `.metadata` + `api.v3.runs.$runId` retrieve)

Each handler: call `resolveRunHandle`; on `source: "redis"`, synthesise the response from the entry (empty arrays / 404 / stub trace / entry tags or metadata). On `not_found`, fall through to today's 404.

#### A9-mutations: mutation endpoints (`api.v2.runs.$runParam.cancel`, `.tags` PUT, `.metadata` PUT, `.replay`, `.reschedule`)

Each handler: `resolveRunHandle`; on `source: "redis"`, invoke the matching Lua mutation (A7) or return 400 for reschedule. Replay reads payload from entry, calls `trigger()` with a new friendlyId.

#### A9-waits: wait endpoints (`api.v1.runs.$runParam.result`, `.input-streams.wait`, `.session-streams.wait`)

Simple long-poll: loop `resolveRunHandle` until `source === "postgres"` or entry status terminal (FAILED / CANCELED). Then forward to existing waitpoint flow. Timeout configurable; cap at existing endpoint's max-wait.

#### A9-list: list endpoint (`api.v1.runs`)

UNION Postgres rows with buffered Redis entries matching the filter. Status filters that include QUEUED must UNION; terminal-status filters are Postgres-only.

Each sub-task ends with its own commit.

---

### Task A10: Buffer TTL bump

**Files:**
- Modify: `apps/webapp/app/env.server.ts` (or the env-var schema file)
- Modify: `apps/webapp/app/v3/mollifier/mollifierBuffer.server.ts` (read the new env var)

Default `MOLLIFIER_BUFFER_TTL_SECONDS` to 3600 (up from Phase 1's 600). No TTL refresh on drainer retries. Add a unit test asserting the buffer's `entryTtlSeconds` matches the env var.

Commit: `feat(webapp): default MOLLIFIER_BUFFER_TTL_SECONDS to 3600 per Phase 2 O3`.

---

### Task A11: Per-env drainer iteration + per-env concurrency cap + per-env drain flag

**Files:**
- Modify: `packages/redis-worker/src/mollifier/drainer.ts`
- Modify: `apps/webapp/app/v3/mollifier/mollifierDrainer.server.ts`
- Modify: `apps/webapp/app/env.server.ts`
- Modify: `packages/redis-worker/src/mollifier/drainer.test.ts`

Per O1 + O2:
- Add `MOLLIFIER_DRAIN_PER_ENV_CONCURRENCY` env var (default 2).
- Drainer iterates envs round-robin; tracks in-flight count per env; pops next item only if env's in-flight < per-env cap.
- Drainer also reads `mollifierDrainEnabled:{envId}` per env per iteration; envs with drain disabled are skipped.

- [ ] **Step 1: Failing test for env starvation prevention**

```ts
redisTest("one env with 1000 entries does not starve another env with 10", async () => {
  // accept 1000 entries for envA, 10 for envB
  // start drainer with per-env cap = 2
  // assert envB's entries drained within X ms despite envA's backlog
});
```

- [ ] **Step 2: Failing test for `mollifierDrainEnabled:{envId} = false` skips that env**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(redis-worker): per-env drain concurrency cap + per-env drain flag"
```

---

### Task A12: Telemetry additions + Axiom dashboards

**Files:**
- Modify: `apps/webapp/app/v3/mollifier/mollifierMetrics.server.ts` (Phase 1 — extend)
- Modify: `apps/webapp/app/v3/mollifier/mollifierDrainerHandler.server.ts`
- Modify: `apps/webapp/app/v3/mollifier/mollifierMollify.server.ts`
- Create: `_plans/mollifier-axiom-dashboard.md` (panel spec — actual dashboard creation happens via Axiom MCP at rollout time)

Per O4 — add all counters / gauges / histograms / structured logs listed in the "Operational concerns" section. Cardinality decision: aggregate metrics no envId label, except buffer.depth + buffer.oldest_age_ms which carry envId.

Sub-steps:
- [ ] Add `mollifier.drain_failed` structured log + `mollifier.drain.failures{reason}` counter.
- [ ] Add `mollifier.idem.cache_hits` counter (incremented in the mollify path on `accept`-returns-`claimed`).
- [ ] Add `mollifier.buffer.depth` + `mollifier.buffer.oldest_age_ms` gauges (computed during drainer per-iteration scan).
- [ ] Add `mollifier.drain.latency_ms` + `mollifier.buffer.entry_age_ms_at_pop` histograms.
- [ ] Document Axiom panel specs (3 panels minimum): decisions over time; buffer depth + oldest age dual-axis; drain success vs failure with reason breakdown.
- [ ] Document alert thresholds (P1: oldest_age_ms > 30 min for 1 min; drain failures > 5% over 5 min. P2: depth growing monotonically 10 min; idem cache_hits rate spike).

Commit: `feat(webapp): mollifier telemetry per Phase 2 O4 (counters, gauges, histograms, dashboards)`.

---

### Task A13: Admin tooling for bulk flag flip

**Files:**
- Create: `apps/webapp/app/routes/admin.api.feature-flags.mollifier.tsx` (admin-only POST endpoint)
- OR: `apps/webapp/scripts/mollifier-flag-bulk.ts` (CLI script using `prisma` directly)

Either an admin HTTP endpoint or a CLI script that takes an envId list (or "all envs", or an org slug) + a target value, and fans out per-env writes for `mollifierEnabled` and/or `mollifierDrainEnabled`.

Operational use cases:
- "Kill drain everywhere" → set all `mollifierDrainEnabled:*` to false.
- "Enable for canary cohort" → set `mollifierEnabled:{envId}` to true for a list of envIds.
- "Full revert for org X" → set all envs of org X to gate=false.

Tests: unit test that the bulk-set produces the right number of writes; integration test that idempotent re-runs are no-ops.

Commit: `feat(webapp): admin tooling for bulk per-env mollifier flag flips`.

---

### Task A14: Customer docs note for F1/F3 deferral

**Files:**
- Modify: `docs/runs/realtime.mdx` (or whichever Mintlify page covers realtime streams — grep `realtime` in `docs/`)
- Modify: `docs/runs/overview.mdx` (brief mention)

Add a sentence:

> During platform-imposed buffering windows, realtime streams (`runs.subscribe`, dashboard live updates) may be temporarily silent. The run still completes normally; refreshing the page after a few seconds restores live updates. This affects only burst-protected environments and is invisible to the standard `runs.retrieve` / `runs.result` APIs.

Commit: `docs: note realtime-stream behaviour during mollifier buffering windows`.

---

## Phase 2 final state

When Phase 2 is merged and per-env rollout has reached its target set:

1. **`mollifier:entries:*`, `mollifier:queue:*`, `mollifier:claim:*` populated** during bursts in enabled envs; drained sub-second p99 in healthy conditions.
2. **Aurora active-transaction peak flattened** during bursts (verified per Task 23).
3. **API contract unchanged for callers** — same 200 OK + run friendlyId. Optional `notice` field is additive. All customer-facing run-handle endpoints (retrieve, attempts, events, trace, tags, metadata, result, cancel, replay, list) transparently resolve buffered runs.
4. **SDK consumers unaffected** — old SDKs that strip the `notice` field via zod's default behaviour see identical responses to today.
5. **Read paths transparent** — `runs.retrieve(id)` on a mollified run returns `status: "QUEUED"` (existing `TaskRunStatus` enum value, per C5) until drained, then the persisted state.
6. **Mutation paths transparent** — cancel, tags PUT, metadata PUT, replay all work on buffered runs via atomic Lua mutations of the entry.
7. **Dashboard** — `QUEUED` rendering for buffered runs, dismissible banner on mollified run details, "Recently queued" section on the run-list view. Live realtime streams (F1/F3) deferred — customers notified via docs.
8. **OTEL + structured logs** — `mollifier.queued`, `mollifier.drained`, `mollifier.drain_failed` with `mollifier.reason`, `mollifier.count`, `mollifier.threshold`, `mollifier.dwell_ms` attributes. Metrics per O4 (decisions counter, buffer depth + oldest age gauges, drain latency histogram, idem cache-hit counter). Alerts wired to existing webapp on-call rotation.
9. **Per-env rollout** — gate via `mollifierEnabled:{envId}`, drain via `mollifierDrainEnabled:{envId}`. Hard global kill switch via `MOLLIFIER_ENABLED=0`. C1/C3/F4 bypasses for debounce / OneTimeUseToken / `triggerAndWait` cases.
10. **Engine helpers** — `engine.recordBufferedRunFailure` (C4) and `engine.recordBufferedRunCancelled` (F2) write terminal rows directly, bypassing the normal lifecycle pipeline.
11. **Scope limit** — V2 engine only. V1 callV1 path is out of scope (architectural limit; TRI-8654 customers are all V2).
12. **Deferred (phases 4+)** — Electric / realtime live-stream integration (F1/F3), adaptive drain cap, circuit breaker on mollifier Redis client, durability hardening, sharding, S3-fronted trigger.

---

## Self-review

**Spec coverage** — checked against `_plans/trigger-mollifier-design.md` "Phase 3 — Live mollifier":

- ✅ Trip → buffer write → drainer persists: Tasks 7, 8, 12 (mollify path + drainer wiring)
- ✅ Read-path fallback active: Tasks 3, 18, 19 + A2/A9-reads (resolver + endpoint coverage)
- ✅ Dashboard QUEUED rendering + banner + "Recently queued": Tasks 20, 21, 22
- ✅ OTEL spans: Tasks 8 (queued span), 15 (drained span); A12 adds drain_failed + idem cache_hits + gauges/histograms
- ✅ Optional notice on response body: Task 14
- ✅ Per-env rollout: Task 17 (per-env gate + C1/C3/F4 bypasses) + A1 (data migration) + A11 (per-env drain flag + concurrency cap) + A13 (admin bulk tooling) + Task 24 (playbook)
- ✅ C2 idempotency Redis index: A3 (extended accept Lua) + A4 (cleanup Lua)
- ✅ C4 read-fallback + FAILED durability: A5 (`engine.recordBufferedRunFailure`) + Task 2 design note
- ✅ F2 cancel + tags/metadata mutations: A6 + A7 + A8
- ✅ A9 endpoint coverage: reads, mutations, waits, list
- ✅ A11 per-env drain concurrency, A10 buffer TTL bump
- ✅ A14 customer docs note for F1/F3 deferral
- ✅ Behavioural equivalence with default env vars: Task 25 step 3

**Placeholder scan:**
- Task 5 has a deliberate "see Step 1 grep" pointer because the engine.trigger input shape lives in `@internal/run-engine` and the agent should read the current source rather than rely on a stale type definition baked into the plan.
- Task 18 and 19 use grep-then-implement because the presenter and dashboard route filenames have long Remix prefixes that vary as the codebase evolves; the precise paths must be discovered by the implementer.
- Task 4 manual gate explicitly invites the implementer to extend `SyntheticRun` if the presenter reads fields not covered — this is a deliberate gate, not a placeholder.

**Type consistency check:**
- `MollifierSnapshot = Record<string, unknown>` — consistent in Tasks 1, 6, 7, 10, 11, 12.
- `SyntheticRun` shape — consistent in Tasks 2, 3, 18, 19. Tasks 18/19 may extend it; if so, Task 2 tests are updated.
- `TripDecision` divert-true shape (`count`, `threshold`, `windowMs`, `holdMs`) inherited from Phase 1; consistent in Tasks 6, 7, 8, 17.
- `MollifierDrainerHandler<MollifierSnapshot>` — consistent in Tasks 11, 12.

**Validation gate coverage:**
- After read-fallback (Task 4): agent confirms shape sanity.
- After mollify wiring (Task 9): agent confirms buffer entries + response notice.
- After drainer wiring (Task 13): agent confirms drain to PG.
- After OTEL (Task 16): agent confirms span + notice visibility.
- After dashboard (Task 22): user confirms visual UX.
- Final (Task 23): agent confirms Aurora-impact flattening.
- Pre-merge (Task 25 step 3): agent confirms zero regression with default env vars.

No gaps. Plan ready for user review.
