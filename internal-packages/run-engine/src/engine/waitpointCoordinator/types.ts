import type { ReadClient } from "@internal/run-store";
import type { PrismaClientOrTransaction, Waitpoint } from "@trigger.dev/database";

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
  readCompletionEnvelopes(
    params: ReadCompletionEnvelopesParams
  ): Promise<CompletionEnvelopeSource[]>;
  registerBlocks(params: RegisterBlocksParams): Promise<{ pendingCount: number }>;
  registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void>;
  complete(params: CompleteParams): Promise<CompleteResult>;
  createDateTimeWaitpoint(params: CreateDateTimeWaitpointParams): Promise<CreateWaitpointResult>;
  createManualWaitpoint(params: CreateManualWaitpointParams): Promise<CreateWaitpointResult>;
  createBatchWaitpoint(params: CreateBatchWaitpointParams): Promise<Waitpoint | null>;
  mintAssociatedWaitpointData(params: {
    projectId: string;
    environmentId: string;
    /**
     * The run this waitpoint belongs to. A store arm derives the waitpoint id from the
     * run's own id body, so the derivation is a pure function of the anchor and needs no
     * lock. A Postgres arm mints a fresh id and ignores this.
     */
    anchorRunId?: string;
    /** Which arm mints it. Absent means legacy, which is what every existing caller wants. */
    mintKind?: WaitpointMintKind;
  }): AssociatedWaitpointData;
  createAssociatedWaitpoint(params: {
    runId: string;
    data: AssociatedWaitpointData;
  }): Promise<Waitpoint>;
};

/**
 * Which coordinator mints a NEW waitpoint. Structurally identical to the webapp's own
 * WaitpointMintKind; re-declared because the engine never imports from the webapp.
 *
 * Read at the mint and never again — every later operation routes by the minted id's shape.
 */
export type WaitpointMintKind = "legacy" | "store";

export type CreateBatchWaitpointParams = {
  batchId: string;
  environmentId: string;
  projectId: string;
  mintKind: WaitpointMintKind;
  /** Legacy arm only: the create may join a caller transaction. A store arm ignores it. */
  tx?: PrismaClientOrTransaction;
};

export type ReadCompletionEnvelopesParams = {
  runId: string;
  /** The DISTINCT completed waitpoint ids to source. Result order is not meaningful. */
  waitpointIds: string[];
};

/**
 * One completed waitpoint's fields, sourced from whichever arm owns it.
 *
 * Deliberately NOT the frozen record type. This is the raw material; the record build
 * decides which output variant a record carries. Both arms return this same shape, so the
 * record build never branches on residency, which is what makes a mixed wait work.
 *
 * `output` is the literal stored value. `outputRef` is set instead when the value was
 * already offloaded to object storage. At most one of the two is set.
 */
export type CompletionEnvelopeSource = {
  id: string;
  friendlyId: string;
  type: "RUN" | "BATCH" | "DATETIME" | "MANUAL";
  completedAt: Date;
  outputType: string;
  outputIsError: boolean;
  output?: string;
  outputRef?: string;
  completedByTaskRunId?: string;
  completedByBatchId?: string;
  completedAfter?: Date;
  /** Already resolved by the arm: userProvidedIdempotencyKey && !inactiveIdempotencyKey. */
  idempotencyKey?: string;
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
export type RegisterBlocksLocklessParams = Omit<RegisterBlocksParams, "client"> & {
  /**
   * The parent's BATCH waitpoint id. A store arm asserts it is present and PENDING on the
   * run's shard before writing any item edge, so the run's pending set can never be
   * momentarily empty mid-absorb. Neither TLA+ campaign models this, so the assertion is
   * the only protection. A legacy arm ignores it.
   */
  batchWaitpointId?: string;
};

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
  mintKind: WaitpointMintKind;
  /** When set, the waitpoint co-locates with this run's DB and the dedup probe targets it. */
  runId?: string;
  projectId: string;
  environmentId: string;
  completedAfter: Date;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
};

export type CreateManualWaitpointParams = {
  mintKind: WaitpointMintKind;
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
