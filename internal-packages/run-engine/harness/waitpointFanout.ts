/**
 * A runtime harness for waitpoint completion fanout and lifecycle cleanup.
 *
 * It drives the PRODUCTION `WaitpointStoreCoordinator`, its Lua protocol, its serializers
 * and the production `WaitpointFanoutWorker` against a real Redis, with no mocks and no
 * substitutes. Its only concessions to being a harness are a key prefix, so it can share a
 * development Redis without touching anything else, and a `--role=worker` mode used to get
 * a genuinely separate process to kill.
 *
 * Inert by construction: it lives outside `src`, so it is not part of the package build, and
 * nothing imports it.
 *
 *   pnpm --filter @internal/run-engine run harness:waitpoint-fanout
 *   REDIS_HOST=localhost REDIS_PORT=6379 pnpm ... run harness:waitpoint-fanout
 */
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import { spawn } from "node:child_process";
import { WaitpointFanoutWorker } from "../src/engine/waitpointCoordinator/fanoutWorker.js";
import { fanoutIndexKeys, fanoutPartition } from "../src/engine/waitpointCoordinator/keys.js";
import {
  WaitpointStoreCoordinator,
  type BlockEdge,
  type WaitpointCompletion,
  type WaitpointRecordInput,
  MAX_INLINE_COMPLETION_OUTPUT_BYTES,
} from "../src/engine/waitpointCoordinator/storeCoordinator.js";

const PREFIX = "wpharness:";
const NOW_ISO = new Date().toISOString();
const LEASE_MS = 5_000;
const RETENTION_MS = 600_000;
const PROGRESS_KEY = `${PREFIX}progress`;

function redisOptions(): RedisOptions {
  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    // Prefixed so a shared development Redis is safe. ioredis prefixes the KEYS array, and
    // no script mints a key in Lua, so the whole protocol shifts under it. The prefix
    // carries no brace, so every hash tag is still the one the keyspace intends.
    keyPrefix: PREFIX,
    maxRetriesPerRequest: 5,
  };
}

function store(): WaitpointStoreCoordinator {
  return new WaitpointStoreCoordinator({
    redisOptions: redisOptions(),
    terminalRetentionMs: RETENTION_MS,
    logger: new Logger("harness-store", "error"),
  });
}

function record(id: string): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    environmentId: "env_harness",
    projectId: "proj_harness",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    userProvidedIdempotencyKey: false,
    tags: [],
  };
}

function completion(value: string): WaitpointCompletion {
  return {
    completedAt: NOW_ISO,
    outputType: "application/json",
    outputIsError: false,
    output: { inline: value },
  };
}

function edge(waitpointId: string): BlockEdge {
  return { waitpointId, createdAt: NOW_ISO, type: "MANUAL" };
}

function say(step: string, detail: string): void {
  console.log(`  ${step.padEnd(8)} ${detail}`);
}

