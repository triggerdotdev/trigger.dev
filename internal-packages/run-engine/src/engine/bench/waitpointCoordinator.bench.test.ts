/**
 * Waitpoint coordination benchmark. Reports numbers; asserts nothing — on a shared runner
 * the timings swing far more than any threshold worth gating on.
 *
 * Four groups, and only the first two are pairs:
 *
 *  1. Pending count — the store's SCARD gate against the previous path's
 *     `COUNT(*) ... WHERE status='PENDING'`, over the same population. Like for like.
 *  2. Read amplification — the store's `readBlockState` against a full-payload `SELECT`
 *     of the same waitpoints. Like for like.
 *  3. Store-only write paths — block+complete+deliver and K-watcher fan-out. Absolute
 *     numbers with NO Postgres counterpart: no single statement on the previous path
 *     corresponds to a Redis round trip that both blocks a run and delivers to watchers.
 *  4. Register cost versus edge count — `registerBlocks` registers each edge with its own
 *     round trip before the single absorb. This measures whether that serial loop is a
 *     real cost at a wide fan-in, or a non-issue, at several fan-in widths.
 *
 * Every Postgres measurement here runs against rows this file inserts. A baseline over an
 * empty table measures nothing.
 *
 * Knobs: BENCH_WP_ITERATIONS, BENCH_WP_FANIN, BENCH_WP_WATCHERS, BENCH_WP_REGISTER_WIDTHS,
 * BENCH_WP_REGISTER_SAMPLES.
 */
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import {
  WaitpointStoreCoordinator,
  type BlockEdge,
  type WaitpointRecordInput,
} from "../waitpointCoordinator/storeCoordinator.js";
import { setupAuthenticatedEnvironment } from "../tests/setup.js";

vi.setConfig({ testTimeout: 900_000 });

const ITERATIONS = Number(process.env.BENCH_WP_ITERATIONS ?? 100);
const FANIN = Number(process.env.BENCH_WP_FANIN ?? 1001);
const WATCHERS = Number(process.env.BENCH_WP_WATCHERS ?? 100);
const REGISTER_WIDTHS = (process.env.BENCH_WP_REGISTER_WIDTHS ?? "1,10,100,1001")
  .split(",")
  .map((raw) => Number(raw.trim()))
  .filter((width) => Number.isFinite(width) && width > 0);
const REGISTER_SAMPLES = Number(process.env.BENCH_WP_REGISTER_SAMPLES ?? 20);
const NOW = new Date().toISOString();

type Sample = { label: string; count: number; p50: number; p99: number; totalMs: number };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function measure(label: string, count: number, run: (i: number) => Promise<void>) {
  const durations: number[] = [];
  const started = Date.now();
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    await run(i);
    durations.push(performance.now() - t0);
  }
  durations.sort((a, b) => a - b);
  const sample: Sample = {
    label,
    count,
    p50: percentile(durations, 50),
    p99: percentile(durations, 99),
    totalMs: Date.now() - started,
  };
  console.log(
    `[bench] ${sample.label} n=${sample.count} p50=${sample.p50.toFixed(2)}ms ` +
      `p99=${sample.p99.toFixed(2)}ms total=${sample.totalMs}ms`
  );
  return sample;
}

function record(id: string, environmentId: string, projectId: string): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    environmentId,
    projectId,
    createdAt: NOW,
    updatedAt: NOW,
    userProvidedIdempotencyKey: false,
    tags: [],
  };
}

const completion = {
  completedAt: NOW,
  outputType: "application/json",
  outputIsError: false,
  output: { inline: '{"ok":true}' },
};

function edge(waitpointId: string, batchIndex?: number): BlockEdge {
  return { waitpointId, batchIndex, createdAt: NOW, type: "MANUAL" };
}

async function insertWaitpoints(
  prisma: PrismaClient,
  ids: string[],
  environmentId: string,
  projectId: string
) {
  await prisma.waitpoint.createMany({
    data: ids.map((id) => ({
      id,
      friendlyId: `waitpoint_${id}`,
      type: "MANUAL" as const,
      idempotencyKey: id,
      userProvidedIdempotencyKey: false,
      projectId,
      environmentId,
    })),
  });
}

