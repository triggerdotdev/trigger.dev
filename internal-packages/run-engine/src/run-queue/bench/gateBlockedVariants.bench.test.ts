/**
 * Dequeue benchmark for a keyed gate at its cap blocking many concurrency-key variants.
 *
 * One task queue. Every run is keyed by a session (its concurrencyKey) and also holds a
 * gate keyed by its tenant (`gates: [{ queue: "limit/tenant", concurrencyKey: tenant }]`).
 * Tenant A always sits at the gate's per-key cap (so the zero row is a like-for-like
 * baseline) with BLOCKED queued sessions that cannot start.
 * Ten other tenants have room: 50 light sessions of 4 runs each. A further tenant has one
 * heavy session of 60 older runs. Served runs are acknowledged straight away, so those
 * tenants always have capacity and any slowdown is the scan's doing.
 *
 * Worst-case ordering on purpose: the blocked sessions are the oldest and the first to
 * register, so they lead the dequeue's age-ordered scan.
 * The heavy session registers last but holds the oldest runs outside tenant A.
 *
 * Reports, per blocked-session count:
 * calls and seconds to drain the light sessions and everything, calls that served nothing
 * and the longest such streak, the heavy session's share of the first 20 calls' serves
 * (age order gives it one per call), client wall
 * time, and Redis-side script time and command count from `INFO commandstats`.
 *
 * A second benchmark keeps the light sessions enqueuing fresh runs at a steady rate for the
 * whole measurement, so work that arrives after a blocked variant's one-second back-off has
 * expired sorts behind it. It reports the wait from enqueue to serve, split into the first
 * five seconds and the rest so a one-off sweep can be told from a recurring stall, the
 * runs served per dequeue script call, and the seconds in which no run was
 * served. It runs twice: polled at a fixed interval, and "live", where the queue's own
 * master-queue consumers and debounced dequeue job drive the script at production
 * settings (LIVE below) and a consumer pops the worker queue. BENCH_ARRIVAL_PACING=live
 * runs only that half.
 *
 * Run on demand with `pnpm run test:bench` (kept out of the default suite). Results print
 * as tables and land as JSON in `.bench/run-queue-gate-blocked-variants.json` and
 * `.bench/run-queue-gate-blocked-arrivals.json`.
 *
 * Knobs, all optional: BENCH_BLOCKED (comma list, default "0,10,60,200,1000"),
 * BENCH_CALL_INTERVAL_MS (comma list of pauses between calls, default "50,250": a blocked
 * variant is backed off for one second, so the pause decides how often it returns to the
 * scan), BENCH_MAX_SECONDS (per scenario, default 60), BENCH_ARRIVAL_BLOCKED (comma list,
 * default "0,60,200,1000"), BENCH_ARRIVAL_RATE (runs per second, default 20),
 * BENCH_ARRIVAL_SECONDS (default 20), BENCH_ARRIVAL_POLL_MS (fixed-interval run, default
 * 250), BENCH_WAKE_BLOCKED (comma list, default "60,200,1000"), BENCH_WAKE_SECONDS (default
 * 60), BENCH_WAKE_RUN_MS (duration of a capped-tenant run, default 500), BENCH_OUT_DIR,
 * BENCH_POOLS (gate pools with one parked sub-queue each in the many-pools run, default 500),
 * BENCH_STEADY_PARKED (sub-queues parked in the steady-state run, default 10000),
 * BENCH_POOLS_HOLDERS (same|other: which queue the pool holders run on, default other),
 * BENCH_POOLS_RELEASES (holders released in the many-pools run, default all),
 * BENCH_GATE_SKIP_AHEAD=1 (read past gate-blocked sub-queues; off by default).
 */
import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

vi.setConfig({ testTimeout: 900_000 });

const BLOCKED = (process.env.BENCH_BLOCKED ?? "0,10,60,200,1000").split(",").map(Number);
const INTERVALS = (process.env.BENCH_CALL_INTERVAL_MS ?? "50,250").split(",").map(Number);
const MAX_SECONDS = Number(process.env.BENCH_MAX_SECONDS ?? 60);
const ARRIVAL_BLOCKED = (process.env.BENCH_ARRIVAL_BLOCKED ?? "0,60,200,1000")
  .split(",")
  .map(Number);
const ARRIVAL_RATE = Number(process.env.BENCH_ARRIVAL_RATE ?? 20);
const ARRIVAL_SECONDS = Number(process.env.BENCH_ARRIVAL_SECONDS ?? 20);
const ARRIVAL_POLL_MS = Number(process.env.BENCH_ARRIVAL_POLL_MS ?? 250);
const WAKE_BLOCKED = (process.env.BENCH_WAKE_BLOCKED ?? "60,200,1000").split(",").map(Number);
const WAKE_SECONDS = Number(process.env.BENCH_WAKE_SECONDS ?? 60);
const WAKE_RUN_MS = Number(process.env.BENCH_WAKE_RUN_MS ?? 500);
const SKIP_AHEAD = process.env.BENCH_GATE_SKIP_AHEAD === "1";
const POOLS_HOLDERS_SAME = process.env.BENCH_POOLS_HOLDERS === "same";
const POOLS = Number(process.env.BENCH_POOLS ?? 500);
const STEADY_PARKED = Number(process.env.BENCH_STEADY_PARKED ?? 10_000);
const OUT_DIR = process.env.BENCH_OUT_DIR ?? join(process.cwd(), "..", "..", ".bench");

