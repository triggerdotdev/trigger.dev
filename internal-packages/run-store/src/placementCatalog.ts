// Every method on the `RunStore` interface must appear exactly once below, as a read or as a
// write. `placement.proof.test.ts` diffs this catalog against the interface, so a method added
// to `RunStore` fails the build until somebody classifies it.
//
// Why this exists, and why it is separate from the waitpoint mint census: that census is
// exhaustive over id PRODUCTION and asks "is this id stamped with a shard?". A row with no
// minted id of its own is invisible to it. `WaitpointTag` was exactly that row, and it wrote
// to a gen-1 store for a gen-2 environment while every functional test passed, because the
// read path fans out over every store and found it anyway. This catalog is exhaustive over row
// PLACEMENT instead, and asks a different question of each write: what does it route by?
//
// The one combination that must never exist is a write which routes by nothing better than the
// binary residency hint AND whose miss is silent. A silent miss puts a row on a database its
// owner does not live on, with no error at write time and no symptom at read time.
//
// PURE module: no store import, no Prisma, no env. It is data about the source, checked
// against the source by the proof test.

/** What the routing decision is made from. */
type PlacementBasis =
  /** The row's own id, which carries its shard. Safe: the row lands where its id says. */
  | "own-id"
  /** An owning row's id (a run, a batch). Safe: the row follows its owner. */
  | "owner-id"
  /** An explicit shard key passed by the caller, for rows with no routable id at all. */
  | "shard-hint"
  /** Partitioned or summed across every store, gen-2 shards included. Safe: nothing to miss. */
  | "fan-out"
  /** Nothing but the binary NEW/LEGACY residency hint. Cannot name a gen-2 shard. */
  | "residency";

/**
 * What happens when a write is routed to a database that does not hold the row.
 *
 * `loud` — Prisma raises "no record was found for an update" and the caller sees it. Still a
 * defect, but a visible one: this is how the gen-2 batch-completion hang was found.
 *
 * `silent` — the write succeeds against the wrong database. A create or an upsert inserts a
 * new row there; an `updateMany` reports zero rows affected, which callers read as "nothing
 * to do". Nothing is logged and nothing fails.
 */
type MissMode = "loud" | "silent";

export type PlacementSite = {
  /** Method name on the `RunStore` interface. */
  method: string;
  basis: PlacementBasis;
  missMode: MissMode;
  /**
   * Routing expressions this method's implementation contains, verbatim, as they appear in
   * `runOpsStore.ts`. The proof test requires each one to still be present, so weakening a
   * route (dropping a shard hint, swapping an id for a residency fallback) fails here first.
   *
   * A method with several arms lists all of them: the FIRST arm that matches at runtime is
   * what routes, so a set that looks safe on its last arm is not evidence of anything.
   */
  routes: readonly string[];
  /** Required for `residency` and `fan-out`, where safety is a claim rather than a mechanism. */
  why?: string;
};

/**
 * The unremarkable majority: a method handed a run id, routing on it. Listed by name rather
 * than as 30 identical entries, because 30 identical entries get rubber-stamped in review and
 * a census nobody reads is decorative.
 */
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

/** The shared routing expression every member of the list above contains. */
export const GIVEN_RUN_ID_ROUTE = "#routeForWrite(runId)";

/** Writes whose routing is worth stating one by one. */
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
    why: "Prefers a co-location anchor (the owning run or batch), then the waitpoint's own stamped id, and only then the residency hint. The router refuses an unstamped id against a gen-2 shard, which is what makes the last arm safe to keep.",
  },
  {
    method: "upsertWaitpoint",
    basis: "own-id",
    missMode: "silent",
    routes: ["#waitpointWriteStore(opts?.coLocateWithRunId, opts?.residency, waitpointId)"],
    why: "As createWaitpoint: anchor, then the waitpoint's own id, then residency, with the router refusing an unstamped id on a gen-2 shard.",
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
 * Reads. Listed only so that the union of reads and writes covers the interface exactly: a new
 * method called `getOrCreateThing` would otherwise pass for a read on the strength of its name.
 * Read routing is not audited here; a read that probes the wrong store finds nothing and moves
 * on, which is a latency and correctness question rather than a placement one.
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
