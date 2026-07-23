import type { EnvQueues } from "../../types.js";
import type { ActiveQueue } from "../types.js";

/**
 * Turns a set of active queues into the `EnvQueues[]` the RunQueue expects,
 * ordering queues by a discipline-supplied comparator. Ties fall back to head
 * age (oldest first) then queue name for stable, deterministic output. Queues
 * are grouped by environment preserving the sorted order.
 */
export function buildEnvQueues(
  active: ActiveQueue[],
  compare: (a: ActiveQueue, b: ActiveQueue) => number
): EnvQueues[] {
  const sorted = [...active].sort(
    (a, b) =>
      compare(a, b) ||
      (a.headScore ?? 0) - (b.headScore ?? 0) ||
      (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0)
  );

  const byEnv = new Map<string, string[]>();
  for (const a of sorted) {
    const arr = byEnv.get(a.env.envId) ?? [];
    arr.push(a.queue);
    byEnv.set(a.env.envId, arr);
  }

  return [...byEnv.entries()].map(([envId, queues]) => ({ envId, queues }));
}
