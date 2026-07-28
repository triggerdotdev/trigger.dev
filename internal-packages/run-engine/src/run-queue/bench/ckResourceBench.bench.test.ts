import { createRedisClient } from "@internal/redis";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// CK virtual-time RESOURCE arm: Redis CPU + memory vs concurrency-key cardinality.
//
// Answers "how do these changes affect the run-queue Redis CPU/memory, and how do
// both react as cardinality grows (e.g. 10k concurrency keys on one base queue)".
// Drives a real RunQueue against an EXTERNAL dedicated Redis, flag OFF vs ON on
// identical load, and reads server-side metrics (INFO memory/cpu/commandstats,
// MEMORY USAGE, OBJECT ENCODING) that are unaffected by client<->server RTT.
//
// Inert unless CK_BENCH_REDIS_URL is set. FLUSHALLs the target between points, so
// point it ONLY at a dedicated throwaway store (a redis-bench lab store).
//
//   export CK_BENCH_REDIS_URL="$(lab store url ckbench1)"
//   pnpm exec vitest run src/run-queue/bench/ckResourceBench.bench.test.ts
//
// Env knobs:
//   CK_RES_MEM_CARDS=100,1000,10000,50000   memory-at-rest sweep
//   CK_RES_CPU_CARDS=100,1000,10000         cpu-under-load sweep
//   CK_RES_LOAD_OPS=8000                     load rounds per cpu point
//   CK_RES_CONCURRENCY=64                    client concurrency (beats RTT)
//   CK_RES_CHURN_CARD=10000                  churn/tombstone cardinality
//   CK_RES_CHURN_ROUNDS=60                   churn sample rounds
//   CK_BENCH_OUT=./bench-results
//
// NOTE: the RunQueue Lua commands run via EVALSHA, so redis.call() ops inside a
// script do NOT show up as separate cmdstat_* lines; they roll up under evalsha.
// The reportable CPU signals are therefore total used_cpu over an identical
// workload and aggregate evalsha usec_per_call, not a per-Redis-command split.

const REDIS_URL = process.env.CK_BENCH_REDIS_URL;
const MEM_CARDS = (process.env.CK_RES_MEM_CARDS ?? "100,1000,10000,50000")
  .split(",")
  .map((s) => +s.trim());
const CPU_CARDS = (process.env.CK_RES_CPU_CARDS ?? "100,1000,10000")
  .split(",")
  .map((s) => +s.trim());
const LOAD_OPS = +(process.env.CK_RES_LOAD_OPS ?? "8000");
const CONCURRENCY = +(process.env.CK_RES_CONCURRENCY ?? "64");
const CHURN_CARD = +(process.env.CK_RES_CHURN_CARD ?? "10000");
const CHURN_ROUNDS = +(process.env.CK_RES_CHURN_ROUNDS ?? "60");
const OUT_DIR = process.env.CK_BENCH_OUT ?? "./bench-results";

const keys = new RunQueueFullKeyProducer();

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 1_000_000,
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

const env = {
  id: "e1234",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 1_000_000,
  concurrencyLimitBurstFactor: new Decimal(1.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

function conn() {
  const u = new URL(REDIS_URL!);
  return {
    host: u.hostname,
    port: Number(u.port || "6379"),
    password: decodeURIComponent(u.password || "") || undefined,
    username: decodeURIComponent(u.username || "") || undefined,
  };
}

function createQueue(keyPrefix: string, vtimeEnabled: boolean) {
  const c = conn();
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ckVirtualTimeScheduling: { enabled: vtimeEnabled },
    queueSelectionStrategy: new FairQueueSelectionStrategy({ redis: { keyPrefix, ...c }, keys }),
    redis: { keyPrefix, ...c },
  });
}

function makeMessage(o: Partial<InputPayload> = {}): InputPayload {
  return {
    runId: "r1",
    taskIdentifier: "task/my-task",
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "PRODUCTION",
    queue: "task/my-task",
    timestamp: Date.now(),
    attempt: 0,
    ...o,
  };
}

