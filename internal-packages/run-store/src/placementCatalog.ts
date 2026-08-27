// Every method on the `RunStore` interface appears exactly once below, as a read or as a write.
// `placement.proof.test.ts` diffs this catalog against the interface, so a new method fails the
// build until somebody classifies it.
//
// The waitpoint mint census is exhaustive over id production and cannot see a row with no minted
// id, which is how `WaitpointTag` wrote to a gen-1 store for a gen-2 environment with every
// functional test passing. This is exhaustive over placement instead: what does each write route
// by? The combination that must never exist is residency-only routing with a silent miss.
//
// Pure module: no store import, no Prisma, no env.

/** What the routing decision is made from. `residency` cannot name a gen-2 shard. */
type PlacementBasis = "own-id" | "owner-id" | "shard-hint" | "fan-out" | "residency";

/**
 * `loud` — Prisma raises "no record was found for an update" and the caller sees it.
 * `silent` — the write succeeds on the wrong database. A create inserts a row there; an
 * `updateMany` reports zero rows affected, which callers read as "nothing to do".
 */
type MissMode = "loud" | "silent";

export type PlacementSite = {
  method: string;
  basis: PlacementBasis;
  missMode: MissMode;
  /**
   * Routing expressions the implementation contains, verbatim. The proof test requires each to
   * still be present, so weakening a route fails here first. List every arm: the first arm that
   * matches is what routes, so a set that looks safe on its last arm proves nothing.
   */
  routes: readonly string[];
  /** Required for `residency` and `fan-out`, where safety is a claim rather than a mechanism. */
  why?: string;
};

/** Handed a run id, routing on it. Listed by name; 20 identical entries would be rubber-stamped. */
export const ROUTES_BY_GIVEN_RUN_ID: readonly string[] = [
  "startAttempt",
  "completeAttemptSuccess",
  "recordRetryOutcome",
  "requeueRun",
  "recordBulkActionMembership",
  "cancelRun",
  "failRunPermanently",
  "finalizeRun",
  "expireRun",
  "lockRunToWorker",
  "parkPendingVersion",
  "promotePendingVersionRuns",
  "expireParkedRun",
  "suspendForCheckpoint",
  "resumeFromCheckpoint",
  "rescheduleRun",
  "enqueueDelayedRun",
  "rewriteDebouncedRun",
  "pushTags",
  "pushRealtimeStream",
];

export const GIVEN_RUN_ID_ROUTE = "#routeForWrite(runId)";