const SHARD_COUNT = 12;
const MAX_COUNT = 10;
const QUEUE = "task/bench-task";
const OTHER_QUEUE = "task/bench-other-task";
const GATE = "limit/tenant";
const GATE_PER_KEY = 5;
const KEY_PREFIX = "runqueue:bench:";
const TENANTS = 10;
const LIGHT_SESSIONS_PER_TENANT = 5;
const LIGHT_RUNS_PER_SESSION = 4;
const HEAVY_RUNS = 60;
const HEAVY_SESSION = "tH-heavy";
const FAIRNESS_CALLS = 20;

/** Settings for the live run, taken from a production engine worker's configuration. */
const LIVE = {
  masterQueueConsumersIntervalMs: 5_000,
  masterQueueCooloffPeriodMs: 10_000,
  masterQueueCooloffCountThreshold: 10,
  processWorkerQueueDebounceMs: 200,
  workerPollIntervalMs: 1_000,
  workerImmediatePollIntervalMs: 20,
  workerConcurrency: { workers: 4, tasksPerWorker: 20, limit: 50 },
  selection: {
    parentQueueLimit: 2_400,
    biases: {
      concurrencyLimitBias: 0.75,
      availableCapacityBias: 0.3,
      queueAgeRandomization: 0.25,
    },
  },
};

const keys = new RunQueueFullKeyProducer();

const env = {
  id: "e-bench",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 100_000,
  concurrencyLimitBurstFactor: new Decimal(1.0),
  project: { id: "p-bench" },
  organization: { id: "o-bench" },
};

/**
 * `live` runs the queue's own dequeue machinery (nothing emulated) at LIVE settings: a
 * master-queue consumer per shard, and the dequeue job that every enqueue and
 * acknowledgement schedules, debounced and picked up by the queue's own worker.
 */
function createQueue(redisContainer: any, live = false, meter?: any) {
  const redis = {
    keyPrefix: KEY_PREFIX,
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    name: "rq",
    tracer: trace.getTracer("rq"),
    workers: 1,
    defaultEnvConcurrency: 100_000,
    logger: new Logger("RunQueue", "error"),
    retryOptions: {
      maxAttempts: 5,
      factor: 1.1,
      minTimeoutInMs: 100,
      maxTimeoutInMs: 1_000,
      randomize: true,
    },
    keys,
    shardCount: SHARD_COUNT,
    masterQueueConsumersDisabled: !live,
    masterQueueConsumersIntervalMs: LIVE.masterQueueConsumersIntervalMs,
    masterQueueConsumerDequeueCount: MAX_COUNT,
    masterQueueCooloffPeriodMs: LIVE.masterQueueCooloffPeriodMs,
    masterQueueCooloffCountThreshold: LIVE.masterQueueCooloffCountThreshold,
    processWorkerQueueDebounceMs: LIVE.processWorkerQueueDebounceMs,
    concurrencyKeyLimitsEnabled: true,
    workerOptions: live
      ? {
          pollIntervalMs: LIVE.workerPollIntervalMs,
          immediatePollIntervalMs: LIVE.workerImmediatePollIntervalMs,
          concurrency: LIVE.workerConcurrency,
        }
      : { disabled: true },
    totalConcurrencyEnabled: true,
    gatesEnabled: true,
    gateSkipAhead: { enabled: SKIP_AHEAD },
    meter,
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis,
      keys,
      ...(live ? LIVE.selection : {}),
    }),
    redis,
  } as any) as any;
}

