# Fair-queueing scheduler spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a throwaway bench that ranks four fair-queueing selectors (SFQ, hierarchical DRR, stride, CoDel wrapper) against the current `FairQueueSelectionStrategy` on real Redis, and produce a proof/disproof verdict per mechanism.

**Architecture:** Each selector implements the real `RunQueueSelectionStrategy` interface and drops into a real `RunQueue` running against a testcontainers Redis. A synchronous driver enqueues synthetic runs across groups, dequeues via `RunQueue.testDequeueFromMasterQueue` (which runs the strategy and does real concurrency gating in Lua), holds a concurrency slot for a sampled duration, then acks. The driver records every dequeue event and feeds serviced descriptors back to stateful selectors via an `onServiced` hook. A metrics module turns recorded events into fairness/latency/cost numbers; a bench test runs the selector-by-scenario matrix and prints a ranking table.

**Tech Stack:** TypeScript, vitest, `@internal/testcontainers` (redisTest), `@internal/run-engine` internals (`RunQueue`, `RunQueueFullKeyProducer`, `FairQueueSelectionStrategy`), ioredis via `@internal/redis`, `seedrandom`.

## Discovery (pre-implementation, 2026-07-23)

Reading the real code before coding turned up the single most important fact for
this whole effort, so it is recorded here rather than buried in FINDINGS.

