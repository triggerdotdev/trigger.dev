// Test-only seam for the execution-snapshot write protocol.
//
// The protocol's correctness claim is about crashes: whatever the write order leaves behind at each
// boundary must be a state the existing stall-and-repair machinery heals. Proving that needs a crash
// at an exact point, which is what an injector gives. Production never sets one, so each boundary
// costs one optional call.

/** The three points a crash can land between the two stores' writes. */
export type SnapshotFaultBoundary =
  /** A transition: Postgres has committed and the Redis append has not started. */
  | "afterPgBeforeRedis"
  /** A birth: the Redis append has landed and the Postgres insert has not started. */
  | "afterRedisBirthBeforePg"
  /** Inside the append retry loop, after at least one attempt has failed. */
  | "midFlushRetry";

export type SnapshotFaultInjector = (
  boundary: SnapshotFaultBoundary,
  context: { runId: string; snapshotId: string }
) => void;

/**
 * Thrown by a test injector. The write path tells this apart from a real append failure, because an
 * injected fault models a process that died rather than a call that failed. The two write paths then
 * do different things with it, and both differ from a real failure:
 *
 * - A transition skips its remaining retries, hands the run to the repair job, and does NOT rethrow.
 *   Postgres has already committed, so the caller must not see an error.
 * - A birth rethrows, so the Postgres insert never runs and the crash leaves an orphaned keyspace
 *   with no run row, which is the harmless state that ordering exists to produce.
 * - A real append failure is retried, and only then handed to the repair job.
 */
export class InjectedSnapshotFault extends Error {
  readonly boundary: SnapshotFaultBoundary;

  constructor(boundary: SnapshotFaultBoundary) {
    super(`injected snapshot fault at ${boundary}`);
    this.name = "InjectedSnapshotFault";
    this.boundary = boundary;
  }
}

export function isInjectedFault(error: unknown): error is InjectedSnapshotFault {
  return error instanceof InjectedSnapshotFault;
}