async function enqueue(
  queue: any,
  runId: string,
  session: string,
  tenant: string,
  at: number,
  skipDequeueProcessing = true,
  queueName = QUEUE
) {
  const message: InputPayload = {
    runId,
    taskIdentifier: queueName,
    orgId: env.organization.id,
    projectId: env.project.id,
    environmentId: env.id,
    environmentType: env.type,
    queue: queueName,
    concurrencyKey: session,
    timestamp: at,
    attempt: 0,
    gates: [{ queue: GATE, concurrencyKey: tenant }],
  };
  await queue.enqueueMessage({ env, message, workerQueue: "main", skipDequeueProcessing });
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Script time and total commands Redis ran since the last RESETSTAT, excluding this probe. */
async function redisSide(queue: any) {
  const info: string = await queue.redis.info("commandstats");
  let scriptUsec = 0;
  let commands = 0;
  for (const line of info.split("\n")) {
    const match = /^cmdstat_([^:]+):calls=(\d+),usec=(\d+)/.exec(line);
    if (!match) continue;
    const [, name, calls, usec] = match;
    if (name === "config|resetstat" || name === "config" || name === "info") continue;
    if (name === "evalsha" || name === "eval") {
      scriptUsec += Number(usec);
    }
    commands += Number(calls);
  }
  return { scriptUsec, commands };
}

async function runScenario(redisContainer: any, blocked: number, interval: number) {
  const queue = createQueue(redisContainer);
  try {
    await queue.redis.flushdb();
    await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
    await queue.updateQueueConcurrencyLimits(env, GATE, GATE_PER_KEY);
    const shard = keys.masterQueueShardForEnvironment(env.id, SHARD_COUNT);
    const t0 = Date.now() - 600_000;

    for (let i = 0; i < GATE_PER_KEY; i++) {
      await enqueue(queue, `a-hold-${i}`, `tA-hold-${i}`, "tA", t0 - 1000 + i);
    }
    const holders = await queue.testDequeueFromMasterQueue(shard, env.id, MAX_COUNT);
    if (holders.length !== GATE_PER_KEY) {
      throw new Error(`expected ${GATE_PER_KEY} holders at the gate cap, got ${holders.length}`);
    }
    for (let i = 0; i < blocked; i++) {
      await enqueue(queue, `a-blocked-${i}`, `tA-s${i}`, "tA", t0 + i);
    }

    let pending = 0;
    let lightPending = 0;
    for (let t = 1; t <= TENANTS; t++) {
      for (let s = 0; s < LIGHT_SESSIONS_PER_TENANT; s++) {
        for (let r = 0; r < LIGHT_RUNS_PER_SESSION; r++) {
          const at = t0 + 10_000 + t * 100 + s * 10 + r;
          await enqueue(queue, `t${t}-s${s}-r${r}`, `t${t}-s${s}`, `t${t}`, at);
          pending++;
          lightPending++;
        }
      }
    }
    for (let i = 0; i < HEAVY_RUNS; i++) {
      await enqueue(queue, `heavy-${i}`, HEAVY_SESSION, "tH", t0 + 5_000 + i);
      pending++;
    }

    const wallMs: number[] = [];
    const scriptUsec: number[] = [];
    const commands: number[] = [];
    let calls = 0;
    let zeroCalls = 0;
    let zeroStreak = 0;
    let longestZeroStreak = 0;
    let lightDrainedAt = 0;
    let lightDrainedSec = 0;
    const loopStartedAt = performance.now();
    const elapsedSec = () => round((performance.now() - loopStartedAt) / 1000);
    let heavyEarly = 0;
    let servedEarly = 0;

    while (pending > 0 && elapsedSec() < MAX_SECONDS) {
      await sleep(interval);
      await queue.redis.call("CONFIG", "RESETSTAT");
      const startedAt = performance.now();
      const served = await queue.testDequeueFromMasterQueue(shard, env.id, MAX_COUNT);
      wallMs.push(performance.now() - startedAt);
      const side = await redisSide(queue);
      scriptUsec.push(side.scriptUsec);
      commands.push(side.commands);
      calls++;

      if (served.length === 0) {
        zeroCalls++;
        zeroStreak++;
        longestZeroStreak = Math.max(longestZeroStreak, zeroStreak);
      } else {
        zeroStreak = 0;
      }

      for (const item of served) {
        if (item.messageId.startsWith("a-")) {
          throw new Error(`benchmark invariant broken: ${item.messageId} passed a full gate`);
        }
        const heavy = item.message.concurrencyKey === HEAVY_SESSION;
        if (calls <= FAIRNESS_CALLS) {
          servedEarly++;
          if (heavy) heavyEarly++;
        }
        if (!heavy) lightPending--;
        pending--;
        await queue.acknowledgeMessage(env.organization.id, item.messageId, {
          skipDequeueProcessing: true,
        });
      }
      if (lightPending === 0 && lightDrainedAt === 0) {
        lightDrainedAt = calls;
        lightDrainedSec = elapsedSec();
      }
    }

    return {
      skipAhead: SKIP_AHEAD,
      intervalMs: interval,
      blocked,
      lightDrainedAt: lightDrainedAt || `>${calls}`,
      lightDrainedSec: lightDrainedSec || `>${elapsedSec()}`,
      allDrainedAt: pending === 0 ? calls : `>${calls}`,
      allDrainedSec: pending === 0 ? elapsedSec() : `>${elapsedSec()}`,
      zeroCalls,
      longestZeroStreak,
      heavySharePct: round((heavyEarly / (servedEarly || 1)) * 100),
      wallP50Ms: round(percentile(wallMs, 0.5)),
      wallP95Ms: round(percentile(wallMs, 0.95)),
      wallMaxMs: round(Math.max(...wallMs)),
      scriptP50Us: percentile(scriptUsec, 0.5),
      scriptMaxUs: Math.max(...scriptUsec),
      cmdsP50: percentile(commands, 0.5),
      cmdsMax: Math.max(...commands),
    };
  } finally {
    await queue.quit();
  }
}

/** Tenant A at its gate cap with `blocked` old queued sessions, seeded with nothing polling. */
async function seedBlockedTenant(redisContainer: any, blocked: number) {
  const queue = createQueue(redisContainer);
  try {
    await queue.redis.flushdb();
    await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
    await queue.updateQueueConcurrencyLimits(env, GATE, GATE_PER_KEY);
    const shard = keys.masterQueueShardForEnvironment(env.id, SHARD_COUNT);
    const t0 = Date.now() - 600_000;
    for (let i = 0; i < GATE_PER_KEY; i++) {
      await enqueue(queue, `a-hold-${i}`, `tA-hold-${i}`, "tA", t0 - 1000 + i);
    }
    const holders = await queue.testDequeueFromMasterQueue(shard, env.id, MAX_COUNT);
    if (holders.length !== GATE_PER_KEY) {
      throw new Error(`expected ${GATE_PER_KEY} holders at the gate cap, got ${holders.length}`);
    }
    for (let i = 0; i < blocked; i++) {
      await enqueue(queue, `a-blocked-${i}`, `tA-s${i}`, "tA", t0 + i);
    }
  } finally {
    await queue.quit();
  }
}

async function runArrivalScenario(redisContainer: any, blocked: number, live: boolean) {
  await seedBlockedTenant(redisContainer, blocked);
  const dequeues = dequeueCallCounter();
  const queue = createQueue(redisContainer, live, dequeues.meter);
  try {
    const shard = keys.masterQueueShardForEnvironment(env.id, SHARD_COUNT);

    const enqueuedAt = new Map<string, number>();
    const waits: Array<{ at: number; wait: number }> = [];
    const startedAt = Date.now();
    const endsAt = startedAt + ARRIVAL_SECONDS * 1000;

    const serve = async (messageId: string) => {
      if (messageId.startsWith("a-")) {
        throw new Error(`benchmark invariant broken: ${messageId} passed a full gate`);
      }
      const at = Date.now();
      waits.push({ at: at - startedAt, wait: at - enqueuedAt.get(messageId)! });
      enqueuedAt.delete(messageId);
      await queue.acknowledgeMessage(env.organization.id, messageId, {
        skipDequeueProcessing: !live,
      });
    };

    const arrivals = (async () => {
      let sent = 0;
      while (Date.now() < endsAt) {
        const due = Math.floor(((Date.now() - startedAt) / 1000) * ARRIVAL_RATE);
        while (sent < due) {
          const tenant = (sent % TENANTS) + 1;
          const session = Math.floor(sent / TENANTS) % LIGHT_SESSIONS_PER_TENANT;
          const runId = `l-${sent}`;
          enqueuedAt.set(runId, Date.now());
          await enqueue(queue, runId, `t${tenant}-s${session}`, `t${tenant}`, Date.now(), !live);
          sent++;
        }
        await sleep(5);
      }
      return sent;
    })();

    const consumer = (async () => {
      let nextPollAt = startedAt;
      while (Date.now() < endsAt) {
        if (live) {
          const popped = await queue.dequeueMessageFromWorkerQueue("bench", "main", {
            blockingPop: true,
            blockingPopTimeoutSeconds: 1,
          });
          if (popped) await serve(popped.messageId);
        } else if (Date.now() >= nextPollAt) {
          nextPollAt += ARRIVAL_POLL_MS;
          for (const item of await queue.testDequeueFromMasterQueue(shard, env.id, MAX_COUNT)) {
            await serve(item.messageId);
          }
        } else {
          await sleep(5);
        }
      }
    })();

    const [sent] = await Promise.all([arrivals, consumer]);

    const servedSeconds = new Set(
      waits.filter((w) => w.at < ARRIVAL_SECONDS * 1000).map((w) => Math.floor(w.at / 1000))
    );
    const early = waits.filter((w) => w.at < 5_000).map((w) => w.wait);
    const late = waits.filter((w) => w.at >= 5_000).map((w) => w.wait);
    const all = waits.map((w) => w.wait);
    const scriptCalls = await dequeues.calls();
    return {
      skipAhead: SKIP_AHEAD,
      pacing: live ? "live" : `every ${ARRIVAL_POLL_MS}ms`,
      blocked,
      sent,
      served: waits.length,
      unservedAtEnd: sent - waits.length,
      waitP50Ms: percentile(all, 0.5),
      waitP95Ms: percentile(all, 0.95),
      waitMaxMs: all.length ? Math.max(...all) : 0,
      first5sP95Ms: percentile(early, 0.95),
      after5sP95Ms: percentile(late, 0.95),
      after5sMaxMs: late.length ? Math.max(...late) : 0,
      scriptCalls,
      scriptCallsPerSec: round(scriptCalls / ARRIVAL_SECONDS),
      servedPerCall: round(waits.length / (scriptCalls || 1)),
      secondsWithNoServe: ARRIVAL_SECONDS - servedSeconds.size,
    };
  } finally {
    await queue.quit();
  }
}

/**
 * Counts concurrency-key dequeue script calls from the run queue's own
 * `runqueue.dequeue.script.duration` histogram, read through a real meter: pass `meter` to
 * createQueue. `calls()` is the count since the queue was created or `reset()` last ran.
 */
function dequeueCallCounter() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({ readers: [reader] });
  let baseline = 0;
  const total = async () => {
    exporter.reset();
    await reader.forceFlush();
    const histogram = exporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "runqueue.dequeue.script.duration");
    let calls = 0;
    for (const point of histogram?.dataPoints ?? []) {
      if (point.attributes.script === "ck") calls += (point.value as { count: number }).count;
    }
    return calls;
  };
  return {
    meter: provider.getMeter("run-queue-bench"),
    calls: async () => (await total()) - baseline,
    reset: async () => {
      baseline = await total();
    },
  };
}

