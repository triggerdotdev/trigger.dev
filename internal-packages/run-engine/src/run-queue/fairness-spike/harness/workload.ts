import seedrandom from "seedrandom";
import { GROUP_SEPARATOR, type GroupId } from "../types.js";

/**
 * Seeded synthetic workload generator. Everything is derived from `seed`, so
 * the same config produces byte-identical events across runs and across
 * selectors. Hold durations are precomputed per run (not sampled live) so every
 * selector holds a given run for exactly the same time.
 *
 * A "tenant" is the fairness group. A tenant owns `queueCount` distinct base
 * queues (named `${tenantId}~${index}`) and its runs are spread round-robin
 * across them. A heavy tenant with many queues is how the spike reproduces the
 * #2617 starvation dynamic at the base-queue grain.
 */

export type ArrivalMode = "immediate" | "poisson";

export type TenantConfig = {
  tenantId: string;
  runCount: number;
  weight?: number;
  queueCount?: number;
  arrival?: ArrivalMode;
  ratePerSec?: number;
  holdMsMean?: number;
  startAtMs?: number;
};

export type WorkloadConfig = {
  seed: string;
  envConcurrencyLimit: number;
  tenants: TenantConfig[];
};

export type EnqueueEvent = {
  groupId: GroupId;
  queueName: string;
  runId: string;
  enqueueAtMs: number;
  holdMs: number;
};

export type TenantSpec = {
  tenantId: GroupId;
  runCount: number;
  weight: number;
  queueCount: number;
  events: EnqueueEvent[];
};

export type WorkloadSpec = {
  seed: string;
  envConcurrencyLimit: number;
  tenants: TenantSpec[];
};

function expSample(rng: seedrandom.PRNG, meanMs: number): number {
  return Math.max(1, Math.round(-Math.log(1 - rng()) * meanMs));
}

export function buildWorkload(config: WorkloadConfig): WorkloadSpec {
  const rng = seedrandom(config.seed);

  const tenants: TenantSpec[] = config.tenants.map((t) => {
    const weight = t.weight ?? 1;
    const queueCount = t.queueCount ?? 1;
    const arrival = t.arrival ?? "immediate";
    const holdMsMean = t.holdMsMean ?? 50;
    const startAtMs = t.startAtMs ?? 0;
    const ratePerSec = t.ratePerSec ?? 100;

    const events: EnqueueEvent[] = [];
    let cursor = startAtMs;

    for (let i = 0; i < t.runCount; i++) {
      if (arrival === "poisson" && i > 0) {
        cursor += expSample(rng, 1000 / ratePerSec);
      }
      const holdMs = expSample(rng, holdMsMean);
      const qi = i % queueCount;
      events.push({
        groupId: t.tenantId,
        queueName: `${t.tenantId}${GROUP_SEPARATOR}${qi}`,
        runId: `${t.tenantId}${GROUP_SEPARATOR}${qi}#${i}`,
        enqueueAtMs: arrival === "immediate" ? startAtMs : cursor,
        holdMs,
      });
    }

    return { tenantId: t.tenantId, runCount: t.runCount, weight, queueCount, events };
  });

  return { seed: config.seed, envConcurrencyLimit: config.envConcurrencyLimit, tenants };
}

export function expandEvents(spec: WorkloadSpec): EnqueueEvent[] {
  const all = spec.tenants.flatMap((t) => t.events);
  return all.sort(
    (a, b) =>
      a.enqueueAtMs - b.enqueueAtMs ||
      (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0) ||
      (a.runId < b.runId ? -1 : 1)
  );
}

export function weightsOf(spec: WorkloadSpec): Record<GroupId, number> {
  return Object.fromEntries(spec.tenants.map((t) => [t.tenantId, t.weight]));
}
