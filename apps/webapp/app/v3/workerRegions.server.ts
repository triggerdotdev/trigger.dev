import {
  formatWorkerQueue,
  parseWorkerQueue,
  type WorkerQueue,
} from "@trigger.dev/core/v3/workers";
import { type WorkerInstanceGroupType, type WorkloadType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { createReloadingRegistry } from "~/utils/reloadingRegistry.server";

export type WorkerGroupRegionRow = {
  id: string;
  masterQueue: string;
  region: string | null;
  workloadType: WorkloadType;
  hidden: boolean;
  enableFastPath: boolean;
  type: WorkerInstanceGroupType;
  projectId: string | null;
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
 * Forward map: the compute backing queue for the region that `queue` belongs to, or undefined if
 * the region has no compute backing. `queue` is the resolved (container) worker queue; we look up
 * its region, then find a visible MICROVM group in the same region. Failing that, a group listed in
 * `mixedRuntimeGroupIds` is its own backing, as it carries compute consumers too. Returns the
 * backing group's queue and its `enableFastPath` so the caller adopts the backing's setting.
 */
export function backingForQueue(
  queue: string,
  groups: WorkerGroupRegionRow[],
  mixedRuntimeGroupIds: readonly string[]
): { workerQueue: string; enableFastPath: boolean } | undefined {
  const self = groups.find((g) => g.masterQueue === queue);
  const region = self?.region;
  if (!region) return undefined;
  const backing =
    groups.find(
      (g) =>
        g.workloadType === "MICROVM" && g.region === region && !g.hidden && g.masterQueue !== queue
    ) ?? (mixedRuntimeGroupIds.includes(self.id) ? self : undefined);
  if (!backing) return undefined;
  return { workerQueue: backing.masterQueue, enableFastPath: backing.enableFastPath };
}

/**
 * The mixed-runtime groups that may be their own compute backing. Only v2 queues have compat lanes
 * that keep compute runs apart from container runs, so none qualifies while v2 queues are off.
 */
export function selfBackingWorkerGroups(
  mixedRuntimeGroupIds: readonly string[],
  v2Enabled: boolean
): readonly string[] {
  return v2Enabled ? mixedRuntimeGroupIds : [];
}

/**
 * The container worker queue to use instead of a compute worker queue, for a run whose deployment
 * has no template. Undefined when `queue` is not a compute queue, or when no container group serves
 * its region. A v2 queue keeps its region, class and phase, on the stable channel. A legacy queue
 * keeps its class.
 */
export function containerQueueForComputeQueue(
  queue: string,
  groups: WorkerGroupRegionRow[]
): string | undefined {
  let parsed: WorkerQueue;
  try {
    parsed = parseWorkerQueue(queue);
  } catch {
    return undefined;
  }

  // Only shared groups: a project-scoped group's queue belongs to that project's workers.
  const containers = groups.filter(
    (g) => g.workloadType === "CONTAINER" && g.type === "MANAGED" && g.projectId === null
  );

  if (parsed.version !== "legacy") {
    if (parsed.compat === "container") return undefined;
    // A group without a region consumes v2 queues under its master queue name.
    const served = containers.some((g) => (g.region ?? g.masterQueue) === parsed.region);
    return served
      ? formatWorkerQueue({ ...parsed, compat: "container", channel: "stable" })
      : undefined;
  }

  const self = groups.find((g) => g.masterQueue === parsed.region);
  if (!self || self.workloadType !== "MICROVM" || !self.region) return undefined;
  const inRegion = containers.filter((g) => g.region === self.region);
  const container =
    inRegion.find((g) => g.masterQueue === self.region) ?? inRegion.find((g) => !g.hidden);
  if (!container) return undefined;
  return formatWorkerQueue({ ...parsed, region: container.masterQueue });
}

/**
 * In-memory snapshot of every worker group's (queue, region, type, hidden),
 * refreshed on an interval. Read synchronously on the hot path; a cold read
 * returns undefined (callers default safely - no backing, so not-migrated).
 * DB-backed source of truth for region<->backing resolution (replaces the old
 * env-var backing map).
 */
export const workerRegionRegistry = singleton("workerRegionRegistry", () =>
  createReloadingRegistry<WorkerGroupRegionRow[]>({
    name: "worker-region",
    intervalMs: env.GLOBAL_FLAGS_RELOAD_INTERVAL_MS,
    autoStart: process.env.NODE_ENV !== "test", // only auto-poll outside tests
    load: () =>
      prisma.workerInstanceGroup.findMany({
        select: {
          id: true,
          masterQueue: true,
          region: true,
          workloadType: true,
          hidden: true,
          enableFastPath: true,
          type: true,
          projectId: true,
        },
      }),
  })
);