/**
 * The capped tenant's runs complete: each takes WAKE_RUN_MS, so its gate frees a slot
 * GATE_PER_KEY times per run duration. It has `blocked` sessions queued behind the cap and
 * new runs arriving for them at its maximum throughput, while light tenants arrive at
 * ARRIVAL_RATE and are acknowledged at once. Everything runs on the queue's own machinery
 * at LIVE settings.
 */
async function runWakeScenario(redisContainer: any, blocked: number) {
  const dequeues = dequeueCallCounter();
  const queue = createQueue(redisContainer, true, dequeues.meter);
  try {
    await queue.redis.flushdb();
    await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
    await queue.updateQueueConcurrencyLimits(env, GATE, GATE_PER_KEY);
    await dequeues.reset();
    const cappedMaxPerSec = GATE_PER_KEY / (WAKE_RUN_MS / 1000);

    const t0 = Date.now() - 600_000;
    for (let i = 0; i < blocked; i++) {
      for (let r = 0; r < 2; r++) {
        await enqueue(queue, `a-${i}-seed${r}`, `tA-s${i}`, "tA", t0 + i * 10 + r);
      }
    }

    await queue.redis.call("CONFIG", "RESETSTAT");
    const startedAt = Date.now();
    const endsAt = startedAt + WAKE_SECONDS * 1000;
    const enqueuedAt = new Map<string, number>();
    const lightWaits: number[] = [];
    const freedAt: number[] = [];
    const slotIdle: number[] = [];
    const servedPerSession = new Map<number, number>();
    const firstServeOrder: number[] = [];
    const firstServeWait: number[] = [];
    const pendingAcks: Promise<unknown>[] = [];
    let cappedServed = 0;
    let acks = 0;
    let running = 0;
    let maxRunning = 0;

    const ack = async (messageId: string) => {
      acks++;
      await queue.acknowledgeMessage(env.organization.id, messageId);
    };

    const serve = async (messageId: string) => {
      const now = Date.now();
      if (!messageId.startsWith("a-")) {
        lightWaits.push(now - enqueuedAt.get(messageId)!);
        enqueuedAt.delete(messageId);
        await ack(messageId);
        return;
      }
      cappedServed++;
      running++;
      maxRunning = Math.max(maxRunning, running);
      const freed = freedAt.shift();
      if (freed !== undefined) slotIdle.push(now - freed);
      const session = Number(messageId.split("-")[1]);
      if (!servedPerSession.has(session)) {
        firstServeOrder.push(session);
        firstServeWait.push(now - startedAt);
      }
      servedPerSession.set(session, (servedPerSession.get(session) ?? 0) + 1);
      pendingAcks.push(
        sleep(WAKE_RUN_MS).then(async () => {
          await ack(messageId);
          running--;
          freedAt.push(Date.now());
        })
      );
    };

    const arrivals = (async () => {
      let light = 0;
      let capped = 0;
      while (Date.now() < endsAt) {
        const elapsed = (Date.now() - startedAt) / 1000;
        while (light < Math.floor(elapsed * ARRIVAL_RATE)) {
          const tenant = (light % TENANTS) + 1;
          const session = Math.floor(light / TENANTS) % LIGHT_SESSIONS_PER_TENANT;
          const runId = `l-${light}`;
          enqueuedAt.set(runId, Date.now());
          await enqueue(queue, runId, `t${tenant}-s${session}`, `t${tenant}`, Date.now(), false);
          light++;
        }
        while (capped < Math.floor(elapsed * cappedMaxPerSec)) {
          const session = capped % blocked;
          await enqueue(
            queue,
            `a-${session}-x${capped}`,
            `tA-s${session}`,
            "tA",
            Date.now(),
            false
          );
          capped++;
        }
        await sleep(5);
      }
      return light;
    })();

    const consumer = (async () => {
      while (Date.now() < endsAt) {
        const popped = await queue.dequeueMessageFromWorkerQueue("bench", "main", {
          blockingPop: true,
          blockingPopTimeoutSeconds: 1,
        });
        if (popped) await serve(popped.messageId);
      }
    })();

    const [lightSent] = await Promise.all([arrivals, consumer]);
    const side = await redisSide(queue);
    await Promise.all(pendingAcks);

    let newestSeen = -1;
    let outOfOrder = 0;
    for (const session of firstServeOrder) {
      if (session < newestSeen) outOfOrder++;
      newestSeen = Math.max(newestSeen, session);
    }
    const perSession = [...servedPerSession.values()];
    return {
      skipAhead: SKIP_AHEAD,
      blocked,
      cappedServedPerSec: round(cappedServed / WAKE_SECONDS),
      cappedMaxPerSec,
      cappedMaxRunning: maxRunning,
      slotIdleP50Ms: percentile(slotIdle, 0.5),
      slotIdleP95Ms: percentile(slotIdle, 0.95),
      slotIdleMaxMs: slotIdle.length ? Math.max(...slotIdle) : 0,
      sessionsServed: perSession.length,
      maxServedPerSession: perSession.length ? Math.max(...perSession) : 0,
      firstServesOutOfOrderPct: round((outOfOrder / (firstServeOrder.length || 1)) * 100),
      lastFirstServeSec: round((firstServeWait.at(-1) ?? 0) / 1000),
      lightSent,
      lightUnserved: lightSent - lightWaits.length,
      lightWaitP50Ms: percentile(lightWaits, 0.5),
      lightWaitP95Ms: percentile(lightWaits, 0.95),
      lightWaitMaxMs: lightWaits.length ? Math.max(...lightWaits) : 0,
      dequeueCallsPerSec: round((await dequeues.calls()) / WAKE_SECONDS),
      acksPerSec: round(acks / WAKE_SECONDS),
      redisCmdsPerSec: Math.round(side.commands / WAKE_SECONDS),
      redisCmdsPerServedRun: Math.round(side.commands / (cappedServed + lightWaits.length || 1)),
      scriptUsPerSec: Math.round(side.scriptUsec / WAKE_SECONDS),
    };
  } finally {
    await queue.quit();
  }
}