// bounded-concurrency runner (beats the ~3.6ms workstation->box RTT)
async function pool(n: number, count: number, fn: (i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, count) }, async () => {
      while (i < count) {
        const idx = i++;
        await fn(idx);
      }
    })
  );
}

// ---- server-side metric helpers (separate no-prefix admin client) ----
function admin() {
  return createRedisClient(conn(), { onError: () => {} });
}
function infoField(info: string, key: string): number {
  const line = info.split("\n").find((l) => l.startsWith(key + ":"));
  return line ? Number(line.split(":")[1]) : NaN;
}
async function usedMemory(a: any) {
  return infoField(await a.info("memory"), "used_memory");
}
async function usedCpu(a: any) {
  const i = await a.info("cpu");
  return infoField(i, "used_cpu_user") + infoField(i, "used_cpu_sys");
}
function evalsha(info: string) {
  const line = info.split("\n").find((l) => l.startsWith("cmdstat_evalsha:"));
  if (!line) return { calls: 0, usec: 0, usecPerCall: 0 };
  const g = (k: string) => Number(line.match(new RegExp(`${k}=([0-9.]+)`))?.[1] ?? 0);
  return { calls: g("calls"), usec: g("usec"), usecPerCall: g("usec_per_call") };
}

// ---- build N distinct concurrency keys (one queued message each) ----
async function buildCardinality(queue: RunQueue, n: number) {
  const t0 = Date.now() - 500_000;
  await pool(CONCURRENCY, n, async (i) => {
    await queue.enqueueMessage({
      env,
      message: makeMessage({ runId: `r-${i}`, concurrencyKey: `k${i}`, timestamp: t0 + i }),
      workerQueue: env.id,
      skipDequeueProcessing: true,
    });
  });
}

async function findKey(a: any, prefix: string, suffix: string): Promise<string | null> {
  const found = await a.keys(`${prefix}*:${suffix}`);
  return found[0] ?? null;
}

