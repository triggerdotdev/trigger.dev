import type { GroupId } from "../types.js";

export type DequeueEvent = {
  groupId: GroupId;
  runId: string;
  enqueueAtMs: number;
  dequeueAtMs: number;
};

export type GroupMetrics = {
  groupId: GroupId;
  dequeued: number;
  weight: number;
  share: number;
  shareOverWeight: number;
  waitP50: number;
  waitP99: number;
  waitMax: number;
};

export type RunMetrics = {
  perGroup: GroupMetrics[];
  jainIndex: number;
  worstShareOverWeight: number;
  totalDequeued: number;
  redisOps: number;
  wallClockMs: number;
};

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

/**
 * Jain's fairness index over a vector: (Σx)² / (n·Σx²). 1.0 = perfectly fair.
 */
function jain(values: number[]): number {
  if (values.length === 0) return 1;
  const sum = values.reduce((a, b) => a + b, 0);
  const sumSq = values.reduce((a, b) => a + b * b, 0);
  if (sumSq === 0) return 1;
  return (sum * sum) / (values.length * sumSq);
}

export function computeMetrics(input: {
  events: DequeueEvent[];
  weights: Record<GroupId, number>;
  redisOps: number;
  wallClockMs: number;
}): RunMetrics {
  const { events, weights } = input;
  const groupIds = Object.keys(weights);
  const total = events.length;
  const sumWeights = groupIds.reduce((a, g) => a + (weights[g] ?? 1), 0);

  const byGroup = new Map<GroupId, number[]>();
  for (const g of groupIds) byGroup.set(g, []);
  for (const e of events) {
    const arr = byGroup.get(e.groupId) ?? [];
    arr.push(e.dequeueAtMs - e.enqueueAtMs);
    byGroup.set(e.groupId, arr);
  }

  const perGroup: GroupMetrics[] = groupIds.map((g) => {
    const waits = (byGroup.get(g) ?? []).slice().sort((a, b) => a - b);
    const dequeued = waits.length;
    const weight = weights[g] ?? 1;
    const share = total > 0 ? dequeued / total : 0;
    const expectedShare = weight / sumWeights;
    const shareOverWeight = expectedShare > 0 ? share / expectedShare : 0;
    return {
      groupId: g,
      dequeued,
      weight,
      share,
      shareOverWeight,
      waitP50: percentile(waits, 50),
      waitP99: percentile(waits, 99),
      waitMax: waits.length ? waits[waits.length - 1] : 0,
    };
  });

  const shareOverWeightVec = perGroup.map((p) => p.shareOverWeight);

  return {
    perGroup,
    jainIndex: jain(shareOverWeightVec),
    worstShareOverWeight: shareOverWeightVec.length ? Math.min(...shareOverWeightVec) : 0,
    totalDequeued: total,
    redisOps: input.redisOps,
    wallClockMs: input.wallClockMs,
  };
}