/**
 * The releaser and the waiters are on different queues that share the gate. Five runs on
 * QUEUE hold the cap; sessions on OTHER_QUEUE wait behind it and nothing else touches that
 * queue. Each holder is acknowledged in turn and the time until a waiting run is handed to
 * a worker is recorded. Admitted waiters are never acknowledged, so every sample is a slot
 * freed from the other queue.
 */
async function runCrossQueueScenario(redisContainer: any) {
  const queue = createQueue(redisContainer, true);
  try {
    await queue.redis.flushdb();
    await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
    await queue.updateQueueConcurrencyLimits(env, OTHER_QUEUE, 50);
    await queue.updateQueueConcurrencyLimits(env, GATE, GATE_PER_KEY);
    const pop = (seconds: number) =>
      queue.dequeueMessageFromWorkerQueue("bench", "main", {
        blockingPop: true,
        blockingPopTimeoutSeconds: seconds,
      });

    const t0 = Date.now() - 600_000;
    for (let i = 0; i < GATE_PER_KEY; i++) {
      await enqueue(queue, `hold-${i}`, `tA-hold-${i}`, "tA", t0 + i, false);
    }
    const holders: string[] = [];
    while (holders.length < GATE_PER_KEY) {
      const popped = await pop(5);
      if (!popped) throw new Error("holders were not admitted");
      holders.push(popped.messageId);
    }
    for (let i = 0; i < 20; i++) {
      await enqueue(queue, `w-${i}`, `tA-w${i}`, "tA", t0 + 100 + i, false, OTHER_QUEUE);
    }
    await sleep(3_000);

    const waits: number[] = [];
    for (const holder of holders) {
      const releasedAt = Date.now();
      await queue.acknowledgeMessage(env.organization.id, holder);
      const popped = await pop(30);
      waits.push(popped ? Date.now() - releasedAt : -1);
      await sleep(Math.max(0, 7_000 - (Date.now() - releasedAt)));
    }
    return {
      skipAhead: SKIP_AHEAD,
      samples: waits.join(","),
      waitMinMs: Math.min(...waits),
      waitMedianMs: percentile(waits, 0.5),
      waitMaxMs: Math.max(...waits),
    };
  } finally {
    await queue.quit();
  }
}

