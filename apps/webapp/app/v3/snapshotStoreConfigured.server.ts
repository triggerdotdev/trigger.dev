import { env } from "~/env.server";

/**
 * The single bootstrap switch for the snapshot store. With no Redis host configured the feature is
 * inert: the org census does not poll, the run store is a plain Postgres passthrough with no per-write
 * mode resolution, and no decorator is attached. Every optional piece gates on this one predicate so
 * that merging the feature with the host unset adds zero standing cost.
 */
export function isSnapshotStoreConfigured(
  host: string | undefined = env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST ?? undefined
): boolean {
  return !!host;
}
