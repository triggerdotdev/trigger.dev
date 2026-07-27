import { createRedisClient } from "@internal/redis";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// CK virtual-time PRIMARY arm: a queue-level A/B micro-benchmark.
//
// This drives the REAL RunQueue against an EXTERNAL Redis (not a testcontainer)
// and compares flag OFF (age-ordered CK dequeue) vs flag ON (SFQ virtual time)
// under identical load. The flag is a RunQueue constructor option, so one bench
// process runs both arms in-process: no webapp, no redeploy.
//
// It is a deliberate, defensible A/B: the two arms enqueue the exact same
// messages with the exact same timestamps and drive the exact same step loop.
// The isolation and reuse are inherited from tests/ckVtimeFairness.test.ts (the
// step loop, scenario shapes, conservation checks are the same); this file adds
// wall-clock dequeue latency, a Redis op-count, N trials, and file output.
//
// It is INERT in CI: the suite only runs when CK_BENCH_REDIS_URL is set, so
// `pnpm run test` collects it as a skipped describe and never touches a network.
//
// Run it (from the run-engine package, pointed at a dedicated throwaway Redis):
//   CK_BENCH_REDIS_URL=redis://127.0.0.1:6399 \
//   CK_BENCH_TRIALS=5 CK_BENCH_OUT=./bench-results \
//   pnpm exec vitest run src/run-queue/bench/ckMicroBench.bench.test.ts
//
// Knob sweep (optional, defaults match production defaults 1 / 3):
//   CK_BENCH_QUANTUM=1 CK_BENCH_WINDOW_MULT=3
//
// WARNING: the bench FLUSHDBs the target Redis between arms. Point it ONLY at a
// dedicated throwaway instance, never at a shared or production Redis.

const REDIS_URL = process.env.CK_BENCH_REDIS_URL;
const TRIALS = Math.max(1, Number(process.env.CK_BENCH_TRIALS ?? "5"));
const OUT_DIR = process.env.CK_BENCH_OUT ?? "./bench-results";
const QUANTUM = Math.max(1, Number(process.env.CK_BENCH_QUANTUM ?? "1"));
const WINDOW_MULT = Math.max(1, Number(process.env.CK_BENCH_WINDOW_MULT ?? "3"));
const SCENARIO_FILTER = process.env.CK_BENCH_SCENARIOS?.split(",").map((s) => s.trim());

const keys = new RunQueueFullKeyProducer();

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "error"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys,
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

function redisConn() {
  const u = new URL(REDIS_URL!);
  return { host: u.hostname, port: Number(u.port || "6379") };
}

function createQueue(keyPrefix: string, vtimeEnabled: boolean) {
  const conn = redisConn();
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ckVirtualTimeScheduling: {
      enabled: vtimeEnabled,
      quantum: QUANTUM,
      scanWindowMultiplier: WINDOW_MULT,
    },
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: { keyPrefix, host: conn.host, port: conn.port },
      keys,
    }),
    redis: { keyPrefix, host: conn.host, port: conn.port },
  });
}

function makeMessage(overrides: Partial<InputPayload> = {}): InputPayload {
  return {
    runId: "r1",
    taskIdentifier: "task/my-task",
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "DEVELOPMENT",
    queue: "task/my-task",
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  };
}

type ScenarioMessage = { runId: string; ck: string; timestamp: number };

type Scenario = {
  name: string;
  // Human label for the "victim" the fairness hypothesis is about.
  victimLabel: string;
  // Classifies a concurrency key as the victim (the light/starved tenant).
  isVictim: (ck: string) => boolean;
  messages: ScenarioMessage[];
  envConcurrencyLimit: number;
  holdSteps: number;
  maxSteps: number;
};

type ServeRecord = { step: number; ck: string; messageId: string; wallMs: number };

type ArmResult = {
  serves: ServeRecord[];
  drainStep: number;
  contentionByCk: Map<string, number>;
  contentionTotal: number;
  callLatenciesMs: number[];
  redisCalls: number;
};

