import { crc32 } from "node:zlib";

/** Every snapshot key starts with this prefix. The store never reads a key in any other format. */
export const SNAPSHOT_NAMESPACE = "snap:v1";

/** Stamped into the run-state hash. Reads fail closed on any other value. */
export const SNAPSHOT_STATE_VERSION = "1";

/** Do not change: a different count maps existing runs to different keys. */
export const PENDING_PARTITION_COUNT = 256;

/** Identical on every pod, so a run's keys and its partition's pending stream share one slot. */
export function runToPartition(runId: string): number {
  return crc32(runId) % PENDING_PARTITION_COUNT;
}

/** For example `p007`. */
export function partitionTag(partition: number): string {
  return `p${partition.toString().padStart(3, "0")}`;
}

export type SnapshotKeys = { e: string; idx: string; cur: string; seq: string };

/**
 * The run-state keys. They share the `{pNNN}` hash tag with the `:wp:<cycleSeq>` keys that the Lua
 * prelude derives from `e`, so every mutation of a run is one atomic script in one slot.
 */
export function snapshotKeys(runId: string): SnapshotKeys {
  const base = `${SNAPSHOT_NAMESPACE}:run:{${partitionTag(runToPartition(runId))}}:${runId}`;
  return { e: `${base}:e`, idx: `${base}:idx`, cur: `${base}:cur`, seq: `${base}:seq` };
}

/**
 * The birth-residency marker (`mirrored` or `redis-primary`), a key separate from the run state. A
 * redis-primary marker never expires, so an aged-out redis-primary run resolves to `expired`, not
 * Postgres. A mirrored marker expires with the run state.
 */
export function residencyKey(runId: string): string {
  return `${SNAPSHOT_NAMESPACE}:res:{${partitionTag(runToPartition(runId))}}:${runId}`;
}

/** The pending unit, with no TTL. Finalize, abort and quarantine delete it (not if tokenless). */
export function preparedUnitKey(runId: string): string {
  return `${SNAPSHOT_NAMESPACE}:prep:{${partitionTag(runToPartition(runId))}}:${runId}`;
}

export function pendingStreamKey(partition: number): string {
  return `${SNAPSHOT_NAMESPACE}:pending:{${partitionTag(partition)}}`;
}

export function pendingStreamKeyForRun(runId: string): string {
  return pendingStreamKey(runToPartition(runId));
}

/** Only the holder of this fleet-wide lease runs the recovery sweep. */
export function recoveryLeaseKey(): string {
  return `${SNAPSHOT_NAMESPACE}:recovery:lease`;
}

/** The cluster's protocol version. It never expires. A build with another version cannot write. */
export function protocolMarkerKey(): string {
  return `${SNAPSHOT_NAMESPACE}:meta:protocol`;
}