The `RunQueueSelectionStrategy` interface cannot express per-concurrency-key
fairness. `FairQueueSelectionStrategy.#allChildQueuesByScore`
(`fairQueueSelectionStrategy.ts:526`) reads the master queue members verbatim,
and for concurrency-keyed runs the enqueue path writes a single CK-*wildcard*
entry per base queue to the master queue (`index.ts:1899`, the #3219 change). The
per-CK pick happens later, inside the `dequeueMessagesFromCkQueueTracked` Lua
(`index.ts:4147`): `ckIndexKey` is a ZSET of CK-queues scored by head-message
timestamp, and the Lua selects them oldest-first
(`ZRANGEBYSCORE ckIndexKey -inf currentTime`). That age-ordering is the #2617
unfairness, and it sits below the selection-strategy interface, in Lua.

Decision: the spike stays behind the real strategy interface (the harness choice)
and sets the fairness grain to distinct base queues within one environment (one
base queue per group/tenant, no concurrency key). Non-CK enqueue writes each base
queue straight to the master queue scored by its earliest message
(`index.ts:3037`), so the strategy orders per-tenant base queues directly. The
four disciplines are grain-agnostic, so this is a real proof/disproof of each
mechanism against the real RunQueue with real concurrency gating. The exact
per-CK grain would require spiking the CK-dequeue Lua / `ckIndex` scoring
instead; that is a documented follow-on, and "per-CK fairness lives below the
strategy interface" is itself a headline finding for FINDINGS.

## Global Constraints

- All spike code lives under `internal-packages/run-engine/src/run-queue/fairness-spike/`. It is throwaway and ships nothing.
- Fairness grain is the base queue name (the groupId). Each group is one distinct base queue (no concurrency key) in one shared environment. See the Discovery note for why this grain, not the concurrency key.
- No changes to production files. Do not edit `index.ts`, `fairQueueSelectionStrategy.ts`, or any file outside `fairness-spike/`.
- Selectors advance internal state only via the `onServiced` hook, never by editing production Lua.
- Determinism: every random draw goes through a seeded `seedrandom` instance. No `Date.now()` for ordering decisions inside selectors; the driver owns a logical clock and passes timestamps in.
- Single Redis shard (`shardCount: 1`). Multi-shard fairness is out of scope.
- Verify with: `cd internal-packages/run-engine && pnpm run test ./src/run-queue/fairness-spike/<file> --run` (may need `pnpm run build --filter @internal/run-engine` first).
- Commit with GitButler (`but`) onto branch `chore/fair-queueing-spike`, one commit per task.

---

### Task 1: Spike scaffolding and shared types

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/types.ts`
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/queueReader.ts`
- Test: `internal-packages/run-engine/src/run-queue/fairness-spike/tests/queueReader.test.ts`

**Interfaces:**
- Consumes: `RunQueueSelectionStrategy`, `QueueDescriptor`, `EnvQueues`, `RunQueueKeyProducer` from `../types.js`; `Redis` from `@internal/redis`.
- Produces:
  - `type GroupId = string`
  - `interface SpikeSelectionStrategy extends RunQueueSelectionStrategy { readonly name: string; onServiced(descriptor: QueueDescriptor, now: number): void | Promise<void>; reset?(): void | Promise<void>; }`
  - `type ActiveQueue = { queue: string; env: EnvDescriptor; groupId: GroupId; headScore: number | undefined }`
  - `type WeightFn = (groupId: GroupId) => number` (default returns 1)
  - `class SpikeQueueReader { constructor(redis: Redis, keys: RunQueueKeyProducer); readActiveQueues(parentQueue: string): Promise<ActiveQueue[]> }`

`SpikeQueueReader.readActiveQueues` reads the master queue ZSET members (base queue keys) for the parent, and for each queue reads its head via `ZRANGE queue 0 0 WITHSCORES` to get `headScore` (the oldest enqueue timestamp). `groupId` is `keys.descriptorFromQueue(queue).queue` (the base queue name). `env` is built from the descriptor. Queues with no head (empty) are dropped.

- [ ] **Step 1: Write the failing test** — `queueReader.test.ts` using `redisTest`. Enqueue two messages with different base queue names (`"task/g1"`, `"task/g2"`), no concurrency key, into one prod env via a real `RunQueue` (reuse the construction pattern from `../index.test.ts` lines 74-93, `shardCount: 1`, `masterQueueConsumersDisabled: true`). Then construct `SpikeQueueReader` on a raw `createRedisClient` with the same `keyPrefix`, call `readActiveQueues(keys.masterQueueKeyForShard(0))`, and assert it returns two `ActiveQueue`s with `groupId` `"task/g1"` and `"task/g2"`, each with a numeric `headScore`.

```ts
const active = await reader.readActiveQueues(testOptions.keys.masterQueueKeyForShard(0));
expect(active.map((a) => a.groupId).sort()).toEqual(["g1", "g2"]);
expect(active.every((a) => typeof a.headScore === "number")).toBe(true);
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm run test ./src/run-queue/fairness-spike/tests/queueReader.test.ts --run`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `types.ts` and `queueReader.ts`.** `readActiveQueues`:

```ts
async readActiveQueues(parentQueue: string): Promise<ActiveQueue[]> {
  const queues = await this.redis.zrange(parentQueue, 0, -1);
  const out: ActiveQueue[] = [];
  for (const queue of queues) {
    const head = await this.redis.zrange(queue, 0, 0, "WITHSCORES");
    if (head.length < 2) continue;
    const d = this.keys.descriptorFromQueue(queue);
    out.push({
      queue,
      env: { orgId: d.orgId, projectId: d.projectId, envId: d.envId },
      groupId: d.queue,
      headScore: Number(head[1]),
    });
  }
  return out;
}
```

Note: because the grain is base queues (no concurrency key, per the Discovery note), the master queue holds one plain entry per base queue and no CK-wildcard expansion is needed. Skip any queue where `keys.isCkWildcard(queue)` is true (there should be none in the spike workloads); if one appears, it means a workload leaked a concurrency key.

- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit** — `but commit chore/fair-queueing-spike -m "test(run-engine): spike queue reader over master queue" --changes <ids>`

---

### Task 2: Seeded workload generator

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/harness/workload.ts`
- Test: `internal-packages/run-engine/src/run-queue/fairness-spike/tests/workload.test.ts`

**Interfaces:**
- Consumes: `seedrandom` (already a dep of `fairQueueSelectionStrategy.ts`).
- Produces:
  - `type GroupSpec = { groupId: GroupId; runCount: number; weight: number; enqueueAtMs: number[]; holdMs: () => number }`
  - `type WorkloadSpec = { seed: string; envConcurrencyLimit: number; groups: GroupSpec[] }`
  - `function buildWorkload(config: WorkloadConfig): WorkloadSpec` where `WorkloadConfig = { seed: string; envConcurrencyLimit: number; groups: Array<{ groupId: string; runCount: number; weight?: number; arrival?: "immediate" | "poisson"; ratePerSec?: number; holdMsMean?: number }> }`
  - `type EnqueueEvent = { groupId: GroupId; runId: string; enqueueAtMs: number }`
  - `function expandEvents(spec: WorkloadSpec): EnqueueEvent[]` (flattened, sorted by `enqueueAtMs`, stable by groupId)

`holdMs` samples an exponential hold from the seeded rng around `holdMsMean` (default 50). `arrival: "immediate"` sets all `enqueueAtMs` to 0; `"poisson"` spaces them by exponential inter-arrival from `ratePerSec`. `runId` is `${groupId}-${i}`.

- [ ] **Step 1: Write the failing test.** Assert determinism and shape: two `buildWorkload` calls with the same seed produce identical `expandEvents` output (deep equal); a group with `runCount: 5, arrival: "immediate"` yields 5 events all at `enqueueAtMs === 0`; total event count equals sum of `runCount`.

```ts
const a = expandEvents(buildWorkload(cfg));
const b = expandEvents(buildWorkload(cfg));
expect(a).toEqual(b);
expect(a).toHaveLength(cfg.groups.reduce((n, g) => n + g.runCount, 0));
```

- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `workload.ts`** with a single `seedrandom(config.seed)` instance threaded through all draws. Exponential sample: `-Math.log(1 - rng()) * meanMs`.
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 3: Metrics module

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/harness/metrics.ts`
- Test: `internal-packages/run-engine/src/run-queue/fairness-spike/tests/metrics.test.ts`

**Interfaces:**
- Produces:
  - `type DequeueEvent = { groupId: GroupId; runId: string; enqueueAtMs: number; dequeueAtMs: number }`
  - `type GroupMetrics = { groupId: GroupId; dequeued: number; weight: number; share: number; shareOverWeight: number; waitP50: number; waitP99: number; waitMax: number }`
  - `type RunMetrics = { perGroup: GroupMetrics[]; jainIndex: number; worstShareOverWeight: number; totalDequeued: number; redisOps: number; wallClockMs: number }`
  - `function computeMetrics(input: { events: DequeueEvent[]; weights: Record<GroupId, number>; redisOps: number; wallClockMs: number }): RunMetrics`

`share` = group dequeued / total dequeued. `shareOverWeight` = share / (weight / sumWeights). Jain index over the `shareOverWeight` vector: `(Σx)² / (n·Σx²)`. `waitP*` are percentiles of `dequeueAtMs - enqueueAtMs` per group. `worstShareOverWeight` = min across groups.

- [ ] **Step 1: Write the failing test.** Feed a hand-built event set: two groups, equal weight, group A dequeued 8, group B dequeued 2. Assert `share` A = 0.8, B = 0.2; `worstShareOverWeight` ≈ 0.4; Jain index for `[1.6, 0.4]` ≈ `(2.0)² / (2·(2.56+0.16))` = `4 / 5.44` ≈ 0.735. Assert a known percentile from a fixed wait array.
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `metrics.ts`.** Percentile via sorted nearest-rank: `sorted[Math.min(sorted.length - 1, Math.ceil(p/100 * sorted.length) - 1)]`.
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 4: Driver + baseline smoke (proves the harness on the real strategy)

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/harness/driver.ts`
- Test: `internal-packages/run-engine/src/run-queue/fairness-spike/tests/driver.smoke.test.ts`

**Interfaces:**
- Consumes: `RunQueue`, `RunQueueFullKeyProducer`, `FairQueueSelectionStrategy`, workload + metrics types, `SpikeSelectionStrategy`.
- Produces:
  - `type DriverConfig = { redis: { host: string; port: number; keyPrefix: string }; strategy: RunQueueSelectionStrategy & { onServiced?: SpikeSelectionStrategy["onServiced"] }; workload: WorkloadSpec; envConcurrencyLimit: number; maxLogicalMs: number }`
  - `async function runScenario(config: DriverConfig): Promise<RunMetrics>`

Driver loop (single env, single shard, logical clock `t` in ms advancing in fixed ticks, default 10ms):
1. Construct `RunQueue` with `queueSelectionStrategy: config.strategy`, `shardCount: 1`, `masterQueueConsumersDisabled: true`, `defaultEnvConcurrency: config.envConcurrencyLimit`.
2. Maintain `holding: Array<{ orgId; runId; releaseAtMs }>` and `events: DequeueEvent[]`.
3. On each tick `t`: (a) release any holds with `releaseAtMs <= t` via `acknowledgeMessage(orgId, runId)`; (b) enqueue all workload events with `enqueueAtMs === t` via `enqueueMessage({ env, message: { ...message, queue: groupId, runId }, workerQueue: env.id, skipDequeueProcessing: true })` (the groupId is the base queue name, no concurrency key); (c) call `queue.testDequeueFromMasterQueue(0, env.id, maxCount)`; for each returned message record a `DequeueEvent` keyed by `keys.descriptorFromQueue(msg.message.queue).queue`, call `config.strategy.onServiced?.(keys.descriptorFromQueue(msg.message.queue), t)`, and push a hold with `releaseAtMs = t + sampledHold`.
4. Stop when all runs dequeued and holds drained, or `t > maxLogicalMs`.
5. Count Redis ops by wrapping the raw client with a call counter, or approximate as dequeue+enqueue+ack counts. Return `computeMetrics(...)`.

Use one fixed org/project/env descriptor (`o-spike`/`p-spike`/`e-spike`), `maximumConcurrencyLimit: config.envConcurrencyLimit`, `concurrencyLimitBurstFactor: new Decimal(1.0)`.

- [ ] **Step 1: Write the failing test.** `redisTest` "balanced scenario is roughly fair under baseline": 4 groups, equal weight, `runCount: 50` each, `arrival: immediate`, `envConcurrencyLimit: 5`, `holdMsMean: 30`. Run with `FairQueueSelectionStrategy`. Assert `totalDequeued === 200` and `worstShareOverWeight > 0.5` (baseline should not fully starve any group in the balanced case).
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `driver.ts`.** Guard against infinite loops with the `maxLogicalMs` cap; assert all runs dequeued before computing metrics or fail loudly.
- [ ] **Step 4: Run test, verify it passes.** This is the harness proof: real RunQueue, real Redis, real concurrency gating, real numbers.
- [ ] **Step 5: Commit.**

---

### Task 5: SFQ selector (start-time virtual tags + EEVDF eligibility)

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/strategies/sfqStrategy.ts`
- Test: `internal-packages/run-engine/src/run-queue/fairness-spike/tests/sfq.test.ts`

**Interfaces:**
- Consumes: `SpikeSelectionStrategy`, `SpikeQueueReader`, `WeightFn`, `EnvQueues`, `QueueDescriptor`.
- Produces: `class SfqStrategy implements SpikeSelectionStrategy` with `constructor(opts: { redis: Redis; keys: RunQueueKeyProducer; weight?: WeightFn; quantum?: number })` and `name = "sfq"`.

State (in-process maps, keyed by groupId, plus a scalar `systemVirtualTime`): `virtualClock: Map<GroupId, number>`. Selection:
1. `active = await reader.readActiveQueues(parentQueue)`.
2. For each active queue compute `startTag = max(virtualClock.get(groupId) ?? systemVirtualTime, systemVirtualTime)`.
3. Eligibility (EEVDF-style): a queue is eligible if `startTag <= systemVirtualTime` OR it is the global minimum start tag (guarantees progress). Order eligible queues by `startTag` ascending, tiebreak by `headScore` ascending.
4. Group ordered queues by env, return `EnvQueues[]`.

`onServiced(descriptor)`: `const g = descriptor.queue; const w = weight(g); const cur = virtualClock.get(g) ?? systemVirtualTime; const next = cur + quantum / w; virtualClock.set(g, next); systemVirtualTime = Math.min(...virtualClock.values());` (system virtual time is the monotonic floor = min over active clocks; this is the CFS `min_vruntime` analogue and the anti-starvation guarantee). Throughout the selectors, `groupId = descriptor.queue`.

- [ ] **Step 1: Write the failing unit test** (no Redis, drive the maps directly): after servicing group A 10 times and group B 0 times at equal weight, A's virtualClock is far ahead, so given both active the selector orders B (smaller tag) first. Assert order.
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `sfqStrategy.ts`.**
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 6: DRR selector (deficit round robin)

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/strategies/drrStrategy.ts`
- Test: `internal-packages/run-engine/src/run-queue/fairness-spike/tests/drr.test.ts`

**Interfaces:**
- Produces: `class DrrStrategy implements SpikeSelectionStrategy`, `constructor(opts: { redis; keys; weight?: WeightFn; quantum?: number })`, `name = "drr"`.

State: `deficit: Map<GroupId, number>`, `activeOrder: GroupId[]` (round-robin cursor). Selection:
1. Read active queues; ensure every active groupId is in `activeOrder` (append new ones at the back).
2. Walk `activeOrder` from the cursor; for each group add `quantum * weight(group)` to its deficit; a group's queue is emitted (in cursor order) as long as `deficit >= 1` (unit head cost). Emit each active queue at most once per selection pass, ordered by the round-robin walk.
3. Return grouped `EnvQueues[]`.

`onServiced(descriptor)`: `deficit.set(g, (deficit.get(g) ?? 0) - 1)` and advance the round-robin cursor past `g`. Drop groups from `activeOrder` when they have no active queue (checked on next read).

- [ ] **Step 1: Write the failing unit test.** Two groups equal weight, quantum 1: over 10 selection+service cycles, dequeues alternate A,B,A,B... Assert the emitted group sequence is balanced within 1.
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `drrStrategy.ts`.**
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 7: Stride selector (integer virtual-time baseline)

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/strategies/strideStrategy.ts`
- Test: `internal-packages/run-engine/src/run-queue/fairness-spike/tests/stride.test.ts`

**Interfaces:**
- Produces: `class StrideStrategy implements SpikeSelectionStrategy`, `constructor(opts: { redis; keys; weight?: WeightFn; stride1?: number })` (`stride1` default `1_000_000`), `name = "stride"`.

State: `pass: Map<GroupId, number>`. `stride(g) = stride1 / weight(g)`. Selection: read active queues, order by `pass.get(g) ?? 0` ascending (tiebreak headScore). `onServiced(g)`: `pass.set(g, (pass.get(g) ?? 0) + stride(g))`. New groups initialise `pass` to the current global min pass (late-arrival guard, same role as the SFQ floor).

- [ ] **Step 1: Write the failing unit test.** Weights A:B = 3:1 → over many cycles A is serviced ~3x as often as B. Assert ratio within tolerance (e.g. 2.5–3.5).
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `strideStrategy.ts`.**
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 8: CoDel staleness wrapper

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/strategies/codelWrapper.ts`
- Test: `internal-packages/run-engine/src/run-queue/fairness-spike/tests/codel.test.ts`

**Interfaces:**
- Produces: `class CodelWrapper implements SpikeSelectionStrategy`, `constructor(opts: { base: SpikeSelectionStrategy; targetMs: number; intervalMs: number; now: () => number })`, `name = `codel(${base.name})``.

Wraps a base selector. Tracks per-group minimum sojourn (`now - headScore`) over a sliding `intervalMs`. When a group's min sojourn stays above `targetMs` for a full interval, it enters "escalate" mode: that group's queues are hoisted to the front of the base ordering (ahead of the base's own order) until its min sojourn drops below target. Delegates `onServiced` to the base.

- [ ] **Step 1: Write the failing unit test.** Base = a stub that always orders group A before group B. Feed B a headScore old enough that its sojourn exceeds target for longer than interval; assert the wrapper hoists B ahead of A. Then feed B a fresh headScore and assert order reverts to the base's (A before B).
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement `codelWrapper.ts`.** Track `firstAboveTargetAt: Map<GroupId, number | undefined>`; escalate when `now - firstAboveTargetAt >= intervalMs`.
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit.**

---

### Task 9: Scenario definitions + bench matrix + ranking table

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/harness/scenarios.ts`
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/fairnessSpike.bench.test.ts`
- Test: the bench file is itself the runnable matrix.

**Interfaces:**
- Consumes: `buildWorkload`, `runScenario`, all four strategies, `FairQueueSelectionStrategy`.
- Produces: `const SCENARIOS: Record<string, WorkloadConfig>` and a bench test that runs every (selector × scenario) cell and prints a ranking table.

Scenarios (all `seed: "spike-1"`):
- `balanced`: 4 groups, equal weight, runCount 50, immediate, envLimit 5, hold 30.
- `adversarialSkew`: 1 heavy group runCount 1000 + 9 light groups runCount 10, equal weight, immediate, envLimit 5, hold 30.
- `weighted`: 2 groups weights 3 and 1, runCount 300 each, immediate, envLimit 4, hold 30.
- `burst`: 6 groups, runCount 100, all enqueued at t=0 after 500ms idle, envLimit 6, hold 20.
- `longHold`: 4 groups; 2 with holdMsMean 500, 2 with holdMsMean 20; equal weight, runCount 40, envLimit 4.

Selectors: `baseline` (FairQueueSelectionStrategy), `sfq`, `drr`, `stride`, `codel(sfq)`.

- [ ] **Step 1: Write the bench** as a `describe` of `redisTest`s, one per scenario, each looping the 5 selectors, collecting `RunMetrics`, and `console.table`-ing rows `{ selector, scenario, worstShareOverWeight, jainIndex, waitP99, redisOps }`. Also write per-scenario JSON to `fairness-spike/results/<scenario>.json` for the findings writeup.
- [ ] **Step 2: Run the full matrix** — `pnpm run test ./src/run-queue/fairness-spike/fairnessSpike.bench.test.ts --run`. Capture the printed tables.
- [ ] **Step 3: Sanity-check the numbers** — baseline should show low `worstShareOverWeight` on `adversarialSkew` (that is the #2617 gap reproduced); at least one candidate should improve it. If nothing improves it, that is itself a finding, not a bug to hide.
- [ ] **Step 4: Commit** the scenarios, bench, and results JSON.

---

### Task 10: FINDINGS.md writeup

**Files:**
- Create: `internal-packages/run-engine/src/run-queue/fairness-spike/FINDINGS.md`

**Interfaces:** none (documentation).

- [ ] **Step 1:** Write `FINDINGS.md` from the `results/*.json`: a per-scenario table, then a proof/disproof verdict per mechanism (SFQ, DRR, stride, CoDel) grounded in the numbers, plus the fidelity caveats (selection-only seam, single shard, simulated holds) and a recommendation on what to take past the spike. Use the writing-voice skill.
- [ ] **Step 2: Commit.**

---

## Self-Review

**Spec coverage:** Every spec component maps to a task — SFQ (T5), DRR (T6), stride (T7), CoDel (T8), baseline (T4), workload (T2), driver (T4), metrics (T3), scenarios+bench (T9), FINDINGS (T10), the selection-only `onServiced` seam (types T1 + used T4-T8), all five scenarios (T9). Ranking-only output: T3 metrics + T9 table. Out-of-scope items (no prod Lua edits, single shard, simulated holds) are Global Constraints.

**Placeholder scan:** No TBD/TODO. The one open verification (does the master queue store CK-wildcard keys?) is called out in T1 Step 3 with the exact fallback (expand via CK index like `index.ts:1590`) rather than left vague.

**Type consistency:** `SpikeSelectionStrategy.onServiced(descriptor, now)` is defined in T1 and consumed with the same signature in T4 (driver calls `onServiced(descriptor, t)`) and implemented in T5-T8. `groupId = descriptor.queue` (the base queue name) is consistent across queueReader, all selectors, and metrics. `RunMetrics`/`DequeueEvent` defined in T3, produced by T4, consumed by T9/T10.

**Grain pivot (2026-07-23):** the plan originally used the concurrency key as the grain; the Discovery note explains why that grain lives below the strategy interface, so the grain is now the base queue name. Tasks 1, 4, 5 were updated; the scenario configs in T9 are grain-agnostic (groupId maps to a base queue name).