/**
 * Cost of a large blocked backlog once it has settled. One tenant sits at its gate cap
 * with STEADY_PARKED sessions queued behind it and never frees a slot; light tenants
 * arrive at ARRIVAL_RATE and are acknowledged at once. Script calls and Redis commands
 * are sampled over a 60s window after a 30s warm-up.
 */
async function runSteadyScenario(redisContainer: any) {
  await seedBlockedTenant(redisContainer, STEADY_PARKED);
  const dequeues = dequeueCallCounter();
  const queue = createQueue(redisContainer, true, dequeues.meter);
  try {
    const enqueuedAt = new Map<string, number>();
    let waits: number[] = [];
    const startedAt = Date.now();
    const windows = [{ name: "settled", from: 30_000 }];
    const endsAt = startedAt + windows.at(-1)!.from + 60_000;

    const arrivals = (async () => {
      let sent = 0;
      while (Date.now() < endsAt) {
        const due = Math.floor(((Date.now() - startedAt) / 1000) * ARRIVAL_RATE);
        while (sent < due) {
          const tenant = (sent % TENANTS) + 1;
          const session = Math.floor(sent / TENANTS) % LIGHT_SESSIONS_PER_TENANT;
          const runId = `l-${sent}`;
          enqueuedAt.set(runId, Date.now());
          await enqueue(queue, runId, `t${tenant}-s${session}`, `t${tenant}`, Date.now(), false);
          sent++;
        }
        await sleep(5);
      }
    })();

    const consumer = (async () => {
      while (Date.now() < endsAt) {
        const popped = await queue.dequeueMessageFromWorkerQueue("bench", "main", {
          blockingPop: true,
          blockingPopTimeoutSeconds: 1,
        });
        if (!popped) continue;
        if (popped.messageId.startsWith("a-")) {
          throw new Error(`benchmark invariant broken: ${popped.messageId} passed a full gate`);
        }
        waits.push(Date.now() - enqueuedAt.get(popped.messageId)!);
        enqueuedAt.delete(popped.messageId);
        await queue.acknowledgeMessage(env.organization.id, popped.messageId);
      }
    })();

    const results: Array<Record<string, number | string | boolean>> = [];
    for (const window of windows) {
      await sleep(Math.max(0, startedAt + window.from - Date.now()));
      await queue.redis.call("CONFIG", "RESETSTAT");
      await dequeues.reset();
      waits = [];
      await sleep(60_000);
      const side = await redisSide(queue);
      const parked = (await queue.redis.keys(`${KEY_PREFIX}*ckHint:*`)).length;
      results.push({
        skipAhead: SKIP_AHEAD,
        window: window.name,
        blocked: STEADY_PARKED,
        parked,
        dequeueCallsPerSec: round((await dequeues.calls()) / 60),
        redisCmdsPerSec: Math.round(side.commands / 60),
        scriptUsPerSec: Math.round(side.scriptUsec / 60),
        lightServedPerSec: round(waits.length / 60),
        lightWaitP50Ms: percentile(waits, 0.5),
        lightWaitP95Ms: percentile(waits, 0.95),
      });
    }
    await Promise.all([arrivals, consumer]);
    return results;
  } finally {
    await queue.quit();
  }
}

