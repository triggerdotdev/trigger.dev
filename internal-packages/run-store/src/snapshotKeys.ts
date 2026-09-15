import { crc32 } from "node:zlib";

// Versioned MemoryDB namespace and the pending-index topology, LOCKED before the Lua primitives that
// hard-code them. Everything the rebuild writes lives under `snap:v1:`; the rebuild never reads or
// writes an unversioned or lower-version key, so old-format Redis data from the replaced protocol is
// invisible to it. Every operational knob here (256, v1, the group name) is a fixed constant.

/** The versioned key prefix. Every key the rebuild touches begins with it. */
export const SNAPSHOT_NAMESPACE = "snap:v1";

/** The state-version stamped into the run-state hash. Reads fail closed on any other value. */
export const SNAPSHOT_STATE_VERSION = "1";

/** Fixed number of pending partitions. Independent of org count, never resized at runtime. */
export const PENDING_PARTITION_COUNT = 256;

/**
 * A run's partition: `crc32(runId) mod 256`. Deterministic, org-count-independent, and identical on
 * every pod, so a run's keys and its partition's pending stream always resolve to the same slot.
 */
export function runToPartition(runId: string): number {
  return crc32(runId) % PENDING_PARTITION_COUNT;
}

/** The partition's hash-tag body, zero-padded to three digits, e.g. `p007`. */
export function partitionTag(partition: number): string {
  return `p${partition.toString().padStart(3, "0")}`;
}

export type SnapshotKeys = { e: string; idx: string; cur: string; seq: string };

/**
 * The four core run-state keys. All share the `{pNNN}` partition hash tag, so a run's whole state
 * (plus every `:wp:<cycleSeq>` cycle key the Lua prelude derives by stripping `:e`) sits in one
 * cluster slot and every mutation is one atomic script.
 */
export function snapshotKeys(runId: string): SnapshotKeys {
  const base = `${SNAPSHOT_NAMESPACE}:run:{${partitionTag(runToPartition(runId))}}:${runId}`;
  return { e: `${base}:e`, idx: `${base}:idx`, cur: `${base}:cur`, seq: `${base}:seq` };
}

/**
 * The Redis-primary residency marker key. Shares the run's partition tag but is a SEPARATE physical
 * key: it has no TTL ever, so it outlives the run-state keys once they take the terminal 14-day TTL.
 */
export function residencyKey(runId: string): string {
  return `${SNAPSHOT_NAMESPACE}:res:{${partitionTag(runToPartition(runId))}}:${runId}`;
}

/**
 * The hidden prepared-unit key. Shares the run's partition tag; no TTL while pending, removed on
 * finalize/abort. The M3 prepare protocol writes it; here it is only a key-layout lock.
 */
export function preparedUnitKey(runId: string): string {
  return `${SNAPSHOT_NAMESPACE}:prep:{${partitionTag(runToPartition(runId))}}:${runId}`;
}

/** The per-partition recovery pending stream, sharing the partition's hash tag. */
export function pendingStreamKey(partition: number): string {
  return `${SNAPSHOT_NAMESPACE}:pending:{${partitionTag(partition)}}`;
}

/** The pending stream a run's prepared unit is indexed in, from its partition. */
export function pendingStreamKeyForRun(runId: string): string {
  return pendingStreamKey(runToPartition(runId));
}

/** The single fleet-lease key: exactly one holder scans the recovery partitions. Fixed, no fan-out. */
export function recoveryLeaseKey(): string {
  return `${SNAPSHOT_NAMESPACE}:recovery:lease`;
}

/**
 * The durable namespace/protocol marker. One fixed key, never expires: it records the protocol version
 * the cluster was bootstrapped with, so a build whose version differs fails the redis-primary preflight
 * closed rather than writing an unrecognised format.
 */
export function protocolMarkerKey(): string {
  return `${SNAPSHOT_NAMESPACE}:meta:protocol`;
}