// ---- the bench ----
describe.runIf(!!REDIS_URL)("CK virtual-time resource + cardinality benchmark", () => {
  it(
    "measures Redis memory and CPU vs cardinality, flag OFF vs ON",
    { timeout: 60 * 60_000 },
    async () => {
      const a = admin();
      const report: any = { generatedAtMs: Date.now(), memory: [], cpu: [], churn: null };

      // ---------- memory at rest ----------
      for (const n of MEM_CARDS) {
        const row: any = { cardinality: n };
        for (const on of [false, true]) {
          await a.flushall();
          await a.call("CONFIG", "RESETSTAT");
          const prefix = `ckres:mem:${n}:${on ? "on" : "off"}:`;
          const q = createQueue(prefix, on);
          try {
            await q.updateEnvConcurrencyLimits(env);
            await buildCardinality(q, n);
            const arm = on ? "on" : "off";
            row[`used_memory_${arm}`] = await usedMemory(a);
            const ckIndexKey = await findKey(a, prefix, "ckIndex");
            const ckVtimeKey = await findKey(a, prefix, "ckVtime");
            row[`ckIndex_bytes_${arm}`] = ckIndexKey
              ? await a.call("MEMORY", "USAGE", ckIndexKey)
              : null;
            row[`ckIndex_card_${arm}`] = ckIndexKey ? await a.zcard(ckIndexKey) : 0;
            if (on) {
              row.ckVtime_bytes = ckVtimeKey ? await a.call("MEMORY", "USAGE", ckVtimeKey) : null;
              row.ckVtime_card = ckVtimeKey ? await a.zcard(ckVtimeKey) : 0;
              row.ckVtime_encoding = ckVtimeKey
                ? await a.call("OBJECT", "ENCODING", ckVtimeKey)
                : null;
              // ckVtime must mirror ckIndex membership when built via the slow path
              expect(row.ckVtime_card).toBe(row.ckIndex_card_on);
            }
          } finally {
            await q.quit();
          }
        }
        row.used_memory_delta = row.used_memory_on - row.used_memory_off;
        row.ckVtime_over_ckIndex =
          row.ckIndex_bytes_on && row.ckVtime_bytes
            ? +(row.ckVtime_bytes / row.ckIndex_bytes_on).toFixed(2)
            : null;
        report.memory.push(row);
        // eslint-disable-next-line no-console
        console.log(
          `[ckres] mem N=${n}: used_memory delta=${row.used_memory_delta}B ckVtime=${row.ckVtime_bytes}B (${row.ckVtime_encoding})`
        );
      }

      // ---------- CPU under identical load ----------
      for (const n of CPU_CARDS) {
        const row: any = { cardinality: n };
        for (const on of [false, true]) {
          await a.flushall();
          const prefix = `ckres:cpu:${n}:${on ? "on" : "off"}:`;
          const q = createQueue(prefix, on);
          try {
            await q.updateEnvConcurrencyLimits(env);
            await buildCardinality(q, n);
            const shard = keys.masterQueueShardForEnvironment(env.id, 2);

            await a.call("CONFIG", "RESETSTAT");
            const cpu0 = await usedCpu(a);
            const t0wall = Date.now();

            // identical workload both arms: LOAD_OPS rounds, each round enqueues
            // 10 fresh messages (rotating keys, keeps N populated) and does one
            // batched dequeue (maxCount 10) + acks the served set.
            let served = 0;
            await pool(CONCURRENCY, LOAD_OPS, async (i) => {
              for (let j = 0; j < 10; j++) {
                await q.enqueueMessage({
                  env,
                  message: makeMessage({
                    runId: `L-${i}-${j}`,
                    concurrencyKey: `k${(i * 10 + j) % n}`,
                    timestamp: Date.now(),
                  }),
                  workerQueue: env.id,
                  skipDequeueProcessing: true,
                });
              }
              const msgs = await q.testDequeueFromMasterQueue(shard, env.id, 10);
              served += msgs.length;
              for (const m of msgs) {
                await q.acknowledgeMessage(env.organization.id, m.messageId, {
                  skipDequeueProcessing: true,
                });
              }
            });

            const cpu1 = await usedCpu(a);
            const es = evalsha(await a.info("commandstats"));
            const arm = on ? "on" : "off";
            row[`cpu_sec_${arm}`] = +(cpu1 - cpu0).toFixed(3);
            row[`evalsha_calls_${arm}`] = es.calls;
            row[`evalsha_usec_per_call_${arm}`] = +es.usecPerCall.toFixed(2);
            row[`wall_ms_${arm}`] = Date.now() - t0wall;
            row[`served_${arm}`] = served;
          } finally {
            await q.quit();
          }
        }
        row.cpu_sec_delta = +(row.cpu_sec_on - row.cpu_sec_off).toFixed(3);
        row.cpu_overhead_pct = row.cpu_sec_off
          ? Math.round(((row.cpu_sec_on - row.cpu_sec_off) / row.cpu_sec_off) * 100)
          : null;
        report.cpu.push(row);
        // eslint-disable-next-line no-console
        console.log(
          `[ckres] cpu N=${n}: cpu OFF=${row.cpu_sec_off}s ON=${row.cpu_sec_on}s (${row.cpu_overhead_pct}%) evalsha usec/call OFF=${row.evalsha_usec_per_call_off} ON=${row.evalsha_usec_per_call_on}`
        );
      }

      // ---------- churn: ckVtime membership stays bounded vs ckIndex ----------
      {
        await a.flushall();
        const prefix = `ckres:churn:on:`;
        const q = createQueue(prefix, true);
        const samples: any[] = [];
        try {
          await q.updateEnvConcurrencyLimits(env);
          await buildCardinality(q, CHURN_CARD);
          const shard = keys.masterQueueShardForEnvironment(env.id, 2);
          const ckIndexKey = (await findKey(a, prefix, "ckIndex"))!;
          const ckVtimeKey = (await findKey(a, prefix, "ckVtime"))!;
          let nextKey = CHURN_CARD;
          for (let r = 0; r < CHURN_ROUNDS; r++) {
            // hold cardinality: each iteration enqueues one FRESH key and drains
            // one message (maxCount 1), so registration and GC churn continuously
            // while total membership stays ~CHURN_CARD.
            await pool(CONCURRENCY, 200, async () => {
              await q.enqueueMessage({
                env,
                message: makeMessage({
                  runId: `C-${nextKey}`,
                  concurrencyKey: `k${nextKey++}`,
                  timestamp: Date.now(),
                }),
                workerQueue: env.id,
                skipDequeueProcessing: true,
              });
              const msgs = await q.testDequeueFromMasterQueue(shard, env.id, 1);
              for (const m of msgs) {
                await q.acknowledgeMessage(env.organization.id, m.messageId, {
                  skipDequeueProcessing: true,
                });
              }
            });
            if (r % 10 === 0 || r === CHURN_ROUNDS - 1) {
              const ckIndexCard = await a.zcard(ckIndexKey);
              const ckVtimeCard = await a.zcard(ckVtimeKey);
              samples.push({
                round: r,
                ckIndex: ckIndexCard,
                ckVtime: ckVtimeCard,
                ratio: ckIndexCard ? +(ckVtimeCard / ckIndexCard).toFixed(2) : null,
              });
            }
          }
          report.churn = { cardinality: CHURN_CARD, rounds: CHURN_ROUNDS, samples };
          // bounded: ckVtime never wildly exceeds ckIndex (allow generous 3x for transient tombstones)
          for (const s of samples) if (s.ratio !== null) expect(s.ratio).toBeLessThanOrEqual(3);
        } finally {
          await q.quit();
        }
      }

      await a.flushall();
      await a.quit().catch(() => {});

      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(`${OUT_DIR}/ck-resource-results.json`, JSON.stringify(report, null, 2));
      writeFileSync(`${OUT_DIR}/ck-resource-results.md`, renderMarkdown(report));
    }
  );
});

