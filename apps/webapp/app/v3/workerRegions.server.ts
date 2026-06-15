import { type WorkloadType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { createReloadingRegistry } from "~/utils/reloadingRegistry.server";

export type WorkerGroupRegionRow = {
  masterQueue: string;
  region: string | null;
  workloadType: WorkloadType;
  hidden: boolean;
  enableFastPath: boolean;
};

/**
 * Reverse map: a stored worker queue -> its user-facing geo region. A backing
 * queue (e.g. "us-east-1-next") returns the region it backs ("us-east-1");
 * anything unknown or with no region set passes through unchanged (so container
 * queues and not-yet-labelled groups behave exactly as before).
 */
export function regionForQueue(queue: string, groups: WorkerGroupRegionRow[]): string {
  const self = groups.find((g) => g.masterQueue === queue);
  return self?.region ?? queue;
}

/**
 * Forward map: the compute (MICROVM) backing queue for the region that `queue`
 * belongs to, or undefined if the region has no compute backing. `queue` is the
 * resolved (container) worker queue; we look up its region, then find a visible
 * MICROVM group in the same region. Returns the backing group's queue and its
 * `enableFastPath` so the caller adopts the backing's fast-path setting.
 */
export function backingForQueue(
  queue: string,
  groups: WorkerGroupRegionRow[]
): { workerQueue: string; enableFastPath: boolean } | undefined {
  const self = groups.find((g) => g.masterQueue === queue);
  const region = self?.region;
  if (!region) return undefined;
  const backing = groups.find(
    (g) =>
      g.workloadType === "MICROVM" &&
      g.region === region &&
      !g.hidden &&
      g.masterQueue !== queue
  );
  if (!backing) return undefined;
  return { workerQueue: backing.masterQueue, enableFastPath: backing.enableFastPath };
}

/**
 * In-memory snapshot of every worker group's (queue, region, type, hidden),
 * refreshed on an interval. Read synchronously on the hot path; callers gate the
 * first read on `waitUntilReady`. DB-backed source of truth for region<->backing
 * resolution (replaces the old env-var backing map).
 */
export const workerRegionRegistry = singleton("workerRegionRegistry", () =>
  createReloadingRegistry<WorkerGroupRegionRow[]>({
    name: "worker-region",
    intervalMs: env.GLOBAL_FLAGS_RELOAD_INTERVAL_MS,
    autoStart: process.env.NODE_ENV !== "test", // only auto-poll outside tests
    load: () =>
      prisma.workerInstanceGroup.findMany({
        select: {
          masterQueue: true,
          region: true,
          workloadType: true,
          hidden: true,
          enableFastPath: true,
        },
      }),
  })
);
