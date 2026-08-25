// Maintained by hand. It was scaffolded once, and the scaffolding is gone.
//
// When RunStore gains or loses a member, add or remove the forwarder here. You do not have to
// remember: `implements RunStore` fails with TS2420 on a member that is missing, and the assertion
// at the foot of this file fails on a public member the interface does not declare.

// A pass-through over another RunStore. It exists so a decorator can override the handful of methods
// it cares about and inherit the rest, instead of restating 80-odd forwarders alongside real logic.
//
// Arguments and return values are forwarded untouched. The `any` signatures carry each method's
// whole overload set through one forwarder, which is the single thing a generated base cannot
// preserve; a subclass that overrides a method restates the real signature there.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RunStore } from "./types.js";

export class DelegatingRunStore implements RunStore {
  constructor(protected readonly delegate: RunStore) {}

  get primaryReadClient(): RunStore["primaryReadClient"] {
    return this.delegate.primaryReadClient;
  }

  runInTransaction(...args: any[]): any {
    return (this.delegate as any).runInTransaction(...args);
  }

  createRun(...args: any[]): any {
    return (this.delegate as any).createRun(...args);
  }

  createCancelledRun(...args: any[]): any {
    return (this.delegate as any).createCancelledRun(...args);
  }

  createFailedRun(...args: any[]): any {
    return (this.delegate as any).createFailedRun(...args);
  }

  startAttempt(...args: any[]): any {
    return (this.delegate as any).startAttempt(...args);
  }

  completeAttemptSuccess(...args: any[]): any {
    return (this.delegate as any).completeAttemptSuccess(...args);
  }

  recordRetryOutcome(...args: any[]): any {
    return (this.delegate as any).recordRetryOutcome(...args);
  }

  requeueRun(...args: any[]): any {
    return (this.delegate as any).requeueRun(...args);
  }

  recordBulkActionMembership(...args: any[]): any {
    return (this.delegate as any).recordBulkActionMembership(...args);
  }

  cancelRun(...args: any[]): any {
    return (this.delegate as any).cancelRun(...args);
  }

  failRunPermanently(...args: any[]): any {
    return (this.delegate as any).failRunPermanently(...args);
  }

  finalizeRun(...args: any[]): any {
    return (this.delegate as any).finalizeRun(...args);
  }

  expireRun(...args: any[]): any {
    return (this.delegate as any).expireRun(...args);
  }

  expireRunsBatch(...args: any[]): any {
    return (this.delegate as any).expireRunsBatch(...args);
  }

  lockRunToWorker(...args: any[]): any {
    return (this.delegate as any).lockRunToWorker(...args);
  }

  parkPendingVersion(...args: any[]): any {
    return (this.delegate as any).parkPendingVersion(...args);
  }

  promotePendingVersionRuns(...args: any[]): any {
    return (this.delegate as any).promotePendingVersionRuns(...args);
  }

  expireParkedRun(...args: any[]): any {
    return (this.delegate as any).expireParkedRun(...args);
  }

  suspendForCheckpoint(...args: any[]): any {
    return (this.delegate as any).suspendForCheckpoint(...args);
  }

  resumeFromCheckpoint(...args: any[]): any {
    return (this.delegate as any).resumeFromCheckpoint(...args);
  }

  rescheduleRun(...args: any[]): any {
    return (this.delegate as any).rescheduleRun(...args);
  }

  enqueueDelayedRun(...args: any[]): any {
    return (this.delegate as any).enqueueDelayedRun(...args);
  }

  rewriteDebouncedRun(...args: any[]): any {
    return (this.delegate as any).rewriteDebouncedRun(...args);
  }

  updateMetadata(...args: any[]): any {
    return (this.delegate as any).updateMetadata(...args);
  }

  clearIdempotencyKey(...args: any[]): any {
    return (this.delegate as any).clearIdempotencyKey(...args);
  }

  pushTags(...args: any[]): any {
    return (this.delegate as any).pushTags(...args);
  }

  pushRealtimeStream(...args: any[]): any {
    return (this.delegate as any).pushRealtimeStream(...args);
  }

  findRun(...args: any[]): any {
    return (this.delegate as any).findRun(...args);
  }

  findRunOrThrow(...args: any[]): any {
    return (this.delegate as any).findRunOrThrow(...args);
  }

  findRunOnPrimary(...args: any[]): any {
    return (this.delegate as any).findRunOnPrimary(...args);
  }

  findRunOrThrowOnPrimary(...args: any[]): any {
    return (this.delegate as any).findRunOrThrowOnPrimary(...args);
  }

  findRuns(...args: any[]): any {
    return (this.delegate as any).findRuns(...args);
  }

  findRunsByIds(...args: any[]): any {
    return (this.delegate as any).findRunsByIds(...args);
  }

  findRunsByIdempotencyKeys(...args: any[]): any {
    return (this.delegate as any).findRunsByIdempotencyKeys(...args);
  }

  createBatchTaskRunItem(...args: any[]): any {
    return (this.delegate as any).createBatchTaskRunItem(...args);
  }

  findLatestExecutionSnapshot(...args: any[]): any {
    return (this.delegate as any).findLatestExecutionSnapshot(...args);
  }

