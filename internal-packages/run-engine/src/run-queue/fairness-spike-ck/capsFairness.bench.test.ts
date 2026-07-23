import { redisTest } from "@internal/testcontainers";
import type { RedisOptions } from "@internal/redis";
import { describe } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCkScenario } from "./harness/ckDriver.js";
import {
  buildWorkload,
  weightsOf,
  type WorkloadConfig,
} from "../fairness-spike/harness/workload.js";
import type { RunMetrics, GroupMetrics } from "../fairness-spike/harness/metrics.js";
import { BaselineCk, SfqCk, DrrCk, type CkDiscipline } from "./disciplines.js";

/**
 * Caps vs scheduling. Runs the plan-of-record's concurrency CAPS (Phase-2 per-key
 * limit via the real per-queue concurrency gate, Phase-1 total cap via a
 * driver-side group gate) head-to-head against the scheduling disciplines
 * (SFQ/DRR) on identical scenarios, through the real CK-dequeue Lua at
 * maxCount = 1.
 *
 * A "treatment" is (order discipline, per-key cap?, total cap?). Caps are
 * admission settings, not disciplines: the per-key cap is the real Lua's native
 * per-variant gate (oldest-eligible-first, true age order), the total cap is the
 * driver refusing to admit past the group ceiling.
 *
 * Headline = the light (starved) key's wait. makespan = work-conservation signal.
 * contention share = directional.
 */

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");
const SEEDS = ["seed-a", "seed-b", "seed-c"];
const ENV_LIMIT = 4;
const PER_KEY_CAP = 2; // heavy key(s) bound to half the env
const TOTAL_CAP = 2; // per-task total ceiling, below env

type Treatment = {
  label: string;
  makeDiscipline: () => CkDiscipline;
  perKeyCap?: number;
  totalCap?: number;
};

const TREATMENTS: Treatment[] = [
  { label: "baseline", makeDiscipline: () => new BaselineCk() },
  { label: "perKeyCap", makeDiscipline: () => new BaselineCk(), perKeyCap: PER_KEY_CAP },
  { label: "totalCap", makeDiscipline: () => new BaselineCk(), totalCap: TOTAL_CAP },
  // the plan-of-record's shipped combined config: total cap AND per-key cap
  { label: "total+perKey", makeDiscipline: () => new BaselineCk(), perKeyCap: PER_KEY_CAP, totalCap: TOTAL_CAP },
  { label: "sfq", makeDiscipline: () => new SfqCk() },
  { label: "drr", makeDiscipline: () => new DrrCk() },
  { label: "perKeyCap+sfq", makeDiscipline: () => new SfqCk(), perKeyCap: PER_KEY_CAP },
  // both caps plus a fair order (the fully-layered end state)
  { label: "total+perKey+sfq", makeDiscipline: () => new SfqCk(), perKeyCap: PER_KEY_CAP, totalCap: TOTAL_CAP },
];

type CapScenario = {
  config: Omit<WorkloadConfig, "seed">;
  /** the key whose wait is the headline (a starved light key, or the heavy key for heavy-idle) */
  lightKey: string;
};

function sybilHeavy(count: number, runsEach: number) {
  return Array.from({ length: count }, (_, i) => ({
    tenantId: `heavy-${i}`,
    runCount: runsEach,
    holdMsMean: 25,
  }));
}