// ---- scenario shapes (ported values from the fairness spike, same as the
// tests/ckVtimeFairness.test.ts scenarios; nothing imported from the spike) ----

function buildScenarios(): Scenario[] {
  const t0 = Date.now() - 500_000;
  const all: Scenario[] = [];

  // ckSkew (starvation): heavy 120-msg backlog on an old shared head, 4 light
  // keys x 10 on later heads. Serialized contention (env limit 1) is where the
  // baseline's age order starves the light keys.
  {
    const messages: ScenarioMessage[] = [];
    for (let i = 0; i < 120; i++)
      messages.push({ runId: `heavy-${i}`, ck: "heavy", timestamp: t0 });
    for (let i = 0; i < 10; i++)
      for (let k = 0; k < 4; k++)
        messages.push({
          runId: `light${k}-${i}`,
          ck: `light${k}`,
          timestamp: t0 + 10_000 + i * 4 + k,
        });
    all.push({
      name: "ckSkew",
      victimLabel: "light keys",
      isVictim: (ck) => ck.startsWith("light"),
      messages,
      envConcurrencyLimit: 1,
      holdSteps: 3,
      maxSteps: 1_000,
    });
  }

  // ckTrickle (starvation): bulk 120 + 2 trickle keys x 15.
  {
    const messages: ScenarioMessage[] = [];
    for (let i = 0; i < 120; i++) messages.push({ runId: `bulk-${i}`, ck: "bulk", timestamp: t0 });
    for (let i = 0; i < 15; i++)
      for (let k = 0; k < 2; k++)
        messages.push({
          runId: `trickle${k}-${i}`,
          ck: `trickle${k}`,
          timestamp: t0 + 10_000 + i * 2 + k,
        });
    all.push({
      name: "ckTrickle",
      victimLabel: "trickle keys",
      isVictim: (ck) => ck.startsWith("trickle"),
      messages,
      envConcurrencyLimit: 1,
      holdSteps: 3,
      maxSteps: 1_000,
    });
  }

  // ckSybil (noisy-neighbor caps cannot fix): 20 attacker keys x 8 (older
  // heads) + 1 light key x 10 (newer). 21 variants against a batch of 10.
  {
    const messages: ScenarioMessage[] = [];
    for (let i = 0; i < 8; i++)
      for (let k = 0; k < 20; k++) {
        const ck = `att${String(k).padStart(2, "0")}`;
        messages.push({ runId: `${ck}-${i}`, ck, timestamp: t0 + i * 20 + k });
      }
    for (let i = 0; i < 10; i++)
      messages.push({ runId: `light-${i}`, ck: "light", timestamp: t0 + 50_000 + i });
    all.push({
      name: "ckSybil",
      victimLabel: "light key",
      isVictim: (ck) => ck === "light",
      messages,
      envConcurrencyLimit: 25,
      holdSteps: 3,
      maxSteps: 300,
    });
  }

  // ckManyKeys (cardinality ABOVE the pass-1 window): 60 attacker keys x 8 on a
  // tied old head + 1 light key x 10. Probes the stated window limitation: the
  // light key must still drain (no permanent starvation), even though 61
  // variants exceed the 30-wide pass-1 window.
  {
    const messages: ScenarioMessage[] = [];
    for (let i = 0; i < 8; i++)
      for (let k = 0; k < 60; k++) {
        const ck = `att${String(k).padStart(2, "0")}`;
        messages.push({ runId: `${ck}-${i}`, ck, timestamp: t0 });
      }
    for (let i = 0; i < 10; i++)
      messages.push({ runId: `light-${i}`, ck: "light", timestamp: t0 + 50_000 + i });
    all.push({
      name: "ckManyKeys",
      victimLabel: "light key",
      isVictim: (ck) => ck === "light",
      messages,
      envConcurrencyLimit: 25,
      holdSteps: 3,
      maxSteps: 1_000,
    });
  }

  // ckBalanced (no-harm mixed multi-tenant): 4 symmetric keys x 25.
  {
    const cks = ["bal0", "bal1", "bal2", "bal3"];
    const messages: ScenarioMessage[] = [];
    for (let i = 0; i < 25; i++)
      for (let k = 0; k < cks.length; k++)
        messages.push({ runId: `${cks[k]}-${i}`, ck: cks[k]!, timestamp: t0 + i * 4 + k });
    all.push({
      name: "ckBalanced",
      victimLabel: "worst symmetric key",
      isVictim: (ck) => ck.startsWith("bal"),
      messages,
      envConcurrencyLimit: 4,
      holdSteps: 3,
      maxSteps: 500,
    });
  }

  // ckHeavyIdle (work conservation): a lone key with 60 msgs, nothing else
  // contending. Drain-step ON must equal OFF exactly.
  {
    const messages: ScenarioMessage[] = [];
    for (let i = 0; i < 60; i++)
      messages.push({ runId: `solo-${i}`, ck: "solo", timestamp: t0 + i });
    all.push({
      name: "ckHeavyIdle",
      victimLabel: "lone key",
      isVictim: (ck) => ck === "solo",
      messages,
      envConcurrencyLimit: 25,
      holdSteps: 3,
      maxSteps: 300,
    });
  }

  return SCENARIO_FILTER ? all.filter((s) => SCENARIO_FILTER.includes(s.name)) : all;
}

