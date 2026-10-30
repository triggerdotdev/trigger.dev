/**
 * Cost of one concurrency-sweeper pass (`scanConcurrencySets`) at different SCAN COUNTs.
 *
 * Seeds a testcontainers Redis with BENCH_SETS queue currentConcurrency sets plus
 * BENCH_UNRELATED_PER_SET non-matching keys per set (default 4,000 sets x (1 set + 99
 * unrelated) = 400k keys, 1% matching), then runs one full sweep per entry in
 * BENCH_SCAN_COUNTS and reports SCAN calls, SSCAN calls, total commands, server usec for
 * each, Redis process CPU, wall time, peak RSS during the sweep, and whether the callback
 * saw exactly the seeded run ids.
 *
 * Run on demand: `pnpm run test:bench src/run-queue/bench/concurrencySweeperScan --silent=false`.
 * Knobs: BENCH_SETS, BENCH_UNRELATED_PER_SET, BENCH_SCAN_COUNTS (default "10,1000").
 */
import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { seedSweeperKeyspace } from "../tests/sweeperKeyspace.js";

vi.setConfig({ testTimeout: 900_000 });

const SETS = Number(process.env.BENCH_SETS ?? 4_000);
const UNRELATED_PER_SET = Number(process.env.BENCH_UNRELATED_PER_SET ?? 99);
const SCAN_COUNTS = (process.env.BENCH_SCAN_COUNTS ?? "10,1000").split(",").map(Number);
const KEY_PREFIX = "engine:runqueue:";

function createQueue(redisContainer: any, scanCount: number, seen: Set<string>) {
  const redis = {
    keyPrefix: KEY_PREFIX,
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    name: "rq",
    tracer: trace.getTracer("rq"),
    logger: new Logger("RunQueue", "warn"),
    defaultEnvConcurrency: 10,
    keys: new RunQueueFullKeyProducer(),
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis,
      keys: new RunQueueFullKeyProducer(),
    }),
    redis,
    concurrencySweeper: {
      scanCount,
      callback: async (runIds) => {
        runIds.forEach((id) => seen.add(id));
        return [];
      },
    },
  });
}

async function stats(queue: RunQueue) {
  const [commandstats, info, cpu] = await Promise.all([
    queue.redis.info("commandstats"),
    queue.redis.info("stats"),
    queue.redis.info("cpu"),
  ]);
  const cpuSeconds = (name: string) => Number(cpu.match(new RegExp(`${name}:([\\d.]+)`))![1]);
  const cmd = (name: string) => {
    const m = commandstats.match(new RegExp(`cmdstat_${name}:calls=(\\d+),usec=(\\d+)`));
    return { calls: m ? Number(m[1]) : 0, usec: m ? Number(m[2]) : 0 };
  };
  return {
    scan: cmd("scan"),
    sscan: cmd("sscan"),
    total: Number(info.match(/total_commands_processed:(\d+)/)![1]),
    // Whole-process Redis CPU, including the per-call network/parse cost commandstats leaves out.
    cpuMs: (cpuSeconds("used_cpu_user") + cpuSeconds("used_cpu_sys")) * 1000,
  };
}

describe("concurrency sweeper SCAN COUNT benchmark", () => {
  redisTest("one full sweep per SCAN COUNT", async ({ redisContainer }) => {
    const seedQueue = createQueue(redisContainer, 1000, new Set());
    let expected: Set<string>;
    let dbsize: number;
    try {
      const startedAt = performance.now();
      expected = await seedSweeperKeyspace(seedQueue.redis, {
        concurrencySets: SETS,
        unrelatedPerSet: UNRELATED_PER_SET,
      });
      dbsize = await seedQueue.redis.dbsize();
      console.log(
        `seeded ${dbsize} keys (${SETS} matching sets, ${expected.size} run ids) in ${Math.round(
          performance.now() - startedAt
        )}ms`
      );
    } finally {
      await seedQueue.quit();
    }

    const results: Array<Record<string, number | string | boolean>> = [];
    for (const scanCount of SCAN_COUNTS) {
      const seen = new Set<string>();
      const queue = createQueue(redisContainer, scanCount, seen);
      try {
        const rssBefore = process.memoryUsage.rss();
        let rssPeak = rssBefore;
        const sampler = setInterval(() => {
          rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
        }, 5);

        const before = await stats(queue);
        const startedAt = performance.now();
        const sweep = await queue["scanConcurrencySets"]();
        const wallMs = performance.now() - startedAt;
        const after = await stats(queue);
        clearInterval(sampler);
        rssPeak = Math.max(rssPeak, process.memoryUsage.rss());

        const identical = seen.size === expected.size && [...seen].every((id) => expected.has(id));
        results.push({
          scanCount,
          scanCalls: after.scan.calls - before.scan.calls,
          scanServerMs: Math.round((after.scan.usec - before.scan.usec) / 1000),
          sscanCalls: after.sscan.calls - before.sscan.calls,
          sscanServerMs: Math.round((after.sscan.usec - before.sscan.usec) / 1000),
          totalCommands: after.total - before.total,
          redisCpuMs: Math.round(after.cpuMs - before.cpuMs),
          wallMs: Math.round(wallMs),
          rssBeforeMB: Math.round(rssBefore / 2 ** 20),
          rssPeakMB: Math.round(rssPeak / 2 ** 20),
          keysProcessed: sweep?.processedKeys ?? 0,
          runIdsSeen: seen.size,
          identical,
        });
        expect(identical).toBe(true);
      } finally {
        await queue.quit();
      }
    }

    console.log(`dbsize=${dbsize}`);
    console.table(results);
  });
});