/**
 * Many gate pools on one queue, each with one parked sub-queue, as when a gate follows the
 * run's own key. Each pool's slot is held by a run on OTHER_QUEUE; nothing else touches
 * QUEUE. A holder is acknowledged every 100ms, in a scattered order, and the time until
 * the waiter behind it is handed to a worker is recorded.
 */
async function runManyPoolsScenario(redisContainer: any) {
  const dequeues = dequeueCallCounter();
  const queue = createQueue(redisContainer, true, dequeues.meter);
  const sessionGate = "limit/session";
  try {
    await queue.redis.flushdb();
    await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
    await queue.updateQueueConcurrencyLimits(env, OTHER_QUEUE, 50);
    await queue.updateQueueConcurrencyLimits(env, sessionGate, 1);
    const pop = (seconds: number) =>
      queue.dequeueMessageFromWorkerQueue("bench", "main", {
        blockingPop: true,
        blockingPopTimeoutSeconds: seconds,
      });
    const enqueueOn = async (
      runId: string,
      queueName: string,
      session: string,
      key: string,
      at: number
    ) => {
      const message: InputPayload = {
        runId,
        taskIdentifier: queueName,
        orgId: env.organization.id,
        projectId: env.project.id,
        environmentId: env.id,
        environmentType: env.type,
        queue: queueName,
        concurrencyKey: session,
        timestamp: at,
        attempt: 0,
        gates: [{ queue: sessionGate, concurrencyKey: key }],
      };
      await queue.enqueueMessage({ env, message, workerQueue: "main" });
    };

    const t0 = Date.now() - 600_000;
    for (let i = 0; i < POOLS; i++) {
      await enqueueOn(
        `hold-${i}`,
        POOLS_HOLDERS_SAME ? QUEUE : OTHER_QUEUE,
        `h${i}`,
        `k${i}`,
        t0 + i
      );
    }
    for (let admitted = 0; admitted < POOLS; admitted++) {
      if (!(await pop(10))) throw new Error(`only ${admitted} holders were admitted`);
    }
    for (let i = 0; i < POOLS; i++) {
      await enqueueOn(`w-${i}`, QUEUE, `s${i}`, `k${i}`, t0 + 1000 + i);
    }
    await sleep(8_000);

    await queue.redis.call("CONFIG", "RESETSTAT");
    await dequeues.reset();
    const startedAt = Date.now();
    const freedAt = new Map<number, number>();
    const waits: number[] = [];
    const releases = Math.min(POOLS, Number(process.env.BENCH_POOLS_RELEASES ?? POOLS));
    const releasing = (async () => {
      for (let n = 0; n < releases; n++) {
        const pool = (n * 197) % POOLS;
        freedAt.set(pool, Date.now());
        await queue.acknowledgeMessage(env.organization.id, `hold-${pool}`);
        await sleep(100);
      }
    })();
    const deadline = startedAt + releases * 100 + 30_000;
    while (waits.length < releases && Date.now() < deadline) {
      const popped = await pop(1);
      if (!popped) continue;
      const pool = Number(popped.messageId.split("-")[1]);
      waits.push(Date.now() - freedAt.get(pool)!);
    }
    await releasing;
    const seconds = (Date.now() - startedAt) / 1000;
    const side = await redisSide(queue);
    return {
      skipAhead: SKIP_AHEAD,
      pools: POOLS,
      holders: POOLS_HOLDERS_SAME ? "same queue" : "other queue",
      released: releases,
      served: waits.length,
      waitP50Ms: percentile(waits, 0.5),
      waitP95Ms: percentile(waits, 0.95),
      waitMaxMs: waits.length ? Math.max(...waits) : 0,
      dequeueCallsPerSec: round((await dequeues.calls()) / seconds),
      redisCmdsPerSec: Math.round(side.commands / seconds),
      scriptUsPerSec: Math.round(side.scriptUsec / seconds),
    };
  } finally {
    await queue.quit();
  }
}