// ---- one arm of one scenario ----

async function runArm(
  scenario: Scenario,
  vtimeEnabled: boolean,
  trial: number
): Promise<ArmResult> {
  const keyPrefix = `ckbench:${scenario.name}:${vtimeEnabled ? "on" : "off"}:t${trial}:`;
  const queue = createQueue(keyPrefix, vtimeEnabled);
  const conn = redisConn();
  const admin = createRedisClient({ host: conn.host, port: conn.port }, { onError: () => {} });

  try {
    const env = {
      ...authenticatedEnvDev,
      maximumConcurrencyLimit: scenario.envConcurrencyLimit,
      concurrencyLimitBurstFactor: new Decimal(1),
    };
    await queue.updateEnvConcurrencyLimits(env);

    for (const msg of scenario.messages) {
      await queue.enqueueMessage({
        env,
        message: makeMessage({
          runId: msg.runId,
          concurrencyKey: msg.ck,
          timestamp: msg.timestamp,
        }),
        workerQueue: env.id,
        skipDequeueProcessing: true,
      });
    }

    // Count only steady-state (dequeue + ack) Redis ops, not enqueue.
    await admin.call("CONFIG", "RESETSTAT");

    const shard = keys.masterQueueShardForEnvironment(env.id, 2);
    const total = scenario.messages.length;
    const remaining = new Map<string, number>();
    for (const m of scenario.messages) remaining.set(m.ck, (remaining.get(m.ck) ?? 0) + 1);

    const serves: ServeRecord[] = [];
    const inFlight: { messageId: string; servedAtStep: number }[] = [];
    const contentionByCk = new Map<string, number>();
    let contentionTotal = 0;
    let drainStep = -1;
    const callLatenciesMs: number[] = [];
    const armStart = performance.now();

    for (let step = 0; step < scenario.maxSteps && serves.length < total; step++) {
      let keysWithBacklog = 0;
      for (const count of remaining.values()) if (count > 0) keysWithBacklog++;

      const before = performance.now();
      const messages = await queue.testDequeueFromMasterQueue(shard, env.id, 10);
      callLatenciesMs.push(performance.now() - before);

      for (const m of messages) {
        const ck = m.message.concurrencyKey ?? "";
        serves.push({ step, ck, messageId: m.messageId, wallMs: performance.now() - armStart });
        remaining.set(ck, (remaining.get(ck) ?? 0) - 1);
        inFlight.push({ messageId: m.messageId, servedAtStep: step });
        if (keysWithBacklog >= 2) {
          contentionTotal++;
          contentionByCk.set(ck, (contentionByCk.get(ck) ?? 0) + 1);
        }
        if (serves.length === total) drainStep = step;
      }

      for (let i = inFlight.length - 1; i >= 0; i--) {
        const entry = inFlight[i]!;
        if (entry.servedAtStep + scenario.holdSteps <= step) {
          await queue.acknowledgeMessage(env.organization.id, entry.messageId, {
            skipDequeueProcessing: true,
          });
          inFlight.splice(i, 1);
        }
      }
    }

    const stats = await admin.call("INFO", "commandstats");
    const redisCalls = sumRedisCalls(String(stats));

    return { serves, drainStep, contentionByCk, contentionTotal, callLatenciesMs, redisCalls };
  } finally {
    await admin.quit().catch(() => {});
    await queue.quit();
    // Clean slate for the next arm: this is a dedicated throwaway Redis.
    const admin2 = createRedisClient(redisConn(), { onError: () => {} });
    await admin2.flushdb().catch(() => {});
    await admin2.quit().catch(() => {});
  }
}

