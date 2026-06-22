import type { RunStore } from "./types.js";

/** Test double: throws on any call. Inject into units that must not write runs. */
export class NoopRunStore implements RunStore {
  private fail(method: string): never {
    throw new Error(`NoopRunStore.${method} called`);
  }
  createRun(): never { return this.fail("createRun"); }
  createCancelledRun(): never { return this.fail("createCancelledRun"); }
  createFailedRun(): never { return this.fail("createFailedRun"); }
  startAttempt(): never { return this.fail("startAttempt"); }
  completeAttemptSuccess(): never { return this.fail("completeAttemptSuccess"); }
  recordRetryOutcome(): never { return this.fail("recordRetryOutcome"); }
  requeueRun(): never { return this.fail("requeueRun"); }
  recordBulkActionMembership(): never { return this.fail("recordBulkActionMembership"); }
  cancelRun(): never { return this.fail("cancelRun"); }
  failRunPermanently(): never { return this.fail("failRunPermanently"); }
  expireRun(): never { return this.fail("expireRun"); }
  expireRunsBatch(): never { return this.fail("expireRunsBatch"); }
  lockRunToWorker(): never { return this.fail("lockRunToWorker"); }
  parkPendingVersion(): never { return this.fail("parkPendingVersion"); }
  promotePendingVersionRuns(): never { return this.fail("promotePendingVersionRuns"); }
  suspendForCheckpoint(): never { return this.fail("suspendForCheckpoint"); }
  resumeFromCheckpoint(): never { return this.fail("resumeFromCheckpoint"); }
  rescheduleRun(): never { return this.fail("rescheduleRun"); }
  enqueueDelayedRun(): never { return this.fail("enqueueDelayedRun"); }
  rewriteDebouncedRun(): never { return this.fail("rewriteDebouncedRun"); }
  updateMetadata(): never { return this.fail("updateMetadata"); }
  clearIdempotencyKey(): never { return this.fail("clearIdempotencyKey"); }
  pushTags(): never { return this.fail("pushTags"); }
  pushRealtimeStream(): never { return this.fail("pushRealtimeStream"); }
  findRun(): never { return this.fail("findRun"); }
  findRunOrThrow(): never { return this.fail("findRunOrThrow"); }
  findRuns(): never { return this.fail("findRuns"); }
}
