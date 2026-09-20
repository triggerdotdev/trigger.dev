/**
 * Latency benchmark for the saturated-set reconcile inside the dequeue Lua script.
 *
 * Seeds a base queue whose groupConcurrency set is full of LEGITIMATE members (each
 * has a message key and sits in its home currentConcurrency set), so every pass pays
 * the worst-case per-member cost (GET, cjson.decode, SISMEMBER) and prunes nothing.
 * The set therefore stays saturated and every iteration measures the same work.
 *
 * Reports client-observed dequeue-script latency for: reconcile disabled (the
 * saturated dequeue's floor), and reconcile enabled at several SSCAN page sizes. The
 * enabled-minus-disabled delta divided by the page size is the per-member cost.
 *
 * Run on demand with `pnpm run test:bench` (kept out of the default suite).
 *
 * Results print as a table and land as JSON in `.bench/run-queue-reconcile.json` at the
 * repo root.
 *
 * Knobs, all optional: BENCH_MEMBERS (default 5000), BENCH_ITERATIONS (default 200),
 * BENCH_SCAN_COUNTS (comma list, default "20,100,500"), BENCH_OUT_DIR.
 */
import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Decimal } from "@trigger.dev/database";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue, type RunQueueOptions } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

vi.setConfig({ testTimeout: 900_000 });

const MEMBERS = Number(process.env.BENCH_MEMBERS ?? 5000);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 200);
const SCAN_COUNTS = (process.env.BENCH_SCAN_COUNTS ?? "20,100,500").split(",").map(Number);
const OUT_DIR = process.env.BENCH_OUT_DIR ?? join(process.cwd(), "..", "..", ".bench");

const SHARD_COUNT = 2;
const QUEUE = "task/bench-task";
const KEY_PREFIX = "runqueue:bench:";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 100_000,
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
  masterQueueConsumersDisabled: true,
};

const env = {
  id: "e-bench",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 100_000,
  concurrencyLimitBurstFactor: new Decimal(1.0),
  project: { id: "p-bench" },
  organization: { id: "o-bench" },
};

function createQueue(redisContainer: any, reconcile: RunQueueOptions["reconcile"]) {
  return new RunQueue({
    ...testOptions,
    shardCount: SHARD_COUNT,
    totalConcurrencyEnabled: true,
    reconcile,
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: {
        keyPrefix: KEY_PREFIX,
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      keys: testOptions.keys,
    }),
    redis: {
      keyPrefix: KEY_PREFIX,
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    },
  });
}

function makeMessage(overrides: Partial<InputPayload> = {}): InputPayload {
  return {
    runId: "r0",
    taskIdentifier: QUEUE,
    orgId: env.organization.id,
    projectId: env.project.id,
    environmentId: env.id,
    environmentType: env.type,
    queue: QUEUE,
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

function summarize(durations: number[]) {
  const sorted = [...durations].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    mean: round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)),
  };
}

/**
 * MEMBERS legitimate holders in the group set, each with a payload naming its home
 * queue and a matching home-set membership, plus one queued run held at the cap.
 */
async function seedSaturatedGroup(queue: RunQueue) {
  const keys = testOptions.keys;
  const homeKey = keys.queueCurrentConcurrencyKey(env, QUEUE);
  const groupKey = keys.queueGroupConcurrencyKey(env, QUEUE);
  const queueKey = keys.queueKey(env, QUEUE);

  await queue.updateQueueConcurrencyLimits(env, QUEUE, MEMBERS + 10);
  await queue.updateQueueTotalConcurrencyLimits(env, QUEUE, MEMBERS);

  const batch = 500;
  for (let start = 0; start < MEMBERS; start += batch) {
    const ids = Array.from(
      { length: Math.min(batch, MEMBERS - start) },
      (_, i) => `m-${start + i}`
    );
    const pipeline = queue.redis.pipeline();
    for (const id of ids) {
      const payload = JSON.stringify(
        makeMessage({ runId: id, queue: queueKey, timestamp: Date.now() - 60_000 })
      );
      pipeline.set(keys.messageKey(env.organization.id, id), payload);
    }
    pipeline.sadd(homeKey, ...ids);
    pipeline.sadd(groupKey, ...ids);
    await pipeline.exec();
  }

  await queue.enqueueMessage({
    env,
    message: makeMessage({ runId: "r0", timestamp: Date.now() - 1000 }),
    workerQueue: "main",
  });

  return { groupKey };
}

async function measure(queue: RunQueue, groupKey: string, iterations: number): Promise<number[]> {
  const shard = testOptions.keys.masterQueueShardForEnvironment(env.id, SHARD_COUNT);
  const durations: number[] = [];
  for (let i = 0; i < iterations; i++) {
    await queue.redis.del(`${groupKey}:reconcileLock`);
    const startedAt = performance.now();
    const admitted = await queue.testDequeueFromMasterQueue(shard, env.id, 10);
    durations.push(performance.now() - startedAt);
    if (admitted.length > 0) {
      throw new Error("benchmark invariant broken: a saturated dequeue admitted a run");
    }
  }
  return durations;
}

describe("run-queue reconcile latency benchmark", () => {
  redisTest("saturated dequeue with and without reconcile", async ({ redisContainer }) => {
    const seedQueue = createQueue(redisContainer, { enabled: false });
    let groupKey: string;
    try {
      const seedStartedAt = performance.now();
      ({ groupKey } = await seedSaturatedGroup(seedQueue));
      console.log(
        `seeded ${MEMBERS} legitimate group members in ${Math.round(performance.now() - seedStartedAt)}ms`
      );
      expect(await seedQueue.redis.scard(groupKey)).toBe(MEMBERS);
    } finally {
      await seedQueue.quit();
    }

    const results: Array<Record<string, number | string>> = [];

    const disabledQueue = createQueue(redisContainer, { enabled: false });
    let floor: ReturnType<typeof summarize>;
    try {
      await measure(disabledQueue, groupKey, 20);
      floor = summarize(await measure(disabledQueue, groupKey, ITERATIONS));
      results.push({ variant: "reconcile disabled", scanCount: 0, ...floor, deltaP50: 0 });
    } finally {
      await disabledQueue.quit();
    }

    for (const scanCount of SCAN_COUNTS) {
      const queue = createQueue(redisContainer, {
        enabled: true,
        scanCount,
        lockTtlSeconds: 10,
        maxPassesPerDequeue: 1,
      });
      try {
        await measure(queue, groupKey, 20);
        const stats = summarize(await measure(queue, groupKey, ITERATIONS));
        const deltaP50 = Math.round((stats.p50 - floor.p50) * 1000) / 1000;
        results.push({
          variant: "reconcile enabled",
          scanCount,
          ...stats,
          deltaP50,
          perMemberUs: Math.round((deltaP50 / scanCount) * 1000),
        });
        expect(await queue.redis.scard(groupKey)).toBe(MEMBERS);
      } finally {
        await queue.quit();
      }
    }

    const summary = { members: MEMBERS, iterations: ITERATIONS, results };
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "run-queue-reconcile.json");
    await writeFile(outPath, JSON.stringify(summary, null, 2));
    console.table(results);
    console.log(`wrote ${outPath}`);
  });
});