// ---- metrics ----

function sumRedisCalls(info: string): number {
  // lines look like: cmdstat_zadd:calls=123,usec=...,...
  let total = 0;
  for (const line of info.split("\n")) {
    const m = line.match(/cmdstat_[^:]+:calls=(\d+)/);
    if (m) total += Number(m[1]);
  }
  return total;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  return { mean, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99) };
}

// Jain's fairness index over per-key served counts during contention windows.
// 1.0 = perfectly fair; 1/n = one key took everything.
function jain(counts: number[]): number {
  const nonzero = counts.filter((c) => c > 0);
  if (nonzero.length === 0) return NaN;
  const sum = nonzero.reduce((a, b) => a + b, 0);
  const sumSq = nonzero.reduce((a, b) => a + b * b, 0);
  return (sum * sum) / (nonzero.length * sumSq);
}

function victimWaits(arm: ArmResult, s: Scenario): number[] {
  return arm.serves.filter((r) => s.isVictim(r.ck)).map((r) => r.step);
}

function firstServe(arm: ArmResult, s: Scenario): number {
  const first = arm.serves.find((r) => s.isVictim(r.ck));
  return first ? first.step : -1;
}

// ---- the bench ----

describe.runIf(!!REDIS_URL)("CK virtual-time micro-benchmark (A/B, external Redis)", () => {
  it("runs OFF vs ON across scenarios and writes results", { timeout: 30 * 60_000 }, async () => {
    const scenarios = buildScenarios();
    const report: any = {
      generatedAtMs: Date.now(),
      redisUrl: REDIS_URL,
      trials: TRIALS,
      knobs: { quantum: QUANTUM, scanWindowMultiplier: WINDOW_MULT },
      scenarios: [] as any[],
    };

    for (const s of scenarios) {
      // Wall-clock latency and op-count are pooled/aggregated across trials.
      // Step-based metrics are deterministic, so trial 0 is authoritative and
      // later trials only assert determinism.
      const offCalls: number[] = [];
      const onCalls: number[] = [];
      const offOps: number[] = [];
      const onOps: number[] = [];
      let off0: ArmResult | null = null;
      let on0: ArmResult | null = null;

      for (let t = 0; t < TRIALS; t++) {
        const off = await runArm(s, false, t);
        const on = await runArm(s, true, t);

        // Correctness gate: identical load must serve every message exactly
        // once in BOTH arms, else the comparison is meaningless.
        expect(off.serves.length, `${s.name} OFF served != enqueued`).toBe(s.messages.length);
        expect(on.serves.length, `${s.name} ON served != enqueued`).toBe(s.messages.length);
        expect(new Set(off.serves.map((r) => r.messageId)).size).toBe(s.messages.length);
        expect(new Set(on.serves.map((r) => r.messageId)).size).toBe(s.messages.length);

        offCalls.push(...off.callLatenciesMs);
        onCalls.push(...on.callLatenciesMs);
        offOps.push(off.redisCalls);
        onOps.push(on.redisCalls);

        if (t === 0) {
          off0 = off;
          on0 = on;
        } else {
          // determinism of the logical schedule across trials
          expect(firstServe(off, s), `${s.name} OFF first-serve not deterministic`).toBe(
            firstServe(off0!, s)
          );
          expect(firstServe(on, s), `${s.name} ON first-serve not deterministic`).toBe(
            firstServe(on0!, s)
          );
          expect(on.drainStep).toBe(on0!.drainStep);
        }
      }

      const offWait = stats(victimWaits(off0!, s));
      const onWait = stats(victimWaits(on0!, s));
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

      const scenarioReport = {
        name: s.name,
        victim: s.victimLabel,
        config: {
          envConcurrencyLimit: s.envConcurrencyLimit,
          holdSteps: s.holdSteps,
          variants: new Set(s.messages.map((m) => m.ck)).size,
          messages: s.messages.length,
        },
        off: {
          victimWait: offWait,
          victimFirstServe: firstServe(off0!, s),
          drainStep: off0!.drainStep,
          jain: jain([...off0!.contentionByCk.values()]),
          callLatencyMs: stats(offCalls),
          redisOpsMedian: median(offOps),
        },
        on: {
          victimWait: onWait,
          victimFirstServe: firstServe(on0!, s),
          drainStep: on0!.drainStep,
          jain: jain([...on0!.contentionByCk.values()]),
          callLatencyMs: stats(onCalls),
          redisOpsMedian: median(onOps),
        },
      };
      report.scenarios.push(scenarioReport);
      // eslint-disable-next-line no-console
      console.log(
        `[ckbench] ${s.name}: victim p95 wait OFF=${offWait.p95} ON=${onWait.p95} | drain OFF=${off0!.drainStep} ON=${on0!.drainStep}`
      );
    }

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/ck-micro-results.json`, JSON.stringify(report, null, 2));
    writeFileSync(`${OUT_DIR}/ck-micro-results.md`, renderMarkdown(report));
  });
});

function fmt(n: number): string {
  if (Number.isNaN(n)) return "n/a";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function delta(off: number, on: number): string {
  if (Number.isNaN(off) || Number.isNaN(on)) return "n/a";
  if (off === 0) return on === 0 ? "0" : "+inf";
  const pctChange = ((on - off) / off) * 100;
  return `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(0)}%`;
}

function renderMarkdown(report: any): string {
  const lines: string[] = [];
  lines.push(`# CK virtual-time micro-benchmark results`);
  lines.push("");
  lines.push(
    `Redis \`${report.redisUrl}\`, ${report.trials} trial(s), quantum ${report.knobs.quantum}, window multiplier ${report.knobs.scanWindowMultiplier}.`
  );
  lines.push("");
  lines.push(
    `Numbers are RELATIVE (same box, same load, flag OFF vs ON). Wait is in logical dequeue steps. Latency is wall-clock per dequeue call on this box and is NOT prod-scale absolute throughput.`
  );
  lines.push("");
  lines.push(`| scenario | metric | baseline (OFF) | vtime (ON) | delta |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const s of report.scenarios) {
    const rows: [string, number, number][] = [
      [`victim wait p50 (${s.victim})`, s.off.victimWait.p50, s.on.victimWait.p50],
      [`victim wait p95`, s.off.victimWait.p95, s.on.victimWait.p95],
      [`victim wait p99`, s.off.victimWait.p99, s.on.victimWait.p99],
      [`victim first-serve step (starvation bound)`, s.off.victimFirstServe, s.on.victimFirstServe],
      [`drain step (work conservation)`, s.off.drainStep, s.on.drainStep],
      [`Jain fairness index (contention)`, s.off.jain, s.on.jain],
      [`dequeue call p95 (ms)`, s.off.callLatencyMs.p95, s.on.callLatencyMs.p95],
      [`redis ops (dequeue+ack)`, s.off.redisOpsMedian, s.on.redisOpsMedian],
    ];
    rows.forEach(([metric, off, on], i) => {
      lines.push(
        `| ${i === 0 ? `**${s.name}**` : ""} | ${metric} | ${fmt(off)} | ${fmt(on)} | ${delta(off, on)} |`
      );
    });
  }
  lines.push("");
  return lines.join("\n");
}
