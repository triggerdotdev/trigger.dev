import type { WorkerQueueClass } from "@trigger.dev/core/v3/workers";
import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";

/**
 * Suffix appended to a region's worker queue name to route scheduled-lineage
 * runs onto their own Redis list (e.g. `us-nyc-3` -> `us-nyc-3:scheduled`). A
 * dedicated consumer fleet dequeues the suffixed list so the top-of-hour
 * scheduled-cron herd can't starve standard/agent run startup. The worker queue
 * name is opaque everywhere downstream (it's only ever `:`-joined into a Redis
 * key and persisted on the run), so encoding the class in the suffix needs no
 * Lua, envelope, or resolver changes.
 */
export const SCHEDULED_WORKER_QUEUE_SUFFIX = ":scheduled";

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
 * root down to every descendant) route to the suffixed list when the split is
 * enabled; everything else is unchanged. Idempotent — never double-suffixes.
 */
export function workerQueueForRun({
  workerQueue,
  rootTriggerSource,
  splitEnabled,
}: {
  workerQueue: string;
  rootTriggerSource: string | undefined;
  splitEnabled: boolean;
}): string {
  if (
    !splitEnabled ||
    rootTriggerSource !== SCHEDULE_TRIGGER_SOURCE ||
    workerQueue.endsWith(SCHEDULED_WORKER_QUEUE_SUFFIX)
  ) {
    return workerQueue;
  }

  return `${workerQueue}${SCHEDULED_WORKER_QUEUE_SUFFIX}`;
}

/**
 * Consumer-side counterpart to {@link workerQueueForRun}: given a worker's base
 * (region) queue and the requested queue class, return the worker queue to
 * dequeue from. `"scheduled"` targets the suffixed list; anything else is the
 * base queue. The server always derives this from the authenticated worker's
 * own `masterQueue`, so a token can only ever reach its own region's queues.
 * Idempotent — never double-suffixes.
 */
export function workerQueueForClass(
  masterQueue: string,
  queueClass: WorkerQueueClass | undefined
): string {
  if (queueClass === "scheduled" && !masterQueue.endsWith(SCHEDULED_WORKER_QUEUE_SUFFIX)) {
    return `${masterQueue}${SCHEDULED_WORKER_QUEUE_SUFFIX}`;
  }

  return masterQueue;
}
