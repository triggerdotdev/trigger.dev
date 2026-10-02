/** How many subscribers a delivery reached: its target results other than FILTERED ones and the waiter summary. */
export function routedSubscriberCount(targets: unknown): number {
  if (!Array.isArray(targets)) return 0;
  return targets.filter((target: unknown) => {
    if (target === null || typeof target !== "object") return false;
    const { type, status } = target as { type?: unknown; status?: unknown };
    return type !== "waiter" && status !== "FILTERED";
  }).length;
}

/** How many waiting runs a delivery matched, from its waiter summary target. */
export function matchedWaiterCount(targets: unknown): number {
  if (!Array.isArray(targets)) return 0;
  for (const target of targets as unknown[]) {
    if (target === null || typeof target !== "object") continue;
    const { type, waiters } = target as { type?: unknown; waiters?: { matched?: unknown } };
    if (type === "waiter" && typeof waiters?.matched === "number") return waiters.matched;
  }
  return 0;
}
