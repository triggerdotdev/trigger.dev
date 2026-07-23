import { redisTest } from "@internal/testcontainers";
import { describe } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRedisClient } from "@internal/redis";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { runScenario } from "../fairness-spike/harness/driver.js";
import { SfqStrategy } from "../fairness-spike/strategies/sfqStrategy.js";
import { GROUP_SEPARATOR } from "../fairness-spike/types.js";
import {
  buildWorkload,
  weightsOf,
  type WorkloadConfig,
} from "../fairness-spike/harness/workload.js";
import type { RunMetrics, GroupMetrics } from "../fairness-spike/harness/metrics.js";

/**
 * The total cap's REAL job: cross-TASK isolation. Two keyless tasks (base queues)
 * share one env; a heavy task floods it and starves a light task. This is the
 * problem #2617's total cap is for, and it is a DIFFERENT problem from the
 * cross-KEY starvation the caps bench showed the total cap does not fix.
 *
 * The total cap on the heavy task is the real per-queue concurrency gate
 * (updateQueueConcurrencyLimits); for a keyless task the per-queue limit is the
 * per-task total (one base queue, no ck variants to sum), so this is faithful.
 * Compared against the production FairQueueSelectionStrategy (baseline) and the
 * spike SFQ selector, both driving the real RunQueue + testDequeueFromMasterQueue.
 */

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");
const SEEDS = ["seed-a", "seed-b", "seed-c"];
const ENV_LIMIT = 4;
const HEAVY_TOTAL_CAP = 2;

const keys = new RunQueueFullKeyProducer();
const q = (tenant: string) => `${tenant}${GROUP_SEPARATOR}0`;

type CrossScenario = {
  config: Omit<WorkloadConfig, "seed">;
  heavy: string;
  lightKey: string;
};

const SCENARIOS: Record<string, CrossScenario> = {
  // heavy task floods, two light tasks trickle in. All keyless (queueCount 1).
  crossTaskSkew: {
    heavy: "heavy",
    lightKey: "light-1",
    config: {
      envConcurrencyLimit: ENV_LIMIT,
      tenants: [
        { tenantId: "heavy", runCount: 240, holdMsMean: 25 },
        { tenantId: "light-1", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
        { tenantId: "light-2", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
      ],
    },
  },
};

type RedisOpts = { keyPrefix: string; host: string; port: number };
type Treatment = {
  label: string;
  // returns the strategy and an optional client to quit afterwards. The real
  // FairQueueSelectionStrategy takes RedisOptions and owns its own client; the
  // spike SfqStrategy takes a live client.
  makeStrategy: (redis: RedisOpts) => { strategy: any; client?: ReturnType<typeof createRedisClient> };
  capHeavy?: boolean;
};

const TREATMENTS: Treatment[] = [
  {
    label: "baseline(fairqueue)",
    makeStrategy: (redis) => ({ strategy: new FairQueueSelectionStrategy({ redis, keys }) }),
  },
  {
    label: "heavyTotalCap",
    makeStrategy: (redis) => ({ strategy: new FairQueueSelectionStrategy({ redis, keys }) }),
    capHeavy: true,
  },
  {
    label: "sfq",
    makeStrategy: (redis) => {
      const client = createRedisClient(redis);
      return { strategy: new SfqStrategy({ redis: client, keys }), client };
    },
  },
];

function stats(xs: number[]) {
  return {
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

function fmt(n: number, d = 0): string {
  return Number.isFinite(n) ? n.toFixed(d) : String(n);
}

function waitOf(metrics: RunMetrics, key: string): number {
  return metrics.perGroup.find((g) => g.groupId === key)?.meanWait ?? 0;
}

describe("cross-task total cap bench", () => {
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (const [scenarioName, scenario] of Object.entries(SCENARIOS)) {
    redisTest(
      `cross-task scenario: ${scenarioName}`,
      async ({ redisContainer }) => {
        const runs = new Map<string, Array<{ seed: string; metrics: RunMetrics }>>();

        for (const seed of SEEDS) {
          const config: WorkloadConfig = { ...scenario.config, seed };
          const workload = buildWorkload(config);
          const expectedTotal = workload.tenants.reduce((n, t) => n + t.runCount, 0);

          for (const treatment of TREATMENTS) {
            const redis = {
              keyPrefix: `rq:xtask:${scenarioName}:${treatment.label}:${seed}:`,
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            };
            const { strategy, client } = treatment.makeStrategy(redis);
            const metrics = await runScenario({
              redis,
              strategy,
              workload,
              perQueueCap: treatment.capHeavy ? { [q(scenario.heavy)]: HEAVY_TOTAL_CAP } : undefined,
            });
            await client?.quit();
            if (metrics.totalDequeued !== expectedTotal) {
              throw new Error(
                `${scenarioName}/${treatment.label}/${seed}: dequeued ${metrics.totalDequeued} of ${expectedTotal}`
              );
            }
            const arr = runs.get(treatment.label) ?? [];
            arr.push({ seed, metrics });
            runs.set(treatment.label, arr);
          }
        }

        const perTreatment = [...runs.entries()].map(([label, rs]) => ({
          treatment: label,
          lightWait: stats(rs.map((r) => waitOf(r.metrics, scenario.lightKey))),
          heavyWait: stats(rs.map((r) => waitOf(r.metrics, scenario.heavy))),
          makespan: stats(rs.map((r) => r.metrics.makespanMs)),
          contentionWorst: stats(rs.map((r) => r.metrics.contentionWorstShareOverWeight)),
          detailSeed0: rs[0].metrics.perGroup as GroupMetrics[],
        }));

        const firstWorkload = buildWorkload({ ...scenario.config, seed: SEEDS[0] });
        writeFileSync(
          join(RESULTS_DIR, `xtask-${scenarioName}.json`),
          JSON.stringify(
            {
              scenario: scenarioName,
              seeds: SEEDS,
              envLimit: ENV_LIMIT,
              heavyTotalCap: HEAVY_TOTAL_CAP,
              lightKey: scenario.lightKey,
              weights: weightsOf(firstWorkload),
              perTreatment,
            },
            null,
            2
          )
        );

        const lines = [
          ``,
          `### cross-task: ${scenarioName}  (${SEEDS.length} seeds, env=${ENV_LIMIT}, heavyTotalCap=${HEAVY_TOTAL_CAP}, light=${scenario.lightKey})`,
          `treatment            lightWait   heavyWait   makespan   contWorstS/W`,
          ...perTreatment.map(
            (r) =>
              `${r.treatment.padEnd(19)} ${fmt(r.lightWait.mean).padStart(8)}   ${fmt(
                r.heavyWait.mean
              ).padStart(8)}   ${fmt(r.makespan.mean).padStart(7)}   ${fmt(
                r.contentionWorst.mean,
                3
              ).padStart(7)}`
          ),
          ``,
        ];
        process.stdout.write(lines.join("\n") + "\n");
      },
      300_000
    );
  }
});
