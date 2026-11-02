import type { ReadClient, SnapshotResidency } from "@internal/run-store";
import type { PrismaClientOrTransaction, Waitpoint } from "@trigger.dev/database";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import type { WaitpointMintType } from "./mintPolicy.js";

/**
 * The per-mint inputs a routing coordinator needs to select residency. Optional on every create
 * param: when it is absent the mint defaults to legacy, which is the dark production default until a
 * call site threads it (a later ticket). Only a routing coordinator reads it.
 */
export type WaitpointMintContext = {
  organizationId: string;
  /** Optional compatibility hint from older callers; snapshot residency does not gate minting. */
  parentResidency?: SnapshotResidency;
  /** Explicit eligibility override for this mint; otherwise RUN and DATETIME are eligible. */
  eligibleTypes?: ReadonlySet<WaitpointMintType>;
};

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
/**
 * Optional trusted org context for a run-keyed operation. The router checks the organization's current
 * flag before consulting the individual run's durable storage marker. Legacy coordinators ignore it.
 */
export type RunKeyedRoutingContext = {
  organizationId?: string;
};

/** Identify the registration to check. Hold the parent run lock when reading its proof. */
export type AbsorbedBlockersParams = {
  runId: string;
  blockId: string;
  absorptionId: string;
  waitpointIds: string[];
  batchIndex?: number;
  organizationId?: string;
};