function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}     ${label}: ${detail}`);
  if (!ok) {
    failures.push(label);
  }
}

const failures: string[] = [];

async function blockRuns(
  coordinator: WaitpointStoreCoordinator,
  waitpointId: string,
  runIds: string[]
): Promise<void> {
  for (const runId of runIds) {
    await coordinator.registerBlocks({
      runId,
      blockId: `blk_${runId}`,
      edges: [edge(waitpointId)],
    });
  }
}

/**
 * `--role=worker`: a separate process holding a real claim, so the parent has something to
 * SIGKILL. It reports each delivery through a Redis list and then stops responding at
 * `--stall-after`, which is what a process wedged mid-page looks like.
 */
async function runWorkerRole(): Promise<void> {
  const waitpointId = requiredArg("waitpoint");
  const stallAfter = Number(requiredArg("stall-after"));
  const coordinator = store();
  const progress = createRedisClient(redisOptions());
  let delivered = 0;

  const worker = new WaitpointFanoutWorker({
    coordinator,
    enabled: true,
    workerId: `harness-child-${process.pid}`,
    pageSize: 5,
    leaseMs: LEASE_MS,
    deliveryConcurrency: 1,
    logger: new Logger("harness-child", "error"),
    hooks: {
      afterDeliver: async () => {
        delivered++;
        await progress.rpush("progress", String(delivered));
        if (delivered >= stallAfter) {
          // Hold the claim and never acknowledge. The parent kills the process here.
          await new Promise(() => undefined);
        }
      },
    },
  });

  await worker.visit(waitpointId);
  await coordinator.quit();
  progress.disconnect();
}

function requiredArg(name: string): string {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!found) {
    throw new Error(`harness: --${name}= is required`);
  }
  return found.slice(name.length + 3);
}

async function main(): Promise<void> {
  const coordinator = store();
  const probe = createRedisClient(redisOptions());
  const raw = createRedisClient({ ...redisOptions(), keyPrefix: undefined });

  try {
    await flush(raw);

    // ---------------------------------------------------------------- steps 1-5, 9
    console.log("\n[1-5] pending waitpoint, multi-page fanout, foreground returns early");
    const w1 = "w_harness_multipage";
    await coordinator.createIfAbsent({ record: record(w1), status: "PENDING" });
    const w1Runs = Array.from({ length: 12 }, (_, i) => `run_mp_${i}`);
    await blockRuns(coordinator, w1, w1Runs);
    say("2", `${w1Runs.length} runs blocked; queue depth ${await probe.llen(`wp:v1:{${w1}}:q`)}`);

    const startedAt = performance.now();
    const completed = await coordinator.complete({ waitpointId: w1, completion: completion("1") });
    const foregroundMs = performance.now() - startedAt;
    say("3", `complete() returned in ${foregroundMs.toFixed(1)}ms, fanout=${completed.fanout}`);

    const deliveredBefore = await countReceipts(probe, w1Runs, w1);
    check(
      "foreground completion delivers nothing itself",
      deliveredBefore === 0,
      `${deliveredBefore}/${w1Runs.length} receipts immediately after complete()`
    );

    const w1Worker = new WaitpointFanoutWorker({
      coordinator,
      enabled: true,
      workerId: "harness-main",
      pageSize: 5,
      leaseMs: LEASE_MS,
      maxPagesPerVisit: 10,
      logger: new Logger("harness-main", "error"),
    });
    const drained = await w1Worker.visit(w1);
    say(
      "5",
      `worker drained: pages=${drained.pages} delivered=${drained.delivered} outcome=${drained.outcome}`
    );
    check(
      "every page drained",
      drained.outcome === "drained" && drained.pages === 3 && drained.delivered === 12,
      `pages=${drained.pages} delivered=${drained.delivered}`
    );
    check(
      "every blocked run has a receipt",
      (await countReceipts(probe, w1Runs, w1)) === w1Runs.length,
      `${await countReceipts(probe, w1Runs, w1)}/${w1Runs.length}`
    );

    console.log("\n[9] registration after completion");
    const late = await coordinator.registerOrReport({
      waitpointId: w1,
      runId: "run_mp_late",
      blockId: "blk_late",
      createdAt: NOW_ISO,
    });
    const lateOutput = late.outcome === "completed" ? late.completion?.output : undefined;
    check(
      "a late registration completes immediately",
      late.outcome === "completed" && lateOutput !== undefined,
      `outcome=${late.outcome} output=${JSON.stringify(lateOutput)}`
    );
    check(
      "and queues no new fanout work",
      (await probe.exists(`wp:v1:{${w1}}:q`)) === 0,
      `queue exists=${await probe.exists(`wp:v1:{${w1}}:q`)}`
    );

    // ---------------------------------------------------------------- steps 6-8
    console.log("\n[6-8] a worker killed mid-delivery, then reclaimed");
    const w2 = "w_harness_crash";
    await coordinator.createIfAbsent({ record: record(w2), status: "PENDING" });
    const w2Runs = Array.from({ length: 12 }, (_, i) => `run_crash_${i}`);
    await blockRuns(coordinator, w2, w2Runs);
    await coordinator.complete({ waitpointId: w2, completion: completion("2") });

    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        process.argv[1]!,
        "--role=worker",
        `--waitpoint=${w2}`,
        "--stall-after=3",
      ],
      { stdio: ["ignore", "inherit", "inherit"], env: process.env }
    );

    // A barrier, not a sleep: BLPOP returns the instant the child reports a delivery.
    for (let i = 0; i < 3; i++) {
      const popped = await raw.blpop(PROGRESS_KEY, 30);
      if (!popped) {
        throw new Error("harness: child worker never reported a delivery");
      }
    }
    const midFlight = await countReceipts(probe, w2Runs, w2);
    const owner = await probe.hget(`wp:v1:{${w2}}:f`, "owner");
    say("6", `child pid ${child.pid} delivered ${midFlight}, holds claim ${owner}`);

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    say("6", `child killed; queue still holds ${await probe.llen(`wp:v1:{${w2}}:q`)} watchers`);

    check(
      "the killed worker's claim is still recorded",
      owner === `harness-child-${child.pid}`,
      `owner=${owner}`
    );
    check(
      "no acknowledged progress was lost or over-claimed",
      Number(await probe.hget(`wp:v1:{${w2}}:f`, "del")) === 0 &&
        (await probe.llen(`wp:v1:{${w2}}:q`)) === 12,
      `del=${await probe.hget(`wp:v1:{${w2}}:f`, "del")} queue=${await probe.llen(`wp:v1:{${w2}}:q`)}`
    );

    let survivorNow = Date.now();
    const survivor = new WaitpointFanoutWorker({
      clock: () => survivorNow,
      coordinator,
      enabled: true,
      workerId: "harness-survivor",
      pageSize: 5,
      leaseMs: LEASE_MS,
      maxPagesPerVisit: 10,
      logger: new Logger("harness-survivor", "error"),
    });
    const busy = await survivor.visit(w2);
    check("a live claim cannot be stolen", busy.outcome === "busy", `outcome=${busy.outcome}`);

    // Lease expiry expressed by advancing the worker's clock, so the reclaim is
    // deterministic and every operation inside the visit agrees on the new instant.
    survivorNow = Date.now() + LEASE_MS + 1;
    const reclaimed = await survivor.visit(w2);
    say(
      "7",
      `reclaimed: pages=${reclaimed.pages} delivered=${reclaimed.delivered} ` +
        `duplicates=${reclaimed.duplicates} outcome=${reclaimed.outcome}`
    );
    check(
      "the abandoned work was reclaimed and finished",
      reclaimed.outcome === "drained" && reclaimed.duplicates === midFlight,
      `outcome=${reclaimed.outcome} duplicates=${reclaimed.duplicates} (expected ${midFlight})`
    );

    const receipts = await Promise.all(
      w2Runs.map((runId) => probe.hlen(`wp:v1:run:{${runId}}:done`))
    );
    check(
      "every run holds exactly one effective receipt",
      receipts.every((count) => count === 1),
      `receipt counts: ${[...new Set(receipts)].join(",")}`
    );

    // ---------------------------------------------------------------- step 10
    console.log("\n[10] a cancelled watcher is not delivered to");
    const w3 = "w_harness_cancel";
    await coordinator.createIfAbsent({ record: record(w3), status: "PENDING" });
    await blockRuns(coordinator, w3, ["run_keep", "run_cancelled"]);
    await coordinator.unregisterWatcher({
      waitpointId: w3,
      runId: "run_cancelled",
      blockId: "blk_run_cancelled",
    });
    await coordinator.complete({ waitpointId: w3, completion: completion("3") });
    const cancelSummary = await new WaitpointFanoutWorker({
      coordinator,
      enabled: true,
      workerId: "harness-cancel",
      leaseMs: LEASE_MS,
      logger: new Logger("harness-cancel", "error"),
    }).visit(w3);
    check(
      "the cancelled watcher is skipped as stale",
      cancelSummary.delivered === 1 && cancelSummary.staleWatchers === 1,
      `delivered=${cancelSummary.delivered} stale=${cancelSummary.staleWatchers}`
    );
    check(
      "and receives no receipt",
      (await probe.hlen("wp:v1:run:{run_cancelled}:done")) === 0 &&
        (await probe.hlen("wp:v1:run:{run_keep}:done")) === 1,
      `cancelled=${await probe.hlen("wp:v1:run:{run_cancelled}:done")} kept=${await probe.hlen(
        "wp:v1:run:{run_keep}:done"
      )}`
    );

    // ---------------------------------------------------------------- step 11
    console.log("\n[11] the durable resume handoff gates cleanup and terminal TTL");
    const w4 = "w_harness_handoff";
    await coordinator.createIfAbsent({ record: record(w4), status: "PENDING" });
    await coordinator.registerBlocks({
      runId: "run_handoff",
      blockId: "blk_handoff",
      edges: [edge(w4)],
    });
    await coordinator.complete({ waitpointId: w4, completion: completion("4") });
    await new WaitpointFanoutWorker({
      coordinator,
      enabled: true,
      workerId: "harness-handoff",
      leaseMs: LEASE_MS,
      logger: new Logger("harness-handoff", "error"),
    }).visit(w4);

    const owed = await coordinator.readBlockState("run_handoff");
    check(
      "the run owes a handoff once every blocker is met",
      owed.handoff === "owed",
      `handoff=${owed.handoff}`
    );

    const refused = await coordinator.cleanupRunBlockState({
      runId: "run_handoff",
      reason: "resume",
    });
    check(
      "cleanup is refused before the handoff is acknowledged",
      refused.outcome === "retained",
      `outcome=${refused.outcome}`
    );
    check(
      "and the receipt is retained with no TTL",
      (await probe.hlen("wp:v1:run:{run_handoff}:done")) === 1 &&
        (await probe.pttl("wp:v1:run:{run_handoff}:done")) === -1,
      `receipts=${await probe.hlen("wp:v1:run:{run_handoff}:done")} pttl=${await probe.pttl(
        "wp:v1:run:{run_handoff}:done"
      )}`
    );

    await coordinator.acknowledgeResumeHandoff({ runId: "run_handoff", blockId: "blk_handoff" });
    const armed = await coordinator.cleanupRunBlockState({
      runId: "run_handoff",
      reason: "resume",
    });
    const ttl = await probe.pttl("wp:v1:run:{run_handoff}:st");
    check(
      "and armed only once the handoff is durable",
      armed.outcome === "armed" && ttl > 0 && ttl <= RETENTION_MS,
      `outcome=${armed.outcome} pttl=${ttl}`
    );
    check(
      "the completed waitpoint's own record is on the terminal window",
      (await probe.pttl(`wp:v1:{${w4}}`)) > 0,
      `pttl=${await probe.pttl(`wp:v1:{${w4}}`)}`
    );

    // ---------------------------------------------------------------- consecutive blocks
    console.log("\n[13] consecutive block cycles with an interrupted cleanup");
    const w6 = "w_harness_cycle_one";
    const w7 = "w_harness_cycle_two";
    for (const id of [w6, w7]) {
      await coordinator.createIfAbsent({ record: record(id), status: "PENDING" });
    }
    await coordinator.registerBlocks({
      runId: "run_cycles",
      blockId: "blk_cycle_1",
      edges: [edge(w6)],
    });
    await coordinator.complete({ waitpointId: w6, completion: completion("6") });
    await new WaitpointFanoutWorker({
      coordinator,
      enabled: true,
      workerId: "harness-cycles",
      leaseMs: LEASE_MS,
      logger: new Logger("harness-cycles", "error"),
    }).visit(w6);
    await coordinator.acknowledgeResumeHandoff({
      runId: "run_cycles",
      blockId: "blk_cycle_1",
    });
    // Deliberately NOT draining: this is what an acknowledgement interrupted before its
    // cleanup leaves behind.
    const stranded = await coordinator.readBlockState("run_cycles");
    say(
      "13",
      `cycle one acknowledged, cleanup skipped: receipts=${stranded.deliveredIds.length} edges=${stranded.edges.length}`
    );

    await coordinator.registerBlocks({
      runId: "run_cycles",
      blockId: "blk_cycle_2",
      edges: [edge(w7)],
      // Names its predecessor, as the compare-and-set requires of a rollover.
      expectedPreviousBlockId: "blk_cycle_1",
    });
    const rolled = await coordinator.readBlockState("run_cycles");
    check(
      "a new cycle carries none of the previous cycle's state",
      rolled.blockId === "blk_cycle_2" &&
        rolled.handoff === "none" &&
        rolled.deliveredIds.length === 0 &&
        rolled.pendingIds.join() === w7 &&
        rolled.edges.length === 1 &&
        rolled.edges[0]?.waitpointId === w7,
      `blk=${rolled.blockId} handoff=${rolled.handoff} pending=[${rolled.pendingIds}] ` +
        `receipts=[${rolled.deliveredIds}] edges=[${rolled.edges.map((e) => e.waitpointId)}]`
    );

    const lateDelivery = await coordinator.deliverCompletion({
      runId: "run_cycles",
      blockId: "blk_cycle_1",
      waitpointId: w6,
      completion: completion("6"),
    });
    check(
      "an older cycle's delivery is refused and leaves the new cycle alone",
      lateDelivery.outcome === "stale" && lateDelivery.resumable === false,
      `outcome=${lateDelivery.outcome} resumable=${lateDelivery.resumable}`
    );

    // ---------------------------------------------------------------- backoff preservation
    console.log("\n[14] a duplicate completion preserves an existing fanout backoff");
    const w8 = "w_harness_backoff";
    await coordinator.createIfAbsent({ record: record(w8), status: "PENDING" });
    await blockRuns(coordinator, w8, ["run_backoff"]);
    await coordinator.complete({ waitpointId: w8, completion: completion("8") });
    // An unroutable watcher, so the delivery stalls and the entry backs off.
    await probe.hset(
      `wp:v1:{${w8}}:w`,
      // The field `blockRuns` registered on: watchers are block-scoped, so overwriting the
      // real entry means naming its block too.
      "run_backoff##blk_run_backoff",
      JSON.stringify({ runId: "", blockId: "blk_run_backoff", createdAt: NOW_ISO })
    );
    const stalledAt = Date.now();
    const backoffWorker = new WaitpointFanoutWorker({
      clock: () => stalledAt,
      coordinator,
      enabled: true,
      workerId: "harness-backoff",
      leaseMs: LEASE_MS,
      logger: new Logger("harness-backoff", "error"),
    });
    const stalled = await backoffWorker.visit(w8);
    const dueKey = fanoutIndexKeys(fanoutPartition(w8)).due;
    const scheduled = Number(await probe.zscore(dueKey, w8));
    say("14", `delivery ${stalled.outcome}, rescheduled +${scheduled - stalledAt}ms`);

    const duplicate = await coordinator.complete({
      waitpointId: w8,
      completion: completion("8"),
    });
    check(
      "a duplicate completion does not pull the retry forward",
      duplicate.outcome === "already" && Number(await probe.zscore(dueKey, w8)) === scheduled,
      `outcome=${duplicate.outcome} score=${await probe.zscore(dueKey, w8)} (was ${scheduled})`
    );
    check(
      "and it does not count a second failure",
      (await probe.hget(`wp:v1:{${w8}}:f`, "fail")) === "1",
      `fail=${await probe.hget(`wp:v1:{${w8}}:f`, "fail")}`
    );

    // ---------------------------------------------------------------- step 12
    console.log("\n[12] a disabled worker is inert");
    const w5 = "w_harness_disabled";
    await coordinator.createIfAbsent({ record: record(w5), status: "PENDING" });
    await blockRuns(coordinator, w5, ["run_disabled"]);
    await coordinator.complete({ waitpointId: w5, completion: completion("5") });

    const disabled = new WaitpointFanoutWorker({ coordinator });
    disabled.start();
    await disabled.stop();
    check(
      "a default-constructed worker is disabled",
      disabled.enabled === false,
      `enabled=${disabled.enabled}`
    );
    check(
      "start() schedules nothing, so the owed work is untouched",
      (await probe.hlen("wp:v1:run:{run_disabled}:done")) === 0 &&
        (await probe.llen(`wp:v1:{${w5}}:q`)) === 1,
      `receipts=${await probe.hlen("wp:v1:run:{run_disabled}:done")} queue=${await probe.llen(
        `wp:v1:{${w5}}:q`
      )}`
    );

    // ---------------------------------------------------------------- size ceiling
    console.log("\n[15] the inline completion ceiling, measured");
    const w9 = "w_harness_maxinline";
    await coordinator.createIfAbsent({ record: record(w9), status: "PENDING" });
    await blockRuns(coordinator, w9, ["run_maxinline"]);

    // The largest inline output the coordinator accepts, end to end: fingerprint, envelope
    // write, fanout claim, one delivery, one receipt. Reported, never asserted on — the numbers
    // are for a human comparing shapes, and a threshold here would fail on a loaded machine.
    const maxInline = "x".repeat(MAX_INLINE_COMPLETION_OUTPUT_BYTES);
    const inlineStart = performance.now();
    await coordinator.complete({
      waitpointId: w9,
      completion: { ...completion("9"), output: { inline: maxInline } },
    });
    const inlineCompleteMs = performance.now() - inlineStart;

    const inlineFanoutStart = performance.now();
    const inlineSummary = await new WaitpointFanoutWorker({
      coordinator,
      enabled: true,
      workerId: "harness-maxinline",
      leaseMs: LEASE_MS,
      logger: new Logger("harness-maxinline", "error"),
    }).visit(w9);
    const inlineFanoutMs = performance.now() - inlineFanoutStart;

    say(
      "15",
      `inline ${MAX_INLINE_COMPLETION_OUTPUT_BYTES}B: complete ${inlineCompleteMs.toFixed(1)}ms, ` +
        `fanout ${inlineFanoutMs.toFixed(1)}ms, delivered ${inlineSummary.delivered}`
    );
    check(
      "the largest accepted inline completion delivers",
      inlineSummary.delivered === 1 && inlineSummary.outcome === "drained",
      `delivered=${inlineSummary.delivered} outcome=${inlineSummary.outcome}`
    );

    // One byte more is refused before any of that work happens.
    const oversizeStart = performance.now();
    let overCeilingRefused = false;
    try {
      await coordinator.complete({
        waitpointId: w9,
        completion: { ...completion("9"), output: { inline: `${maxInline}x` } },
      });
    } catch (error) {
      overCeilingRefused =
        error instanceof Error && error.name === "WaitpointCompletionTooLargeError";
    }
    const oversizeMs = performance.now() - oversizeStart;
    say("15", `one byte over: refused in ${oversizeMs.toFixed(2)}ms`);
    check(
      "one byte over the ceiling is refused",
      overCeilingRefused,
      `refused=${overCeilingRefused}`
    );

    // A ref completion carries a key, so its cost is independent of the payload behind it.
    const w10 = "w_harness_refoutput";
    await coordinator.createIfAbsent({ record: record(w10), status: "PENDING" });
    await blockRuns(coordinator, w10, ["run_refoutput"]);
    const refStart = performance.now();
    await coordinator.complete({
      waitpointId: w10,
      completion: { ...completion("10"), output: { ref: `${w10}/token.json` } },
    });
    const refSummary = await new WaitpointFanoutWorker({
      coordinator,
      enabled: true,
      workerId: "harness-refoutput",
      leaseMs: LEASE_MS,
      logger: new Logger("harness-refoutput", "error"),
    }).visit(w10);
    say("15", `ref output: complete+fanout ${(performance.now() - refStart).toFixed(1)}ms`);
    check(
      "a ref completion delivers regardless of the referenced payload",
      refSummary.delivered === 1 && refSummary.outcome === "drained",
      `delivered=${refSummary.delivered} outcome=${refSummary.outcome}`
    );

    // ---------------------------------------------------------------- wide fanout
    console.log("\n[16] a maximum-sized inline completion across a WIDE fanout");

    // One delivery proves the path; it does not probe the amplification. ioredis buffers the
    // completion once per in-flight command, so the burst scales with delivery concurrency and
    // not with the single serialization. Reported, never asserted on.
    async function wideFanout(
      label: string,
      id: string,
      watchers: number,
      options: { pageSize: number; deliveryConcurrency: number },
      output: WaitpointCompletion["output"]
    ) {
      await coordinator.createIfAbsent({ record: record(id), status: "PENDING" });
      await blockRuns(
        coordinator,
        id,
        Array.from({ length: watchers }, (_, i) => `run_${id}_${i}`)
      );
      await coordinator.complete({
        waitpointId: id,
        completion: { ...completion("16"), output },
      });

      // Event-loop delay sampler: a 10ms timer, measuring how late it actually fires.
      let worstDelay = 0;
      let last = performance.now();
      const sampler = setInterval(() => {
        const now = performance.now();
        worstDelay = Math.max(worstDelay, now - last - 10);
        last = now;
      }, 10);

      const start = performance.now();
      const summary = await new WaitpointFanoutWorker({
        coordinator,
        enabled: true,
        workerId: `harness-wide-${id}`,
        leaseMs: LEASE_MS,
        maxPagesPerVisit: 20,
        logger: new Logger("harness-wide", "error"),
        ...options,
      }).visit(id);
      const elapsed = performance.now() - start;
      clearInterval(sampler);

      say(
        "16",
        `${label}: pages=${summary.pages} delivered=${summary.delivered} ` +
          `total=${elapsed.toFixed(0)}ms worst-loop-delay=${worstDelay.toFixed(1)}ms ` +
          `heap=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)}MB`
      );
      check(
        `wide fanout drains: ${label}`,
        summary.delivered === watchers && summary.outcome === "drained",
        `delivered=${summary.delivered}/${watchers} outcome=${summary.outcome}`
      );
      return summary;
    }

    const maxOutput = { inline: "x".repeat(MAX_INLINE_COMPLETION_OUTPUT_BYTES) };

    // Default page size and delivery concurrency.
    await wideFanout(
      "max inline, default page/conc",
      "w_wide_default",
      100,
      {
        pageSize: 100,
        deliveryConcurrency: 10,
      },
      maxOutput
    );

    // Maximum permitted delivery concurrency — narrowed by the byte budget, not by the option.
    await wideFanout(
      "max inline, MAX conc (budgeted)",
      "w_wide_maxconc",
      100,
      {
        pageSize: 100,
        deliveryConcurrency: 100,
      },
      maxOutput
    );

    // Multiple pages.
    await wideFanout(
      "max inline, 5 pages",
      "w_wide_pages",
      100,
      {
        pageSize: 20,
        deliveryConcurrency: 10,
      },
      maxOutput
    );

    // A reference completion as the control: the budget must not touch it.
    await wideFanout(
      "ref completion, MAX conc (control)",
      "w_wide_ref",
      100,
      {
        pageSize: 100,
        deliveryConcurrency: 100,
      },
      { ref: "s3://bucket/w_wide_ref/token.json" }
    );

    // ---------------------------------------------------------------- diagnostics
    console.log("\n[diagnostics] operational read paths");
    const backlog = await coordinator.fanoutBacklog();
    console.log(`  backlog       ${JSON.stringify(backlog)}`);
    console.log(`  describe(w1)  ${JSON.stringify(await coordinator.describeWaitpoint(w1))}`);
    console.log(`  describe(w5)  ${JSON.stringify(await coordinator.describeWaitpoint(w5))}`);
    check(
      "the only remaining backlog is the two deliberately undelivered entries",
      // w5, owed to a disabled worker, and w8, backed off behind an unroutable watcher.
      backlog.due === 2 && backlog.quarantined === 0,
      JSON.stringify(backlog)
    );
    console.log(
      `  partitions    w1->${fanoutPartition(w1)} w2->${fanoutPartition(w2)} ` +
        `w5->${fanoutPartition(w5)} (index ${fanoutIndexKeys(fanoutPartition(w5)).due})`
    );
  } finally {
    await flush(raw);
    raw.disconnect();
    probe.disconnect();
    await coordinator.quit();
  }

  console.log(
    failures.length === 0
      ? "\nAll harness checks passed.\n"
      : `\n${failures.length} harness check(s) FAILED: ${failures.join(", ")}\n`
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

/** Remove only this harness's own keys, so a shared development Redis is left as it was. */
async function flush(raw: ReturnType<typeof createRedisClient>): Promise<void> {
  let cursor = "0";
  const doomed: string[] = [];
  do {
    const [next, batch] = await raw.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 1_000);
    doomed.push(...batch);
    cursor = next;
  } while (cursor !== "0");

  for (let i = 0; i < doomed.length; i += 500) {
    await raw.del(...doomed.slice(i, i + 500));
  }
}

async function countReceipts(
  probe: ReturnType<typeof createRedisClient>,
  runIds: string[],
  waitpointId: string
): Promise<number> {
  const present = await Promise.all(
    runIds.map((runId) => probe.hexists(`wp:v1:run:{${runId}}:done`, waitpointId))
  );
  return present.filter((exists) => exists === 1).length;
}

const isWorkerRole = process.argv.includes("--role=worker");

void (isWorkerRole ? runWorkerRole() : main()).catch((error) => {
  console.error(error);
  process.exit(1);
});