containerTest(
  "waitpoint coordination: pending count, read amplification, store write paths, register cost",
  async ({ prisma, redisOptions }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const store = new WaitpointStoreCoordinator({ redisOptions });
    const samples: Sample[] = [];
    const registerCost: Array<{ width: number; p50Ms: number; p99Ms: number; perEdgeMsP50: number }> =
      [];

    try {
      const ids = Array.from({ length: FANIN }, (_, i) => `bench_w_${i}`);

      // Both stores get the SAME population. A Postgres baseline over an empty table
      // measures an index probe against nothing.
      await insertWaitpoints(prisma, ids, env.id, env.project.id);
      for (const id of ids) {
        await store.createIfAbsent({ record: record(id, env.id, env.project.id), status: "PENDING" });
      }
      await store.registerBlocks({
        runId: "bench_run_fanin",
        edges: ids.map((id, index) => edge(id, index)),
      });

      // --- group 1: the pending-count gate, like for like ---
      samples.push(
        await measure("store.pendingCount", ITERATIONS, async () => {
          await store.absorbBlockers({ runId: "bench_run_fanin", edges: [] });
        })
      );
      samples.push(
        await measure("postgres.pendingCount", ITERATIONS, async () => {
          await prisma.$queryRaw`SELECT COUNT(*) FROM "Waitpoint" WHERE id = ANY(${ids}::text[]) AND status = 'PENDING'`;
        })
      );

      // --- group 2: read amplification, like for like ---
      samples.push(
        await measure("store.readBlockState", ITERATIONS, async () => {
          await store.readBlockState("bench_run_fanin");
        })
      );
      samples.push(
        await measure("postgres.hydrateFullPayload", ITERATIONS, async () => {
          // Every column of every waitpoint — the amplification the store removes.
          await prisma.waitpoint.findMany({ where: { id: { in: ids } } });
        })
      );

      // --- group 3: store-only write paths, no Postgres counterpart ---
      samples.push(
        await measure("store.block+complete+deliver", ITERATIONS, async (i) => {
          const id = `bench_cycle_${i}`;
          await store.createIfAbsent({
            record: record(id, env.id, env.project.id),
            status: "PENDING",
          });
          await store.registerBlocks({ runId: `bench_run_${i}`, edges: [edge(id)] });
          const done = await store.complete({ waitpointId: id, completion });
          for (const watcher of done.watchers) {
            await store.deliverCompletion({
              runId: watcher.runId,
              waitpointId: id,
              completion: done.completion!,
            });
          }
        })
      );

      const fanOutId = "bench_fanout_w";
      await store.createIfAbsent({
        record: record(fanOutId, env.id, env.project.id),
        status: "PENDING",
      });
      for (let i = 0; i < WATCHERS; i++) {
        await store.registerBlocks({ runId: `bench_watcher_${i}`, edges: [edge(fanOutId)] });
      }
      samples.push(
        await measure(`store.complete+deliver(watchers=${WATCHERS})`, 1, async () => {
          const done = await store.complete({ waitpointId: fanOutId, completion });
          // Serial on purpose: this is the worst case, and it is the number that says
          // whether delivery needs to pipeline.
          for (const watcher of done.watchers) {
            await store.deliverCompletion({
              runId: watcher.runId,
              waitpointId: fanOutId,
              completion: done.completion!,
            });
          }
        })
      );

      // --- group 4: register cost versus edge count ---
      // registerBlocks registers each edge with its own round trip, serially, before the
      // single absorb. A review flagged that a wide fan-in therefore serializes one round
      // trip per edge. This measures the real cost at several widths rather than predicting
      // it, so the decision about bounded concurrency is made against a number.
      const registerPoolWidth = Math.max(0, ...REGISTER_WIDTHS);
      const registerIds = Array.from({ length: registerPoolWidth }, (_, i) => `bench_reg_w_${i}`);
      await insertWaitpoints(prisma, registerIds, env.id, env.project.id);
      for (const id of registerIds) {
        await store.createIfAbsent({
          record: record(id, env.id, env.project.id),
          status: "PENDING",
        });
      }

      for (const width of REGISTER_WIDTHS) {
        const edges = registerIds.slice(0, width).map((id, index) => edge(id, index));
        let call = 0;
        const sample = await measure(
          `store.registerBlocks(edges=${width})`,
          REGISTER_SAMPLES,
          async () => {
            await store.registerBlocks({ runId: `bench_register_${width}_${call++}`, edges });
          }
        );
        samples.push(sample);
        registerCost.push({
          width,
          p50Ms: sample.p50,
          p99Ms: sample.p99,
          perEdgeMsP50: sample.p50 / width,
        });
        console.log(
          `[bench] store.registerBlocks(edges=${width}) implied per-edge cost ` +
            `p50=${(sample.p50 / width).toFixed(3)}ms p99=${(sample.p99 / width).toFixed(3)}ms`
        );
      }

      console.log(
        `[bench] groups 1 and 2 are like-for-like pairs. Group 3 and the register-cost ` +
          `group (4) have no Postgres counterpart: no single statement on the previous ` +
          `path corresponds to a Redis round trip that blocks, completes and delivers, ` +
          `or to a serial per-edge register loop.`
      );
      console.log(`[bench] summary\n${JSON.stringify({ samples, registerCost }, null, 2)}`);
    } finally {
      await store.quit();
    }
  }
);
