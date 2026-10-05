import {
  legacyScheduledWorkerQueue,
  scheduledWorkerQueue,
  WORKER_QUEUE_VERSION,
  type WorkerQueueClass,
} from "@trigger.dev/core/v3/workers";
import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";

export { SCHEDULED_WORKER_QUEUE_SUFFIX } from "@trigger.dev/core/v3/workers";

/**
 * Recover the base region a worker queue belongs to by stripping any split
 * suffix (e.g. `us-nyc-3:scheduled` -> `us-nyc-3`). Region/masterQueue names are
 * either `<name>` or `<projectId>-<name>` and never contain a colon, so the
 * region is everything before the first `:`. Use this wherever a worker queue is
 * read as a region — for display, filtering, or as a region override — so
 * scheduled-split runs group under their real region instead of a phantom one.
 * Idempotent; returns the input unchanged when there's no suffix. A nullish
 * worker queue (e.g. from a synthetic run snapshot) passes straight through.
 */
export function baseWorkerQueue(workerQueue: string): string;
export function baseWorkerQueue(workerQueue: string | null | undefined): string | null | undefined;
export function baseWorkerQueue(workerQueue: string | null | undefined): string | null | undefined {
  if (workerQueue == null) {
    return workerQueue;
  }

  const colon = workerQueue.indexOf(":");
  return colon === -1 ? workerQueue : workerQueue.slice(0, colon);
}

/**
 * User-facing region for read surfaces: the explicit geo region if set, else the
 * region derived from the worker queue, else undefined. Use everywhere a run's
 * region is displayed so an empty queue never surfaces as `""` and all surfaces
 * agree. Not for query keys — those want the raw worker queue, not this fallback.
 */
export function regionForDisplay(
  region: string | null | undefined,
  workerQueue: string | null | undefined
): string | undefined {
  return region || (workerQueue ? baseWorkerQueue(workerQueue) : undefined);
}

/** `TriggerSource` value used for runs originating from a schedule. */
const SCHEDULE_TRIGGER_SOURCE = "schedule";

/**
 * Resolve whether the scheduled worker-queue split is enabled for a run, reading
 * only the in-memory org feature-flags JSON (already loaded on the authenticated
 * environment) — never a DB query, so it is safe on the trigger hot path.
 *
 * Precedence: a per-org override wins in BOTH directions; the global default is
 * used only when the org has not set the flag.
 */
export function resolveScheduledQueueSplitEnabled({
  orgFeatureFlags,
  globalDefault,
}: {
  orgFeatureFlags: Record<string, unknown> | null | undefined;
  globalDefault: boolean;
}): boolean {
  const override = orgFeatureFlags?.[FEATURE_FLAG.workerQueueScheduledSplitEnabled];

  if (override !== undefined) {
    const parsed =
      FeatureFlagCatalog[FEATURE_FLAG.workerQueueScheduledSplitEnabled].safeParse(override);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return globalDefault;
}

/**
 * Pick the worker queue a run should be enqueued onto. Runs in a scheduled
 * lineage (`rootTriggerSource === "schedule"`, which propagates from a scheduled
 * root down to every descendant) route to a scheduled list when the split is
 * enabled. Legacy queues gain a suffix; v2 queues retain compatibility/channel.
 */
export function workerQueueForRun({
  workerQueue,
  rootTriggerSource,
  splitEnabled,
  version = "legacy",
}: {
  workerQueue: string;
  rootTriggerSource: string | undefined;
  splitEnabled: boolean;
  version?: "legacy" | typeof WORKER_QUEUE_VERSION;
}): string {
  if (!splitEnabled || rootTriggerSource !== SCHEDULE_TRIGGER_SOURCE) {
    return workerQueue;
  }

  // Legacy names are opaque, including names that happen to look like v2 queues.
  return version === WORKER_QUEUE_VERSION
    ? scheduledWorkerQueue(workerQueue)
    : legacyScheduledWorkerQueue(workerQueue);
}

/** Legacy class selection. This does not resolve or authorize v2 subscriptions. */
export function workerQueueForClass(
  masterQueue: string,
  queueClass: WorkerQueueClass | undefined
): string {
  if (queueClass === "scheduled") {
    return legacyScheduledWorkerQueue(masterQueue);
  }

  return masterQueue;
}

export function parseDisabledWorkerQueues(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

export function matchesDisabledWorkerQueue(
  workerQueue: string,
  disabledWorkerQueues: ReadonlySet<string>,
  version: "legacy" | typeof WORKER_QUEUE_VERSION = "legacy"
): boolean {
  if (disabledWorkerQueues.size === 0) {
    return false;
  }

  return (
    disabledWorkerQueues.has(workerQueue) ||
    (version === "legacy" && disabledWorkerQueues.has(baseWorkerQueue(workerQueue)))
  );
}