export const PLACEMENT_SITES: readonly PlacementSite[] = [
  {
    method: "runInTransaction",
    basis: "own-id",
    missMode: "loud",
    routes: ["#routeOrNew(runId)"],
  },
  {
    method: "createRun",
    basis: "own-id",
    missMode: "silent",
    routes: ["#routeOrNew(params.data.id)"],
  },
  {
    method: "createCancelledRun",
    basis: "own-id",
    missMode: "silent",
    routes: ["#routeOrNew(params.data.id)"],
  },
  {
    method: "createFailedRun",
    basis: "own-id",
    missMode: "silent",
    routes: ["#routeOrNew(params.data.id)"],
  },
  {
    method: "updateMetadata",
    basis: "own-id",
    missMode: "loud",
    routes: ["#routeOrNewForWrite(runId)"],
  },
  {
    method: "clearIdempotencyKey",
    basis: "fan-out",
    missMode: "silent",
    routes: ["#route(params.byId.runId)", "#shardStore(NEW_SHARD)", "#shardsExcept(NEW_SHARD)"],
    why: "Routes by run id when the caller has one. The predicate arm has no id at all, so it checks NEW and then every remaining store, gen-2 shards included: a key minted before an org flipped still lives on a run in another store, and missing it leaves a stale key deduping forever.",
  },
  {
    method: "expireRunsBatch",
    basis: "fan-out",
    missMode: "silent",
    routes: ["#fanOutPartitioned(this.#probeOrder, runIds"],
    why: "Partitions the id list by shape and calls each store with only its own ids, over the full probe order rather than a gen-1 pair. Nothing is missed because every id is routed individually.",
  },
  {
    method: "createExecutionSnapshot",
    basis: "owner-id",
    missMode: "silent",
    routes: ["#routeOrNewForWrite(input.run.id)"],
  },
  {
    method: "createBatchTaskRunItem",
    basis: "owner-id",
    missMode: "silent",
    routes: ["#routeForWrite(data.batchTaskRunId)"],
  },
  {
    method: "createTaskRunCheckpoint",
    basis: "owner-id",
    missMode: "silent",
    routes: ["#route(ownerRunId)"],
  },
  {
    method: "blockRunWithWaitpointEdges",
    basis: "owner-id",
    missMode: "silent",
    routes: ["#routeOrNewForWrite(params.runId)"],
  },
  {
    method: "deleteManyTaskRunWaitpoints",
    basis: "owner-id",
    missMode: "silent",
    routes: [
      "#routeOrNewForWrite(taskRunId)",
      "#sumCounts((store) => store.deleteManyTaskRunWaitpoints(args))",
    ],
    why: "Routes by the owning run id when the filter names one; otherwise sums across every store, so a delete cannot quietly skip a shard.",
  },
  {
    method: "createBatchTaskRun",
    basis: "own-id",
    missMode: "silent",
    routes: ["#routeForWrite(data.id)"],
  },
  {
    method: "updateBatchTaskRun",
    basis: "own-id",
    missMode: "loud",
    routes: ["#routeOrNew(id)"],
  },
  {
    method: "updateManyBatchTaskRun",
    basis: "fan-out",
    missMode: "silent",
    routes: ["#routeOrNew(id)", "#sumCounts((store) => store.updateManyBatchTaskRun(args))"],
    why: "Routes by batch id when the filter names one, and otherwise sums across every store. An updateMany reports zero rows rather than failing, so the fan-out is what keeps a filtered update from silently skipping a shard.",
  },
  {
    method: "updateManyBatchTaskRunItems",
    basis: "fan-out",
    missMode: "silent",
    routes: ["#routeOrNew(id)", "#sumCounts((store) => store.updateManyBatchTaskRunItems(args))"],
    why: "Same shape as updateManyBatchTaskRun: id when available, every store otherwise.",
  },
  {
    method: "createWaitpoint",
    basis: "own-id",
    missMode: "silent",
    routes: ["#waitpointWriteStore("],
    why: "Prefers a co-location anchor (the owning run or batch), then the waitpoint's own stamped id, and only then the residency hint. The anchor arm refuses an unstamped id against a gen-2 shard, and the residency arm is skipped entirely when the id names a gen-2 shard, because the hint cannot express that answer.",
  },
  {
    method: "upsertWaitpoint",
    basis: "own-id",
    missMode: "silent",
    routes: ["#waitpointWriteStore(opts?.coLocateWithRunId, opts?.residency, waitpointId)"],
    why: "As createWaitpoint: anchor, then the waitpoint's own stamped id, then residency. A residency hint never wins over an id naming a gen-2 shard.",
  },
  {
    method: "updateWaitpoint",
    basis: "own-id",
    missMode: "loud",
    routes: ["#resolveWaitpointStore(id)", "#routeOrNew(opts.coLocateWithRunId)"],
    why: "The waitpoint's own id wins; the co-location hint is only the fallback for a filter that names no id. Ordering matters here and the arms must stay in this order.",
  },
  {
    method: "updateManyWaitpoints",
    basis: "fan-out",
    missMode: "silent",
    routes: [
      "#resolveWaitpointStore(id)",
      "#sumCounts((store) => store.updateManyWaitpoints(args))",
    ],
    why: "Routes by waitpoint id when the filter names one, and sums across every store otherwise, because an updateMany that lands on the wrong database reports zero rows instead of failing.",
  },
  {
    method: "upsertWaitpointTag",
    basis: "shard-hint",
    missMode: "silent",
    routes: ["#shardStore(shardKey)", "#waitpointWriteStore(undefined, residency, data.id)"],
    why: "A tag row has no id the router can read and no owning row to follow, so the caller passes the environment's mint shard explicitly. Without that hint this write routes on residency alone, which cannot name a gen-2 shard: the row lands on a gen-1 store while the tokens it describes live on the shard, and because reads fan out the row is still found. That is the defect this catalog was built after.",
  },
];

/**
 * Reads, listed only so the union covers the interface exactly: a new method named
 * `getOrCreateThing` would otherwise pass for a read on the strength of its name. Read routing is
 * not audited here, because a read that probes the wrong store finds nothing and moves on.
 */
export const READ_ONLY_METHODS: readonly string[] = [
  "findRun",
  "findRunOrThrow",
  "findRunOnPrimary",
  "findRunOrThrowOnPrimary",
  "findRuns",
  "findRunsByIds",
  "findRunsByIdempotencyKeys",
  "findLatestExecutionSnapshot",
  "findExecutionSnapshot",
  "findManyExecutionSnapshots",
  "findSnapshotCompletedWaitpointIds",
  "findSnapshotCompletedWaitpointIdsWithPresence",
  "findWaitpointConnectedRunIds",
  "findWaitpointCompletedSnapshotIds",
  "countPendingWaitpoints",
  "countPendingWaitpointsWithPresence",
  "findWaitpoint",
  "findWaitpointOnPrimary",
  "findManyWaitpoints",
  "forWaitpointCompletion",
  "findManyTaskRunWaitpoints",
  "findTaskRunAttempt",
  "findBatchTaskRunById",
  "findBatchTaskRunByFriendlyId",
  "findBatchTaskRunByIdempotencyKey",
  "countBatchTaskRunItems",
  "findManyBatchTaskRunItems",
  "findBatchTaskRunItem",
  "findManyWaitpointTags",
];
