import { getMeter } from "@internal/tracing";

const meter = getMeter("task-meta-cache");

/**
 * One counter for every task-metadata resolution on the trigger path, with two
 * bounded labels:
 *
 *   path:   "locked"  - lockToVersion / triggerAndWait (reads the by-worker hash)
 *           "current" - default trigger (reads the env hash)
 *   source: where the metadata was resolved from:
 *           "cache"   - Redis hit (warm)
 *           "replica" - cache miss, the read replica had the row
 *           "writer"  - cache miss + replica empty, the primary had the row
 *                       (i.e. the replica was stale for an existing row)
 *           "miss"    - not found anywhere (genuinely not registered)
 *
 * Derived signals:
 *   cache / total                  -> cache hit rate (the inverse is coldness)
 *   writer / total                 -> how often the replica returned empty for
 *                                     a row the primary had
 *
 * No env / worker / slug labels: those are unbounded in production.
 */
const resolveCounter = meter.createCounter("task_meta_cache.resolve", {
  description:
    "Task metadata resolutions on the trigger path, by lookup path and the source that satisfied them",
});

export type TaskMetaResolvePath = "locked" | "current";
export type TaskMetaResolveSource = "cache" | "replica" | "writer" | "miss";

export function recordTaskMetaResolve(
  path: TaskMetaResolvePath,
  source: TaskMetaResolveSource
): void {
  resolveCounter.add(1, { path, source });
}
