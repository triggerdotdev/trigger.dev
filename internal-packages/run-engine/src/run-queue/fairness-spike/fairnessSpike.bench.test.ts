import { redisTest } from "@internal/testcontainers";
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { describe } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { RunQueueSelectionStrategy } from "../types.js";
import { runScenario } from "./harness/driver.js";
import { buildWorkload, weightsOf, type WorkloadConfig } from "./harness/workload.js";
import { SCENARIOS } from "./harness/scenarios.js";
import { SfqStrategy } from "./strategies/sfqStrategy.js";
import { DrrStrategy } from "./strategies/drrStrategy.js";
import { StrideStrategy } from "./strategies/strideStrategy.js";
import { CodelWrapper } from "./strategies/codelWrapper.js";
import type { GroupMetrics, RunMetrics } from "./harness/metrics.js";
import type { SpikeSelectionStrategy } from "./types.js";

const keys = new RunQueueFullKeyProducer();
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");
const SEEDS = ["seed-a", "seed-b", "seed-c"];

const SELECTOR_NAMES = ["baseline", "sfq", "drr", "stride", "codel-sfq", "codel-baseline"] as const;
type SelectorName = (typeof SELECTOR_NAMES)[number];

type Built = {
  strategy: RunQueueSelectionStrategy & Partial<SpikeSelectionStrategy>;
  cleanup: () => Promise<void>;
};

function makeBaseline(redis: RedisOptions): FairQueueSelectionStrategy {
  return new FairQueueSelectionStrategy({
    redis,
    keys,
    seed: "spike",
    biases: { concurrencyLimitBias: 0.75, availableCapacityBias: 0.3, queueAgeRandomization: 0.25 },
  });
}

/** Presents a bare RunQueueSelectionStrategy as a SpikeSelectionStrategy so it can be wrapped. */
function asSpike(name: string, base: RunQueueSelectionStrategy): SpikeSelectionStrategy {
  return {
    name,
    distributeFairQueuesFromParentQueue: (p, c) => base.distributeFairQueuesFromParentQueue(p, c),
    onServiced() {},
  };
}

function buildSelector(name: SelectorName, redis: RedisOptions, weight: (g: string) => number): Built {
  if (name === "baseline") {
    return { strategy: makeBaseline(redis), cleanup: async () => {} };
  }

  const client = createRedisClient(redis);
  const cleanup = async () => {
    await client.quit();
  };

  switch (name) {
    case "sfq":
      return { strategy: new SfqStrategy({ redis: client, keys, weight }), cleanup };
    case "drr":
      return { strategy: new DrrStrategy({ redis: client, keys, weight }), cleanup };
    case "stride":
      return { strategy: new StrideStrategy({ redis: client, keys, weight }), cleanup };
    case "codel-sfq":
      return {
        strategy: new CodelWrapper({
          base: new SfqStrategy({ redis: client, keys, weight }),
          redis: client,
          keys,
          targetMs: 200,
          intervalMs: 100,
        }),
        cleanup,
      };
    case "codel-baseline":
      return {
        strategy: new CodelWrapper({
          base: asSpike("baseline", makeBaseline(redis)),
          redis: client,
          keys,
          targetMs: 200,
          intervalMs: 100,
        }),
        cleanup,
      };
  }
}

function stats(xs: number[]) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, min: Math.min(...xs), max: Math.max(...xs) };
}

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

type SeedRun = { seed: string; metrics: RunMetrics };

describe("fairness spike bench", () => {
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (const [scenarioName, baseConfig] of Object.entries(SCENARIOS)) {
    redisTest(
      `scenario: ${scenarioName}`,
      async ({ redisContainer }) => {
        const runsBySelector = new Map<SelectorName, SeedRun[]>();
        for (const name of SELECTOR_NAMES) runsBySelector.set(name, []);

        for (const seed of SEEDS) {
          const config: WorkloadConfig = { ...baseConfig, seed };
          const workload = buildWorkload(config);
          const expectedTotal = workload.tenants.reduce((n, t) => n + t.runCount, 0);
          const weights = weightsOf(workload);
          const weight = (g: string) => weights[g] ?? 1;

          for (const name of SELECTOR_NAMES) {
            const redis: RedisOptions = {
              keyPrefix: `rq:spike:${scenarioName}:${name}:${seed}:`,
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            };
            const built = buildSelector(name, redis, weight);
            try {
              const metrics = await runScenario({ redis, strategy: built.strategy, workload });
              if (metrics.totalDequeued !== expectedTotal) {
                throw new Error(
                  `${scenarioName}/${name}/${seed}: dequeued ${metrics.totalDequeued} of ${expectedTotal}`
                );
              }
              runsBySelector.get(name)!.push({ seed, metrics });
            } finally {
              await built.cleanup();
            }
          }
        }

        // Aggregate across seeds; keep full per-tenant detail for the first seed.
        const perSelector = SELECTOR_NAMES.map((name) => {
          const runs = runsBySelector.get(name)!;
          const cwsw = stats(runs.map((r) => r.metrics.contentionWorstShareOverWeight));
          const jain = stats(runs.map((r) => r.metrics.contentionJain));
          const lightWaitP99 = stats(runs.map((r) => r.metrics.worstWaitP99));
          return {
            selector: name,
            contentionWorstShareOverWeight: cwsw,
            contentionJain: jain,
            worstWaitP99: lightWaitP99,
            detailSeed0: runs[0].metrics.perGroup as GroupMetrics[],
          };
        });

        const firstWorkload = buildWorkload({ ...baseConfig, seed: SEEDS[0] });
        writeFileSync(
          join(RESULTS_DIR, `${scenarioName}.json`),
          JSON.stringify(
            { scenario: scenarioName, seeds: SEEDS, weights: weightsOf(firstWorkload), perSelector },
            null,
            2
          )
        );

        const lines = [
          ``,
          `### ${scenarioName}  (${SEEDS.length} seeds)`,
          `selector        contWorstS/W  (min..max)        contJain  worstWaitP99(mean)`,
          ...perSelector.map((r) => {
            const c = r.contentionWorstShareOverWeight;
            return `${r.selector.padEnd(15)} ${fmt(c.mean).padStart(7)}  (${fmt(c.min)}..${fmt(
              c.max
            )})  ${fmt(r.contentionJain.mean).padStart(6)}  ${fmt(r.worstWaitP99.mean, 0).padStart(8)}`;
          }),
          ``,
        ];
        process.stdout.write(lines.join("\n") + "\n");
      },
      400_000
    );
  }
});
