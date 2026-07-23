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
  /** share of total dequeues (fixed by the workload; sanity only) */
  share: number;
  /** share of dequeues during the contention window, over expected weighted share */
  contentionShareOverWeight: number;
  meanWait: number;
  waitP50: number;
  waitP99: number;
  waitMax: number;
};

export type RunMetrics = {
  perGroup: GroupMetrics[];
  totalDequeued: number;
  redisOps: number;
  wallClockMs: number;
  /**
   * Fairness during contention: the least-served group's share of the
   * contention window, over its expected weighted share. 1.0 = perfectly fair,
   * →0 = that group was starved while others had work.
   */
  contentionWorstShareOverWeight: number;
  contentionJain: number;
  /** anti-staleness tail: the largest per-group p99 wait */
  worstWaitP99: number;
  worstWaitMax: number;
};

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function jain(values: number[]): number {
  if (values.length === 0) return 1;
  const sum = values.reduce((a, b) => a + b, 0);
  const sumSq = values.reduce((a, b) => a + b * b, 0);
  if (sumSq === 0) return 1;
  return (sum * sum) / (values.length * sumSq);
}

/**
 * Counts each group's dequeues that fall within the contention window: the
 * prefix of the dequeue timeline during which at least two groups still have
 * unfinished work. Once only one group has work left there is no contention to
 * be fair about, so those dequeues are excluded.
 */
function contentionCounts(
  events: DequeueEvent[],
  totals: Record<GroupId, number>
): { counts: Map<GroupId, number>; windowSize: number; contended: Set<GroupId> } {
  const ordered = [...events].sort((a, b) => a.dequeueAtMs - b.dequeueAtMs);
  const remaining = new Map<GroupId, number>(Object.entries(totals));
  const counts = new Map<GroupId, number>();
  const contended = new Set<GroupId>();
  let windowSize = 0;

  for (const e of ordered) {
    const withWork = [...remaining.entries()].filter(([, n]) => n > 0);
    if (withWork.length < 2) break;
    // Every group that still has work during this step is contending, whether
    // or not it is the one being served (so a starved group counts as share 0).
    for (const [g] of withWork) contended.add(g);
    counts.set(e.groupId, (counts.get(e.groupId) ?? 0) + 1);
    windowSize++;
    remaining.set(e.groupId, (remaining.get(e.groupId) ?? 0) - 1);
  }

  return { counts, windowSize, contended };
}

export function computeMetrics(input: {
  events: DequeueEvent[];
  weights: Record<GroupId, number>;
  totals: Record<GroupId, number>;
  redisOps: number;
  wallClockMs: number;
}): RunMetrics {
  const { events, weights, totals } = input;
  const groupIds = Object.keys(weights);
  const total = events.length;
  const sumWeights = groupIds.reduce((a, g) => a + (weights[g] ?? 1), 0);

  const { counts: windowCounts, windowSize, contended } = contentionCounts(events, totals);
  const sumWindowWeights = [...contended].reduce((a, g) => a + (weights[g] ?? 1), 0);

  const waitsByGroup = new Map<GroupId, number[]>();
  for (const g of groupIds) waitsByGroup.set(g, []);
  for (const e of events) {
    waitsByGroup.get(e.groupId)?.push(e.dequeueAtMs - e.enqueueAtMs);
  }

  const perGroup: GroupMetrics[] = groupIds.map((g) => {
    const waits = (waitsByGroup.get(g) ?? []).slice().sort((a, b) => a - b);
    const dequeued = waits.length;
    const weight = weights[g] ?? 1;
    const share = total > 0 ? dequeued / total : 0;

    const windowShare = windowSize > 0 ? (windowCounts.get(g) ?? 0) / windowSize : 0;
    const expectedWindowShare = sumWindowWeights > 0 ? weight / sumWindowWeights : 0;
    const contentionShareOverWeight =
      expectedWindowShare > 0 ? windowShare / expectedWindowShare : 0;

    const meanWait = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;

    return {
      groupId: g,
      dequeued,
      weight,
      share,
      contentionShareOverWeight,
      meanWait,
      waitP50: percentile(waits, 50),
      waitP99: percentile(waits, 99),
      waitMax: waits.length ? waits[waits.length - 1] : 0,
    };
  });

  // Only groups that actually had work during the contention window count
  // toward fairness (a starved competitor contributes a 0, dragging worst down).
  const competed = perGroup.filter((p) => contended.has(p.groupId));
  const cowVec = competed.map((p) => p.contentionShareOverWeight);

  return {
    perGroup,
    totalDequeued: total,
    redisOps: input.redisOps,
    wallClockMs: input.wallClockMs,
    contentionWorstShareOverWeight: cowVec.length ? Math.min(...cowVec) : 1,
    contentionJain: jain(cowVec),
    worstWaitP99: perGroup.length ? Math.max(...perGroup.map((p) => p.waitP99)) : 0,
    worstWaitMax: perGroup.length ? Math.max(...perGroup.map((p) => p.waitMax)) : 0,
  };
}
