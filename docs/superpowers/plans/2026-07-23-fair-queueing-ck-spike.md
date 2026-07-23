# Per-concurrency-key fairness spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox syntax.

**Goal:** Rank baseline (age-order) vs SFQ/DRR/stride/CoDel on per-concurrency-key fairness by driving the real CK-dequeue Lua and controlling `ckIndex` scores.

**Architecture:** Enqueue runs across many concurrency keys under one base queue via the real `RunQueue`. For candidates, rewrite the `ckIndex` ZSET scores before each dequeue round so the unmodified `dequeueMessagesFromCkQueueTracked` Lua serves keys in the discipline's order; baseline leaves scores untouched (production). Reuse the base-queue spike's workload and metrics.

**Tech Stack:** TypeScript, vitest, `@internal/testcontainers`, `@internal/run-engine` (RunQueue, keyProducer), `@internal/redis`.

## Global Constraints

- All code under `internal-packages/run-engine/src/run-queue/fairness-spike-ck/`. Reuse `../fairness-spike/harness/{workload,metrics}.ts` and disciplines where they transfer. Throwaway; delete before merge.
- Fairness group = concurrency key. One org/project/env, one base queue, many CKs.
- No production Lua edits. The `ckIndex` rescore sweep is the only affordance; discipline state advances via an `onServiced(concurrencyKey)` hook.
- Determinism: seeded workload; logical clock owned by the driver.
- Verify: `cd internal-packages/run-engine && pnpm run test ./src/run-queue/fairness-spike-ck/<file> --run`.
- Commit with `but` on `chore/fair-queueing-ck-spike` (stacked on `chore/fair-queueing-spike`).

---

### Task 1: ckReader — read ckIndex members + head scores

**Files:** Create `fairness-spike-ck/ckReader.ts`; Test `fairness-spike-ck/tests/ckReader.test.ts`.

**Produces:** `type ActiveCk = { ckQueue: string; concurrencyKey: string; headScore: number }`; `class CkReader { constructor(redis, keys); readActiveCks(baseQueue): Promise<ActiveCk[]> }`. Reads `ZRANGE ckIndexKey WITHSCORES` for the base queue; member is the prefixless CK-queue name; `concurrencyKey` from `descriptorFromQueue(keyPrefix+member)`.

- [ ] Write `redisTest`: enqueue 2 runs with concurrencyKeys "ck1","ck2" under one base queue via real RunQueue; assert readActiveCks returns both with numeric headScores. First discover the exact ckIndex member format by dumping `ZRANGE ckIndexKey 0 -1` (grep enqueueMessageCkTracked Lua for the `ZADD ckIndexKey` member).
- [ ] Implement; run; commit.

### Task 2: ckRescorer — write discipline order into ckIndex

**Files:** Create `fairness-spike-ck/ckRescorer.ts`; Test `tests/ckRescorer.test.ts`.

**Produces:** `async function rescoreCkIndex(redis, keys, baseQueue, order: string[] /* ckQueues, highest priority first */, now: number)`. Assigns scores `now - (order.length - i)` so the highest-priority CK gets the smallest (oldest) score, all `<= now`, order-preserving. ZADD each member.

- [ ] Write `redisTest`: enqueue CKs, rescore with a chosen order, assert `ZRANGEBYSCORE ckIndexKey -inf now` returns that order.
- [ ] Implement; run; commit.

### Task 3: CK disciplines

**Files:** Create `fairness-spike-ck/disciplines.ts`; Test `tests/disciplines.test.ts`.

**Produces:** a `CkDiscipline` interface `{ name; order(active: ActiveCk[]): string[] /* ckQueues, best first */; onServiced(concurrencyKey): void; reset() }` with `Sfq`, `Drr`, `Stride` keyed by concurrency key, plus `Codel` wrapper and `Baseline` (order = by headScore asc, i.e. no rescore needed). Reuse the monotonic-floor SFQ/stride and DRR logic from the base-queue spike (import or copy the core, keyed by concurrencyKey).

- [ ] Unit tests mirroring the base-queue spike (under-served key first; 3:1 weight ratio if weights used; CoDel hoist/revert).
- [ ] Implement; run; commit.

### Task 4: ckDriver — enqueue, rescore, real dequeue, hold, ack

**Files:** Create `fairness-spike-ck/harness/ckDriver.ts`; Test `tests/ckDriver.smoke.test.ts`; fidelity test `tests/fidelity.test.ts`.

**Produces:** `runCkScenario(config): Promise<RunMetrics>` reusing `../fairness-spike/harness/metrics.ts`. Loop per instant: release holds (ack), enqueue arrivals (with concurrencyKey), for candidate: compute discipline order over active CKs and `rescoreCkIndex`; call `testDequeueFromMasterQueue`; record per-key events; `onServiced`; hold. Baseline skips the rescore.

- [ ] Fidelity test: baseline path per-key dequeue counts equal a direct `testDequeueFromMasterQueue`-only run (no rescore) — confirms the harness matches production age-order.
- [ ] Smoke: balanced CKs drain fully and no key starves under a fair discipline.
- [ ] Implement; run; commit.

### Task 5: scenarios + bench + FINDINGS

**Files:** Create `fairness-spike-ck/harness/ckScenarios.ts`, `ckFairnessSpike.bench.test.ts`, `FINDINGS.md`.

- [ ] Scenarios ckSkew / ckBalanced / ckTrickle, multi-seed (3), five selectors; write results JSON; print table.
- [ ] Run the matrix; sanity-check baseline starves under ckSkew and at least one candidate fixes it (or record if not).
- [ ] Write FINDINGS with proof/disproof per discipline at the CK grain and whether the base-queue ranking carried over. Commit.

## Self-Review

Covers the spec: ckReader (T1), rescorer (T2), disciplines incl. baseline (T3), driver + fidelity anchor (T4), scenarios/bench/findings (T5). Grain = concurrency key throughout. Reuses workload/metrics from the base-queue spike. The rescore affordance and onServiced seam are Global Constraints.