describe("run-queue gate-blocked variants benchmark", () => {
  redisTest("a keyed gate at its cap blocking many variants", async ({ redisContainer }) => {
    const results: Array<Record<string, number | string | boolean>> = [];
    for (const interval of INTERVALS) {
      for (const blocked of BLOCKED) {
        results.push(await runScenario(redisContainer, blocked, interval));
      }
    }

    const summary = {
      config: {
        maxCount: MAX_COUNT,
        gatePerKey: GATE_PER_KEY,
        tenants: TENANTS,
        lightSessions: TENANTS * LIGHT_SESSIONS_PER_TENANT,
        lightRunsPerSession: LIGHT_RUNS_PER_SESSION,
        heavyRuns: HEAVY_RUNS,
        fairnessCalls: FAIRNESS_CALLS,
        maxSeconds: MAX_SECONDS,
      },
      results,
    };
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "run-queue-gate-blocked-variants.json");
    await writeFile(outPath, JSON.stringify(summary, null, 2));
    console.table(results);
    console.log(`wrote ${outPath}`);
  });

  redisTest(
    "commands per acknowledgement, by waiters on the released gate",
    async ({ redisContainer }) => {
      const results: Array<Record<string, number | string | boolean>> = [];
      for (const waiters of [0, 1, 10]) {
        const queue = createQueue(redisContainer);
        try {
          await queue.redis.flushdb();
          await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
          await queue.updateQueueConcurrencyLimits(env, GATE, 1);
          const shard = keys.masterQueueShardForEnvironment(env.id, SHARD_COUNT);
          const t0 = Date.now() - 600_000;
          await enqueue(queue, "holder", "tA-hold", "tA", t0);
          await queue.testDequeueFromMasterQueue(shard, env.id, MAX_COUNT);
          for (let i = 0; i < waiters; i++) {
            await enqueue(queue, `a-blocked-${i}`, `tA-s${i}`, "tA", t0 + 1 + i);
          }
          await queue.testDequeueFromMasterQueue(shard, env.id, MAX_COUNT);
          await queue.redis.call("CONFIG", "RESETSTAT");
          await queue.acknowledgeMessage(env.organization.id, "holder", {
            skipDequeueProcessing: true,
          });
          const side = await redisSide(queue);
          results.push({
            skipAhead: SKIP_AHEAD,
            waiters,
            ackCommands: side.commands,
            ackScriptUs: side.scriptUsec,
          });
        } finally {
          await queue.quit();
        }
      }
      await mkdir(OUT_DIR, { recursive: true });
      const outPath = join(OUT_DIR, "run-queue-gate-release-cost.json");
      await writeFile(outPath, JSON.stringify({ results }, null, 2));
      console.table(results);
      console.log(`wrote ${outPath}`);
    }
  );

  redisTest("fresh arrivals behind a keyed gate at its cap", async ({ redisContainer }) => {
    const results: Array<Record<string, number | string | boolean>> = [];
    for (const live of process.env.BENCH_ARRIVAL_PACING === "live" ? [true] : [false, true]) {
      for (const blocked of ARRIVAL_BLOCKED) {
        results.push(await runArrivalScenario(redisContainer, blocked, live));
      }
    }

    const summary = {
      config: {
        maxCount: MAX_COUNT,
        gatePerKey: GATE_PER_KEY,
        lightSessions: TENANTS * LIGHT_SESSIONS_PER_TENANT,
        arrivalRatePerSecond: ARRIVAL_RATE,
        seconds: ARRIVAL_SECONDS,
        fixedPollMs: ARRIVAL_POLL_MS,
        live: { ...LIVE, shardCount: SHARD_COUNT },
      },
      results,
    };
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "run-queue-gate-blocked-arrivals.json");
    await writeFile(outPath, JSON.stringify(summary, null, 2));
    console.table(results);
    console.log(`wrote ${outPath}`);
  });
  redisTest("a capped tenant whose runs complete", async ({ redisContainer }) => {
    const results: Array<Record<string, number | string | boolean>> = [];
    for (const blocked of WAKE_BLOCKED) {
      results.push(await runWakeScenario(redisContainer, blocked));
    }
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "run-queue-gate-wake.json");
    await writeFile(
      outPath,
      JSON.stringify(
        {
          config: {
            gatePerKey: GATE_PER_KEY,
            cappedRunMs: WAKE_RUN_MS,
            lightArrivalRatePerSecond: ARRIVAL_RATE,
            seconds: WAKE_SECONDS,
            live: { ...LIVE, shardCount: SHARD_COUNT },
          },
          results,
        },
        null,
        2
      )
    );
    console.table(results);
    console.log(`wrote ${outPath}`);
  });

  redisTest("a freed slot reaching a waiter on another queue", async ({ redisContainer }) => {
    const results: Array<Record<string, number | string | boolean>> = [];
    results.push(await runCrossQueueScenario(redisContainer));
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "run-queue-gate-cross-queue.json");
    await writeFile(outPath, JSON.stringify({ results }, null, 2));
    console.table(results);
    console.log(`wrote ${outPath}`);
  });
  redisTest("a settled backlog of blocked sub-queues", async ({ redisContainer }) => {
    const results: Array<Record<string, number | string | boolean>> = [];
    results.push(...(await runSteadyScenario(redisContainer)));
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "run-queue-gate-steady.json");
    await writeFile(outPath, JSON.stringify({ results }, null, 2));
    console.table(results);
    console.log(`wrote ${outPath}`);
  });
  redisTest("many gate pools with capacity freed on another queue", async ({ redisContainer }) => {
    const results: Array<Record<string, number | string | boolean>> = [];
    results.push(await runManyPoolsScenario(redisContainer));
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "run-queue-gate-pools.json");
    await writeFile(outPath, JSON.stringify({ results }, null, 2));
    console.table(results);
    console.log(`wrote ${outPath}`);
  });
});