const SCENARIOS: Record<string, CapScenario> = {
  // one heavy key floods (old head), four light keys trickle in later. One heavy
  // key => a per-key cap frees slots the light keys can take.
  ckSkew: {
    lightKey: "light-1",
    config: {
      envConcurrencyLimit: ENV_LIMIT,
      tenants: [
        { tenantId: "heavy", runCount: 240, holdMsMean: 25 },
        { tenantId: "light-1", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
        { tenantId: "light-2", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
        { tenantId: "light-3", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
        { tenantId: "light-4", runCount: 15, arrival: "poisson", ratePerSec: 10, holdMsMean: 25 },
      ],
    },
  },

  // a bulk backlog plus two keys trickling in slowly
  ckTrickle: {
    lightKey: "trickle-1",
    config: {
      envConcurrencyLimit: ENV_LIMIT,
      tenants: [
        { tenantId: "bulk", runCount: 240, holdMsMean: 25 },
        { tenantId: "trickle-1", runCount: 30, arrival: "poisson", ratePerSec: 25, holdMsMean: 25 },
        { tenantId: "trickle-2", runCount: 30, arrival: "poisson", ratePerSec: 25, holdMsMean: 25 },
      ],
    },
  },

  // sybil split: one attacker spreads its backlog across 20 concurrency keys, each
  // with a backlog that stays non-empty through the light key's whole arrival
  // window. Each attacker key is under the same per-key cap, but the cap frees no
  // aggregate slot (attacker keys fill env, and as one empties the next attacker
  // key's old head is served before the newer light key). The real CK Lua also
  // only scans the 3 oldest-scored variants per call (ZRANGEBYSCORE ... LIMIT 0,
  // maxCount*3), so with 20 attacker heads ahead of it the light head is never in
  // the window. Only a fair order rescues the light key.
  ckSybil: {
    lightKey: "light",
    config: {
      envConcurrencyLimit: ENV_LIMIT,
      tenants: [
        ...sybilHeavy(20, 15),
        { tenantId: "light", runCount: 20, arrival: "poisson", ratePerSec: 40, holdMsMean: 25 },
      ],
    },
  },

  // work-conservation: one heavy key alone with a big backlog. A per-key or total
  // cap throttles it below the env limit and idles slots, inflating makespan; a
  // scheduler uses the whole env. Headline here is makespan, not wait.
  ckHeavyIdle: {
    lightKey: "heavy",
    config: {
      envConcurrencyLimit: ENV_LIMIT,
      tenants: [{ tenantId: "heavy", runCount: 200, holdMsMean: 25 }],
    },
  },
};

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

function worstWaitOf(metrics: RunMetrics): number {
  return metrics.perGroup.length ? Math.max(...metrics.perGroup.map((g) => g.meanWait)) : 0;
}

describe("caps vs scheduling bench", () => {
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (const [scenarioName, scenario] of Object.entries(SCENARIOS)) {
    redisTest(
      `caps scenario: ${scenarioName}`,
      async ({ redisContainer }) => {
        const runs = new Map<string, Array<{ seed: string; metrics: RunMetrics }>>();

        for (const seed of SEEDS) {
          const config: WorkloadConfig = { ...scenario.config, seed };
          const workload = buildWorkload(config);
          const expectedTotal = workload.tenants.reduce((n, t) => n + t.runCount, 0);

          for (const treatment of TREATMENTS) {
            const redis: RedisOptions = {
              keyPrefix: `rq:caps:${scenarioName}:${treatment.label}:${seed}:`,
              host: redisContainer.getHost(),
              port: redisContainer.getPort(),
            };
            const metrics = await runCkScenario({
              redis,
              discipline: treatment.makeDiscipline(),
              workload,
              perKeyCap: treatment.perKeyCap,
              totalCap: treatment.totalCap,
            });
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
          worstWait: stats(rs.map((r) => worstWaitOf(r.metrics))),
          makespan: stats(rs.map((r) => r.metrics.makespanMs)),
          contentionWorst: stats(rs.map((r) => r.metrics.contentionWorstShareOverWeight)),
          detailSeed0: rs[0].metrics.perGroup as GroupMetrics[],
        }));

        const firstWorkload = buildWorkload({ ...scenario.config, seed: SEEDS[0] });
        writeFileSync(
          join(RESULTS_DIR, `caps-${scenarioName}.json`),
          JSON.stringify(
            {
              scenario: scenarioName,
              seeds: SEEDS,
              envLimit: ENV_LIMIT,
              perKeyCap: PER_KEY_CAP,
              totalCap: TOTAL_CAP,
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
          `### caps: ${scenarioName}  (${SEEDS.length} seeds, env=${ENV_LIMIT}, perKeyCap=${PER_KEY_CAP}, totalCap=${TOTAL_CAP}, light=${scenario.lightKey})`,
          `treatment         lightWait   worstWait   makespan   contWorstS/W`,
          ...perTreatment.map(
            (r) =>
              `${r.treatment.padEnd(16)} ${fmt(r.lightWait.mean).padStart(8)}   ${fmt(
                r.worstWait.mean
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