function renderMarkdown(r: any): string {
  const L: string[] = [];
  const kb = (b: number) => (b == null ? "n/a" : (b / 1024).toFixed(1) + "KB");
  L.push(`# CK virtual-time resource + cardinality results`, "");
  L.push(
    `Redis \`${(process.env.CK_BENCH_REDIS_URL || "").replace(/:[^:@/]*@/, ":***@")}\`. Relative OFF-vs-ON on one box; not prod scale.`,
    ""
  );
  L.push(`## Memory at rest (single base queue, one message per key)`, "");
  L.push(
    `| keys (N) | used_memory OFF | used_memory ON | delta | ckIndex bytes | ckVtime bytes | ckVtime/ckIndex | ckVtime encoding |`
  );
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const m of r.memory)
    L.push(
      `| ${m.cardinality} | ${kb(m.used_memory_off)} | ${kb(m.used_memory_on)} | ${kb(m.used_memory_delta)} | ${kb(m.ckIndex_bytes_on)} | ${kb(m.ckVtime_bytes)} | ${m.ckVtime_over_ckIndex ?? "n/a"} | ${m.ckVtime_encoding ?? "n/a"} |`
    );
  L.push(
    "",
    `## Redis CPU under identical workload (${process.env.CK_RES_LOAD_OPS ?? "8000"} rounds)`,
    ""
  );
  L.push(
    `| keys (N) | CPU-sec OFF | CPU-sec ON | delta | overhead | evalsha usec/call OFF | evalsha usec/call ON | evalsha calls OFF/ON |`
  );
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const c of r.cpu)
    L.push(
      `| ${c.cardinality} | ${c.cpu_sec_off} | ${c.cpu_sec_on} | ${c.cpu_sec_delta} | ${c.cpu_overhead_pct}% | ${c.evalsha_usec_per_call_off} | ${c.evalsha_usec_per_call_on} | ${c.evalsha_calls_off}/${c.evalsha_calls_on} |`
    );
  if (r.churn) {
    L.push("", `## Tombstone / membership under churn (N=${r.churn.cardinality}, flag ON)`, "");
    L.push(`| round | ckIndex card | ckVtime card | ratio |`, `| --- | --- | --- | --- |`);
    for (const s of r.churn.samples)
      L.push(`| ${s.round} | ${s.ckIndex} | ${s.ckVtime} | ${s.ratio} |`);
  }
  L.push("");
  return L.join("\n");
}