export type WaitpointCoordinator = {
  clearRunBlockState(params: ClearRunBlockStateParams): Promise<{ count: number }>;
  readRunBlockState(runId: string, context?: RunKeyedRoutingContext): Promise<RunBlockEdge[]>;
  registerBlocks(params: RegisterBlocksParams): Promise<{ pendingCount: number }>;
  registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void>;
  /**
   * Phase 1 of the three-phase block protocol: absorb the blocker set into run-side coordination and
   * report how many distinct requested blockers are still pending. The caller publishes the durable
   * blocked TRES transition AFTER this returns and BEFORE calling {@link registerBlockers} — so no
   * watcher is ever installed for a run that never durably blocked. Returns an opaque
   * {@link BlockerRegistration} continuation to hand to phase 3 unchanged.
   *
   * Legacy (Postgres) absorbs by writing the block edges and re-reading the pending count under READ
   * COMMITTED, so its two phases straddle the transition safely with the register phase a no-op. Store
   * (MemoryDB) absorbs run-side pending state atomically, and phase 3 registers the waitpoint-side
   * watchers. A routing coordinator partitions by id shape and absorbs MemoryDB before Postgres.
   */
  absorbBlockers(params: AbsorbBlockersParams): Promise<AbsorbBlockersResult>;
  /** Remove recovery proof after registration and its follow-up work finish. */
  finalizeBlockers(params: AbsorbedBlockersParams): Promise<void>;
  /** Check whether this exact request was accepted before recovery retries it. */
  hasAbsorbedBlockers(params: AbsorbedBlockersParams): Promise<boolean>;
  /**
   * Phase 3 of the block protocol: register the run as a watcher on each store-resident waitpoint and
   * immediately deliver any completion the registration reports (an early completion that landed in the
   * absorb→transition→register gap is returned, never lost). A no-op for legacy blockers. Returns the
   * distinct-of-requested pending count AFTER registration and early delivery: 0 means the run is now
   * resumable. A throw partway leaves earlier watchers registered and the run absorbed — nothing
   * resumes early, and the residue is recoverable.
   */
  registerBlockers(registration: BlockerRegistration): Promise<RegisterBlockersResult>;
  /**
   * Acknowledge the durable resume-handoff for a run's current block and drain its edges under the
   * block-id fence. Called at the resume-durability boundary — AFTER TRES has durably accepted the
   * resumed snapshot — so a transient TRES failure costs a retry, not the run's completed receipts. Not
   * a substitute for terminal cleanup, and never raw `clearRunBlockState`.
   */
  /**
   * The run's current store block-operation id, for a caller to OBSERVE before resuming and hand back to
   * {@link acknowledgeResume}, so the acknowledgement targets that exact block and not whichever block is
   * installed later. Undefined for a legacy-only run or an unmarked run (no store read).
   */
  currentStoreBlockId(runId: string, context?: CurrentBlockContext): Promise<string | undefined>;
  acknowledgeResume(params: AcknowledgeResumeParams): Promise<void>;
  /**
   * Non-terminal retry/requeue cleanup: fence and abandon the run's current block and withdraw its
   * watchers so an in-flight old delivery is refused, WITHOUT terminalizing the run — its next attempt
   * must be able to open a fresh block cycle. Returns how many edges were abandoned.
   */
  abandonRunBlockers(params: AbandonRunBlockersParams): Promise<{ count: number }>;
  /**
   * STORE-ONLY replay of a block's retained watcher withdrawal, from its durable record. Used by a
   * delayed cleanup obligation whose block is no longer current: it must NOT touch the legacy coordinator
   * (whose block-id-less edge delete would drop a newer block's Postgres edges) or the current block.
   */
  resumeRetainedWithdrawal(params: {
    runId: string;
    blockId: string;
    organizationId?: string;
  }): Promise<{ count: number }>;
  /**
   * Terminal/cancel cleanup: withdraw the run's watchers terminal-first and arm terminal retention, so a
   * cancelled or terminal run can never be resumed by an in-flight delivery. Returns how many edges were
   * released.
   */
  releaseRunBlockers(params: ReleaseRunBlockersParams): Promise<{ count: number }>;
  /**
   * Clear a LEGACY-ONLY run's block edges BEFORE its failed-attempt transition, in the caller's Postgres
   * client, restoring the pre-store ordering so a crash after the transition cannot strand Postgres edges.
   * A run that may hold store blockers is a no-op here — its cleanup is the fenced post-transition path —
   * and a legacy/unmarked run never consults MemoryDB.
   */
  clearLegacyBlockersBeforeTransition(params: {
    runId: string;
    organizationId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<{ count: number }>;
  /**
   * Durably mark this run's exact current store block as cleanup-owed BEFORE its retry/requeue transition,
   * so a DIFFERENT store block cannot be absorbed until the previous mixed block's cross-store cleanup (its
   * block-id-less legacy delete plus store withdrawal) has fully converged. Store-only; legacy and
   * unmarked runs are a no-op. Lifted as the last step of that cleanup.
   */
  armCleanupFence(params: {
    runId: string;
    blockId: string;
    organizationId?: string;
  }): Promise<void>;
  /** Refuse a legacy edge write while an earlier block still owes cross-store cleanup. */
  assertNoCleanupOwed(runId: string, context?: RunKeyedRoutingContext): Promise<void>;
  /**
   * Roll back ONE absorption's store contribution, by identity: read the exact edge fields it inserted
   * from the durable contribution record, remove only those under the block-id fence (preserving an
   * earlier additive call's pre-existing same-block edges and any receipts), then delete the record. A
   * stale compensation against a newer block mutates nothing but may retire its own obsolete record.
   * Legacy has no store edges (no-op).
   */
  compensateAbsorption(params: {
    runId: string;
    blockId: string;
    absorptionId: string;
    /** Recovery may discard only preparation for this request, never an accepted operation. */
    unacceptedEvidence?: string;
    organizationId?: string;
  }): Promise<void>;
  complete(params: CompleteParams): Promise<CompleteResult>;
  createDateTimeWaitpoint(params: CreateDateTimeWaitpointParams): Promise<CreateWaitpointResult>;
  createManualWaitpoint(params: CreateManualWaitpointParams): Promise<CreateWaitpointResult>;
  mintAssociatedWaitpointData(params: {
    projectId: string;
    environmentId: string;
    /** This write skips the router's stamp check. */
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
  /**
   * The run's organization, so a routing coordinator can skip MemoryDB for a run whose org could not
   * hold store edges. Only a routing coordinator reads it; the legacy coordinator ignores it.
   */
  organizationId?: string;
};

/**
 * One block edge, with the fields the unblock decision reads.
 *
 * `batchId` on child-result edges (those with a `batchIndex`) picks the batch that labels a
 * resumed run's results in `continueRunIfUnblocked`, so every implementation must return it.
 */
export type RunBlockEdge = {
  id: string;
  batchId: string | null;
  batchIndex: number | null;
  waitpoint: Pick<Waitpoint, "id" | "status" | "type" | "completedAfter">;
};

export type RegisterBlocksParams = {
  runId: string;
  organizationId?: string;
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

/**
 * Phase-1 inputs. The caller supplies the block-operation identity; the store never sources it by
 * reading and reusing whatever id is currently installed.
 */
export type AbsorbBlockersParams = {
  /** All requested IDs, before splitting them by store. */
  registrationWaitpointIds?: string[];
  runId: string;
  waitpointIds: string[];
  projectId: string;
  spanIdToComplete?: string;
  batchId?: string;
  batchIndex?: number;
  /**
   * The CALLER-OWNED block-operation identity: FRESH and stable per logical block cycle, RECOMPUTED
   * identically on a retry of the same operation, and captured WITH the operation — never re-derived from
   * whatever snapshot is latest when the operation runs. It is the CAS identity: a re-absorb under the
   * same id is an idempotent additive registration, a new id whose predecessor is named rolls the
   * previous cycle over, and a new id with a different predecessor installed is refused as stale.
   * REQUIRED for a store-format blocker (absent → fail loud); legacy ignores it.
   */
  blockId?: string;
  /**
   * The CALLER-OWNED contribution identity for THIS absorption: shared by retries of this exact additive
   * operation, fresh for a separate additive operation on the same block. It keys the durable contribution
   * record of which edges this operation actually inserted, so a failed mixed absorption compensates only
   * its own edges. REQUIRED for a store-format blocker (absent → fail loud); legacy ignores it.
   */
  absorptionId?: string;
  /**
   * The predecessor cycle this operation supersedes, for a rollover — captured with the operation, not
   * re-read at execution time, so a delayed replay carries its ORIGINAL expectation and the store's CAS
   * rejects it as stale rather than rolling over whatever is currently installed. Undefined for a first
   * block or a same-operation retry. Legacy ignores it.
   */
  expectedPreviousBlockId?: string;
  /**
   * The run's organization, carried onto the store watcher so the ASYNCHRONOUS fanout continuation can
   * route by the run's org without an extra lookup. Legacy ignores it.
   */
  organizationId?: string;
  /** Read client for the legacy pending re-count, resolved to `tx ?? prisma` by the caller. */
  client: ReadClient;
  /**
   * Optional compatibility hint from older callers. Parent snapshot residency does not gate registration.
   */
  parentResidency?: SnapshotResidency;
};

/**
 * Inputs to the durable resume-handoff acknowledgement. Called ONLY after TRES has durably accepted the
 * run's resume transition: the store marks the block's handoff acknowledged and drains its edges under
 * the block-id fence; legacy deletes the named edge rows. Never a substitute for terminal cleanup.
 */
export type AcknowledgeResumeParams = {
  runId: string;
  /**
   * The EXACT store block the continuation observed and is resuming, read once before the resume
   * transition. The store acknowledges and clears THAT block; if a newer cycle has since superseded it,
   * the acknowledgement is stale and a no-op, so the newer cycle is never cleared. Undefined for a
   * legacy-only run (no store block). Legacy ignores it.
   */
  blockId?: string;
  /** The edges the resume consumed. Omit to acknowledge without draining specific edges. */
  edgeIds?: string[];
  /** The run's org, so a routing coordinator can skip MemoryDB for a unmarked run. */
  organizationId?: string;
};

/** Context a run-keyed store-block read forwards, so a routing coordinator can skip a unmarked run. */
export type CurrentBlockContext = {
  organizationId?: string;
};

/**
 * Inputs to non-terminal retry/requeue cleanup. Runs AFTER the durable retry transition, outside the
 * Postgres transaction, so it never joins a rollback-capable tx. The store fences and abandons the old
 * block; legacy deletes the run's edge rows.
 */
export type AbandonRunBlockersParams = {
  runId: string;
  organizationId?: string;
  /**
   * The exact block to abandon. When set, the store abandons that block (active or resumed from its
   * retained withdrawal record) and never touches a different one; when omitted, the run's current block
   * is abandoned. A retry from the cleanup obligation always sets it.
   */
  blockId?: string;
  tx?: PrismaClientOrTransaction;
};

/**
 * Inputs to terminal/cancel cleanup. The store withdraws the run's watchers TERMINAL-FIRST (install the
 * terminal fence, then unregister), so an in-flight fanout delivery can never publish a resume for a run
 * being torn down. Legacy deletes the run's edge rows. Never deletes state before the lifecycle
 * transition — this IS the lifecycle transition's cleanup.
 */
export type ReleaseRunBlockersParams = {
  runId: string;
  reason: "cancelled" | "terminal";
  organizationId?: string;
  /**
   * The exact block to release. When set, the terminal-first withdrawal targets that block and never a
   * newer one; when omitted, the run's current block is released. A retry from the cleanup obligation and
   * the cancellation path set it.
   */
  blockId?: string;
  /**
   * A caller lifecycle transaction. A routing coordinator refuses it when the run might hold store
   * blockers — MemoryDB cannot join a Postgres transaction, so the store release must run after the
   * transition commits. Legacy joins it.
   */
  tx?: PrismaClientOrTransaction;
};

export type AbsorbBlockersResult = {
  /** Distinct-of-requested blockers still pending after absorb — gates the blocked TRES transition. */
  pendingCount: number;
  /** Opaque continuation for {@link WaitpointCoordinator.registerBlockers}. The caller does not read it. */
  registration: BlockerRegistration;
};

/**
 * A cached trace span a store completion durably closed. The store's async fanout and its synchronous
 * early delivery both emit this (independently of whole-run resumability), so a store completion finishes
 * the same cached spans the legacy inline path did. At-least-once; the emitted event must be idempotent.
 */
type CachedSpanCompletion = {
  spanId: string;
  spanCreatedAt: string;
  blockedRunId: string;
  hasError: boolean;
  cachedRunId?: string;
};

export type RegisterBlockersResult = {
  /** Distinct-of-requested pending AFTER registration and early delivery. 0 ⇒ the run is resumable. */
  pendingCount: number;
  /** Cached spans closed by an early/racing delivery during THIS registration, for the caller to emit. */
  cachedSpanCompletions?: CachedSpanCompletion[];
};

/** One run→waitpoint edge as the store block protocol records it. A plain shape, no store-internal types. */
export type StoreBlockEdge = {
  waitpointId: string;
  batchIndex?: number | null;
  batchId?: string;
  spanIdToComplete?: string;
  createdAt: string;
  type: WaitpointMintType;
  completedAfter?: string;
};

/**
 * The store variant of the opaque block continuation. Produced and consumed only by the store adapter;
 * `completion` and `supersededCleanup` are typed `unknown` so store-internal envelope types never leak
 * into this contract layer — the adapter casts them back.
 */
export type StoreBlockerRegistration = {
  kind: "store";
  registrationEvidence: string;
  runId: string;
  blockId: string;
  /** Keep this operation ID through phase 3 and the caller's follow-up work. */
  absorptionId: string;
  /** Carried onto each watcher so the asynchronous fanout continuation routes by the run's org. */
  organizationId?: string;
  edges: StoreBlockEdge[];
  storePendingTotal: number;
  alreadyDelivered: Array<{ waitpointId: string; completion?: unknown }>;
  supersededCleanup?: unknown;
};

/**
 * The opaque continuation threaded from {@link WaitpointCoordinator.absorbBlockers} to
 * {@link WaitpointCoordinator.registerBlockers}. `noop` is legacy (nothing to register; the edge write
 * and pending count already happened in absorb). `routing` wraps the per-coordinator parts a routing
 * layer absorbed. Each coordinator only ever registers a continuation it produced.
 */
export type BlockerRegistration =
  | { kind: "noop"; pendingCount: number }
  | StoreBlockerRegistration
  | { kind: "routing"; parts: BlockerRegistration[] };

export type CompleteParams = RunKeyedRoutingContext & {
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
  /**
   * Co-locates the waitpoint with this run's DB. There is deliberately no standalone arm: omitting
   * it on a gen-2 environment lands the row on a gen-1 store, silently. A standalone caller needs
   * a shard hint here first, as `CreateManualWaitpointParams` has.
   */
  runId?: string;
  projectId: string;
  environmentId: string;
  completedAfter: Date;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  /** Optional mint-residency inputs. Absent = legacy (the dark default). Only a routing coordinator reads it. */
  mintContext?: WaitpointMintContext;
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
  /** For a standalone token. When it names a gen-2 shard, ignore `standaloneResidency`. */
  standaloneShardKey?: ShardKey;
  /** Optional mint-residency inputs. Absent = legacy (the dark default). Only a routing coordinator reads it. */
  mintContext?: WaitpointMintContext;
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
