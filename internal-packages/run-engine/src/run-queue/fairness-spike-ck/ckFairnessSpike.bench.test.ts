import { redisTest } from "@internal/testcontainers";
import type { RedisOptions } from "@internal/redis";
import { describe } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCkScenario } from "./harness/ckDriver.js";
import { CK_SCENARIOS } from "./harness/ckScenarios.js";
import { buildWorkload, weightsOf, type WorkloadConfig } from "../fairness-spike/harness/workload.js";
import type { RunMetrics, GroupMetrics } from "../fairness-spike/harness/metrics.js";
import { BaselineCk, SfqCk, DrrCk, StrideCk, CodelCk, type CkDiscipline } from "./disciplines.js";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");
const SEEDS = ["seed-a", "seed-b", "seed-c"];

function makeDisciplines(): CkDiscipline[] {
  return [
    new BaselineCk(),
    new SfqCk(),
    new DrrCk(),
    new StrideCk(),
    new CodelCk(new SfqCk(), 200, 100),
    new CodelCk(new BaselineCk(), 200, 100),
  ];
}

function stats(xs: number[]) {
  return {
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : String(n);
}

describe("ck fairness spike bench", () => {
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (const [scenarioName, baseConfig] of Object.entries(CK_SCENARIOS)) {
    redisTest(
      `ck scenario: ${scenarioName}`,
      async ({ redisContainer }) => {
        const runs = new Map<string, Array<{ seed: string; metrics: RunMetrics }>>();

        for (const seed of SEEDS) {
          const config: WorkloadConfig = { ...baseConfig, seed };
          const workload = buildWorkload(config);
          const expectedTotal = workload.tenants.reduce((n, t) => n + t.runCount, 0);

          for (const discipline of makeDisciplines()) {
            const redis: RedisOptions = {
              keyPrefix: `rq:ck:${scenarioName}:${discipline.name}:${seed}:`,
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            };
            const metrics = await runCkScenario({ redis, discipline, workload });
            if (metrics.totalDequeued !== expectedTotal) {
              throw new Error(
                `${scenarioName}/${discipline.name}/${seed}: dequeued ${metrics.totalDequeued} of ${expectedTotal}`
              );
            }
            const arr = runs.get(discipline.name) ?? [];
            arr.push({ seed, metrics });
            runs.set(discipline.name, arr);
          }
        }

        const perDiscipline = [...runs.entries()].map(([name, rs]) => ({
          selector: name,
          contentionWorstShareOverWeight: stats(
            rs.map((r) => r.metrics.contentionWorstShareOverWeight)
          ),
          contentionJain: stats(rs.map((r) => r.metrics.contentionJain)),
          detailSeed0: rs[0].metrics.perGroup as GroupMetrics[],
        }));

        const firstWorkload = buildWorkload({ ...baseConfig, seed: SEEDS[0] });
        writeFileSync(
          join(RESULTS_DIR, `${scenarioName}.json`),
          JSON.stringify(
            { scenario: scenarioName, seeds: SEEDS, weights: weightsOf(firstWorkload), perDiscipline },
            null,
            2
          )
        );

        const lines = [
          ``,
          `### ${scenarioName}  (${SEEDS.length} seeds)`,
          `discipline      contWorstS/W  (min..max)        contJain`,
          ...perDiscipline.map((r) => {
            const c = r.contentionWorstShareOverWeight;
            return `${r.selector.padEnd(15)} ${fmt(c.mean).padStart(7)}  (${fmt(c.min)}..${fmt(
              c.max
            )})  ${fmt(r.contentionJain.mean).padStart(6)}`;
          }),
          ``,
        ];
        process.stdout.write(lines.join("\n") + "\n");
      },
      300_000
    );
  }
});