  findExecutionSnapshot(...args: any[]): any {
    return (this.delegate as any).findExecutionSnapshot(...args);
  }

  findManyExecutionSnapshots(...args: any[]): any {
    return (this.delegate as any).findManyExecutionSnapshots(...args);
  }

  createExecutionSnapshot(...args: any[]): any {
    return (this.delegate as any).createExecutionSnapshot(...args);
  }

  findSnapshotCompletedWaitpointIds(...args: any[]): any {
    return (this.delegate as any).findSnapshotCompletedWaitpointIds(...args);
  }

  findSnapshotCompletedWaitpointIdsWithPresence(...args: any[]): any {
    return (this.delegate as any).findSnapshotCompletedWaitpointIdsWithPresence(...args);
  }

  findWaitpointConnectedRunIds(...args: any[]): any {
    return (this.delegate as any).findWaitpointConnectedRunIds(...args);
  }

  findWaitpointCompletedSnapshotIds(...args: any[]): any {
    return (this.delegate as any).findWaitpointCompletedSnapshotIds(...args);
  }

  blockRunWithWaitpointEdges(...args: any[]): any {
    return (this.delegate as any).blockRunWithWaitpointEdges(...args);
  }

  countPendingWaitpoints(...args: any[]): any {
    return (this.delegate as any).countPendingWaitpoints(...args);
  }

  countPendingWaitpointsWithPresence(...args: any[]): any {
    return (this.delegate as any).countPendingWaitpointsWithPresence(...args);
  }

  createWaitpoint(...args: any[]): any {
    return (this.delegate as any).createWaitpoint(...args);
  }

  upsertWaitpoint(...args: any[]): any {
    return (this.delegate as any).upsertWaitpoint(...args);
  }

  findWaitpoint(...args: any[]): any {
    return (this.delegate as any).findWaitpoint(...args);
  }

  findWaitpointOnPrimary(...args: any[]): any {
    return (this.delegate as any).findWaitpointOnPrimary(...args);
  }

  findManyWaitpoints(...args: any[]): any {
    return (this.delegate as any).findManyWaitpoints(...args);
  }

  updateWaitpoint(...args: any[]): any {
    return (this.delegate as any).updateWaitpoint(...args);
  }

  updateManyWaitpoints(...args: any[]): any {
    return (this.delegate as any).updateManyWaitpoints(...args);
  }

  forWaitpointCompletion(...args: any[]): any {
    return (this.delegate as any).forWaitpointCompletion(...args);
  }

  findManyTaskRunWaitpoints(...args: any[]): any {
    return (this.delegate as any).findManyTaskRunWaitpoints(...args);
  }

  deleteManyTaskRunWaitpoints(...args: any[]): any {
    return (this.delegate as any).deleteManyTaskRunWaitpoints(...args);
  }

  findTaskRunAttempt(...args: any[]): any {
    return (this.delegate as any).findTaskRunAttempt(...args);
  }

  createTaskRunCheckpoint(...args: any[]): any {
    return (this.delegate as any).createTaskRunCheckpoint(...args);
  }

  createBatchTaskRun(...args: any[]): any {
    return (this.delegate as any).createBatchTaskRun(...args);
  }

  updateBatchTaskRun(...args: any[]): any {
    return (this.delegate as any).updateBatchTaskRun(...args);
  }

  findBatchTaskRunById(...args: any[]): any {
    return (this.delegate as any).findBatchTaskRunById(...args);
  }

  findBatchTaskRunByFriendlyId(...args: any[]): any {
    return (this.delegate as any).findBatchTaskRunByFriendlyId(...args);
  }

  findBatchTaskRunByIdempotencyKey(...args: any[]): any {
    return (this.delegate as any).findBatchTaskRunByIdempotencyKey(...args);
  }

  updateManyBatchTaskRun(...args: any[]): any {
    return (this.delegate as any).updateManyBatchTaskRun(...args);
  }

  countBatchTaskRunItems(...args: any[]): any {
    return (this.delegate as any).countBatchTaskRunItems(...args);
  }

  updateManyBatchTaskRunItems(...args: any[]): any {
    return (this.delegate as any).updateManyBatchTaskRunItems(...args);
  }

  findManyBatchTaskRunItems(...args: any[]): any {
    return (this.delegate as any).findManyBatchTaskRunItems(...args);
  }

  findBatchTaskRunItem(...args: any[]): any {
    return (this.delegate as any).findBatchTaskRunItem(...args);
  }

  upsertWaitpointTag(...args: any[]): any {
    return (this.delegate as any).upsertWaitpointTag(...args);
  }

  findManyWaitpointTags(...args: any[]): any {
    return (this.delegate as any).findManyWaitpointTags(...args);
  }
}

// `implements` above fails when a member of the interface is MISSING here. It says nothing about a
// member that should not exist, so the reverse direction is asserted too: a public member this class
// declares and the interface does not is a build failure.
//
// `protected delegate` is correctly absent from `keyof`, so the constructor parameter does not
// trip this.
type _ClassDeclaresNoExtraMembers = [Exclude<keyof DelegatingRunStore, keyof RunStore>] extends [
  never,
]
  ? true
  : never;
const _classParity: _ClassDeclaresNoExtraMembers = true;
void _classParity;
