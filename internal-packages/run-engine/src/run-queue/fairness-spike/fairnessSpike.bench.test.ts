import { redisTest } from "@internal/testcontainers";
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { describe, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { RunQueueSelectionStrategy } from "../types.js";
import { runScenario } from "./harness/driver.js";
import { buildWorkload, weightsOf, type WorkloadSpec } from "./harness/workload.js";
import { SCENARIOS } from "./harness/scenarios.js";
import { SfqStrategy } from "./strategies/sfqStrategy.js";
import { DrrStrategy } from "./strategies/drrStrategy.js";
import { StrideStrategy } from "./strategies/strideStrategy.js";
import { CodelWrapper } from "./strategies/codelWrapper.js";
import type { RunMetrics } from "./harness/metrics.js";
import type { SpikeSelectionStrategy } from "./types.js";

const keys = new RunQueueFullKeyProducer();
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");

type Built = { strategy: RunQueueSelectionStrategy & Partial<SpikeSelectionStrategy>; cleanup: () => Promise<void> };

const SELECTOR_NAMES = ["baseline", "sfq", "drr", "stride", "codel-sfq"] as const;
type SelectorName = (typeof SELECTOR_NAMES)[number];

function buildSelector(name: SelectorName, redis: RedisOptions, workload: WorkloadSpec): Built {
  const weights = weightsOf(workload);
  const weight = (g: string) => weights[g] ?? 1;

  if (name === "baseline") {
    const s = new FairQueueSelectionStrategy({
      redis,
      keys,
      seed: "spike",
      biases: { concurrencyLimitBias: 0.75, availableCapacityBias: 0.3, queueAgeRandomization: 0.25 },
    });
    return { strategy: s, cleanup: async () => {} };
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
  }
}

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

describe("fairness spike bench", () => {
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (const [scenarioName, config] of Object.entries(SCENARIOS)) {
    redisTest(
      `scenario: ${scenarioName}`,
      async ({ redisContainer }) => {
        const workload = buildWorkload(config);
        const expectedTotal = workload.tenants.reduce((n, t) => n + t.runCount, 0);
        const rows: Array<{ selector: string } & RunMetrics> = [];

        for (const name of SELECTOR_NAMES) {
          const redis: RedisOptions = {
            keyPrefix: `rq:spike:${scenarioName}:${name}:`,
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          };
          const built = buildSelector(name, redis, workload);
          try {
            const metrics = await runScenario({ redis, strategy: built.strategy, workload });
            if (metrics.totalDequeued !== expectedTotal) {
              throw new Error(
                `${scenarioName}/${name}: dequeued ${metrics.totalDequeued} of ${expectedTotal}`
              );
            }
            rows.push({ selector: name, ...metrics });
          } finally {
            await built.cleanup();
          }
        }

        // Persist full detail for the writeup.
        writeFileSync(
          join(RESULTS_DIR, `${scenarioName}.json`),
          JSON.stringify({ scenario: scenarioName, weights: weightsOf(workload), rows }, null, 2)
        );

        // Human-readable table to stdout (bypasses console interception).
        const lines = [
          ``,
          `### ${scenarioName}`,
          `selector      contWorstS/W  contJain  worstWaitP99  worstWaitMax  rounds`,
          ...rows.map(
            (r) =>
              `${r.selector.padEnd(13)} ${fmt(r.contentionWorstShareOverWeight).padStart(11)}  ${fmt(
                r.contentionJain
              ).padStart(8)}  ${fmt(r.worstWaitP99, 0).padStart(12)}  ${fmt(
                r.worstWaitMax,
                0
              ).padStart(12)}  ${String(r.redisOps).padStart(6)}`
          ),
          ``,
        ];
        process.stdout.write(lines.join("\n") + "\n");
      },
      240_000
    );
  }
});
