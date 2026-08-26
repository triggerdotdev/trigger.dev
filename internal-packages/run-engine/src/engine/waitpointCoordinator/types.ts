import type { ReadClient } from "@internal/run-store";
import type { PrismaClientOrTransaction, Waitpoint } from "@trigger.dev/database";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";

/**
 * The waitpoint and edge state operations that `WaitpointSystem` delegates.
 *
 * Orchestration stays in `WaitpointSystem`: the run lock, snapshot transitions,
 * worker-job enqueues, event emissions and racepoints. This owns waitpoint and
 * edge state only, so a non-Postgres implementation can replace it without any
 * caller learning that it changed.
 *
 * The residency hints and `tx` are opaque pass-throughs. Opaque does not mean
 * type-free — a Prisma type appears here — it means a non-Postgres implementation
 * never reads the value.
 */
export type WaitpointCoordinator = {
  clearRunBlockState(params: ClearRunBlockStateParams): Promise<{ count: number }>;
  readRunBlockState(runId: string): Promise<RunBlockEdge[]>;
  registerBlocks(params: RegisterBlocksParams): Promise<{ pendingCount: number }>;
  registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void>;
  complete(params: CompleteParams): Promise<CompleteResult>;
  createDateTimeWaitpoint(params: CreateDateTimeWaitpointParams): Promise<CreateWaitpointResult>;
  createManualWaitpoint(params: CreateManualWaitpointParams): Promise<CreateWaitpointResult>;
  mintAssociatedWaitpointData(params: {
    projectId: string;
    environmentId: string;
    /**
     * The run this waitpoint belongs to. Its id names the shard the row must land on, and
     * this write bypasses the routing store's stamp check, so an unstamped id is silent here.
     */
    anchorRunId: string;
  }): AssociatedWaitpointData;
  createAssociatedWaitpoint(params: {
    runId: string;
    data: AssociatedWaitpointData;
  }): Promise<Waitpoint>;
};

export type ClearRunBlockStateParams = {
  runId: string;
  /** Edge ids to delete. Omit to clear every edge for the run. */
  edgeIds?: string[];
  /**
   * Forwarded verbatim on the full-clear leg only, and never on the bounded leg
   * or an edge write. A routing store strips it; a single store joins it.
   */
  tx?: PrismaClientOrTransaction;
};

/**
 * One block edge, with the fields the unblock decision reads.
 *
 * `batchId` is read by no logic. It rides inside the two `logger.debug` payloads in
 * `continueRunIfUnblocked`, so removing it changes log output.
 */
export type RunBlockEdge = {
  id: string;
  batchId: string | null;
  batchIndex: number | null;
  waitpoint: Pick<Waitpoint, "id" | "status" | "type" | "completedAfter">;
};

export type RegisterBlocksParams = {
  runId: string;
  waitpointIds: string[];
  projectId: string;
  spanIdToComplete?: string;
  batchId?: string;
  batchIndex?: number;
  /**
   * Read client for the pending count only. The caller resolves `tx ?? prisma` once
   * and passes the result, so the writer is used when the caller is inside a
   * transaction and the pending re-read is read-your-writes on the owning primary.
   * Never forwarded to the edge write.
   */
  client: ReadClient;
};

/**
 * The lockless variant writes the edge and does not count. Two methods rather than
 * one method with a flag, so "the batch path issues no extra query" is structural.
 */
export type RegisterBlocksLocklessParams = Omit<RegisterBlocksParams, "client">;

export type CompleteParams = {
  waitpointId: string;
  output?: {
    value: string;
    type?: string;
    isError: boolean;
  };
};

/** One run blocked by the completed waitpoint, with the fields the caller's fan-out loop reads. */
type BlockedRun = {
  taskRunId: string;
  spanIdToComplete: string | null;
  createdAt: Date;
};

export type CompleteResult = {
  waitpoint: Waitpoint;
  blockedRuns: BlockedRun[];
};

/**
 * Discriminated on purpose. The caller enqueues the `finishWaitpoint` job only in the
 * `created` branch, because today's create methods return before their enqueue on the
 * cached path. A boolean would let a later edit enqueue on both branches.
 */
export type CreateWaitpointResult =
  | { kind: "cached"; waitpoint: Waitpoint }
  | { kind: "created"; waitpoint: Waitpoint };

export type CreateDateTimeWaitpointParams = {
  /** When set, the waitpoint co-locates with this run's DB and the dedup probe targets it. */
  runId?: string;
  projectId: string;
  environmentId: string;
  completedAfter: Date;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
};

export type CreateManualWaitpointParams = {
  runId?: string;
  environmentId: string;
  projectId: string;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  timeout?: Date;
  tags?: string[];
  /**
   * See the `standaloneResidency` param doc on `WaitpointSystem.createManualWaitpoint` for the
   * full rationale. Only a Postgres implementation reads this.
   */
  standaloneResidency?: "NEW" | "LEGACY";
    /**
     * The environment's mint shard, for a STANDALONE token with no owning run. It selects the
     * shard the token's id is stamped for. When it names a gen-2 shard the caller must NOT also
     * set `standaloneResidency`: a residency hint outranks the id shape in the router and can
     * only name a gen-1 store, so the row would land there while its completion routes to the
     * shard. Only a Postgres implementation reads this.
     */
  standaloneShardKey?: ShardKey;
};

/** The RUN-waitpoint row data. Pure — no store touch — so the mint is coordinator-owned. */
export type AssociatedWaitpointData = {
  id: string;
  friendlyId: string;
  type: "RUN";
  status: "PENDING";
  idempotencyKey: string;
  userProvidedIdempotencyKey: false;
  projectId: string;
  environmentId: string;
};
