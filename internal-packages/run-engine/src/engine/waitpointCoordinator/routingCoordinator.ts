import { deriveRunWaitpointId } from "./runWaitpointId.js";
import type { Logger } from "@trigger.dev/core/logger";
import type { PrismaClientOrTransaction, Waitpoint } from "@trigger.dev/database";
import {
  StoreAbsorptionCompensationFailed,
  StoreWaitpointBlockOperationIdentityRequired,
  StoreWaitpointRegistrationUnsupported,
  StoreWaitpointWithoutStoreCoordinator,
  TransactionalStoreClearUnsupported,
} from "../errors.js";
import {
  decideWaitpointResidency,
  type WaitpointMintMode,
  type WaitpointMintType,
  type WaitpointResidency,
} from "./mintPolicy.js";
import { classifyWaitpointCoordinator, partitionByResidency } from "./routing.js";
import type {
  AbandonRunBlockersParams,
  AbsorbBlockersParams,
  AbsorbedBlockersParams,
  AbsorbBlockersResult,
  AcknowledgeResumeParams,
  PrepareWaitpointResumeParams,
  WaitpointResumeIntent,
  AssociatedWaitpointData,
  AssociatedWaitpointPlan,
  BlockerRegistration,
  ClearRunBlockStateParams,
  CurrentBlockContext,
  ReleaseRunBlockersParams,
  CompleteParams,
  CompleteResult,
  CreateDateTimeWaitpointParams,
  CreateManualWaitpointParams,
  CreateBatchWaitpointParams,
  CreateWaitpointResult,
  RegisterBlockersResult,
  RegisterBlocksLocklessParams,
  RegisterBlocksParams,
  RunBlockEdge,
  RunKeyedRoutingContext,
  WaitpointCoordinator,
  WaitpointMintContext,
} from "./types.js";

/** Identity passed to the durable per-run waitpoint storage reader. */
export type WaitpointRunKey = RunKeyedRoutingContext & { runId: string };

export type RoutingWaitpointCoordinatorMintPolicy = {
  /** The mint residency permitted by the organization's `waitpointStoreEnabled` flag. Never consulted for an existing id — only at mint. */
  resolveMintMode: (
    organizationId: string | undefined
  ) => WaitpointMintMode | Promise<WaitpointMintMode>;
  /** The shared MemoryDB waitpoint capability readiness for the current application-version mix. */
  isCapabilityReady: () => boolean;
  /** Default eligibility, overridable per mint via the mint context. */
  eligibleTypes?: ReadonlySet<WaitpointMintType>;
};

export type RoutingWaitpointCoordinatorOptions = {
  legacy: WaitpointCoordinator;
  /**
   * The MemoryDB coordinator. Undefined retains the original Postgres path without classifying
   * identities. Turning routing off intentionally restores that path, including its errors.
   */
  store?: WaitpointCoordinator;
  mintPolicy: RoutingWaitpointCoordinatorMintPolicy;
  /** Checked before run discovery. Disabled organizations never consult the marker or store. */
  isStoreEnabled?: (organizationId: string | undefined) => boolean | Promise<boolean>;
  /**
   * Read the individual run's durable waitpoint storage marker. Never derive this from its org's
   * current or historical enrollment. False skips MemoryDB; unavailable/missing readers are conservative.
   */
  mightHaveStoreBlockers?: (runKey: WaitpointRunKey) => boolean | Promise<boolean>;
  /** Persist the run marker BEFORE the first store mutation; failure must abort the operation. */
  markStoreWaitpoints?: (runId: string, organizationId?: string) => Promise<void>;
  /** Serialize marked parents' lockless legacy writes with their cross-store cleanup. */
  withLegacyRegistrationLock?: <T>(runId: string, operation: () => Promise<T>) => Promise<T>;
  logger?: Logger;
};

/**
 * Routes every waitpoint operation to its owning coordinator by the id's shape, and selects the
 * residency of a NEW waitpoint from the pure mint policy. The two guarantees it enforces structurally:
 *
 *  - When routing is enabled, a recognised store-format id never reaches Postgres — not on read, complete, absence, timeout,
 *    connection failure, or ambiguity — because there is no catch that re-routes to legacy.
 *  - Store-format registration is refused before any write: it is a three-step barrier (absorb →
 *    publish blocked transition → register/deliver) the single-call seam cannot express, owned by the
 *    blocker-registration migration. Legacy registration is unaffected.
 *  - Run-keyed reads and clears consult MemoryDB only when the run could hold store edges, and run the
 *    two stores concurrently when both are needed. A transaction-bound clear of a run that may hold
 *    store edges fails loud before any mutation: MemoryDB cannot join the Postgres transaction, so
 *    activation must clear MemoryDB only after the durable lifecycle transition commits.
 */
export class RoutingWaitpointCoordinator implements WaitpointCoordinator {
  readonly #legacy: WaitpointCoordinator;
  readonly #store: WaitpointCoordinator | undefined;
  readonly #markStoreWaitpoints?: (runId: string, organizationId?: string) => Promise<void>;
  readonly #withLegacyRegistrationLock?: RoutingWaitpointCoordinatorOptions["withLegacyRegistrationLock"];
  readonly #mintPolicy: RoutingWaitpointCoordinatorMintPolicy;
  readonly #isStoreEnabled?: RoutingWaitpointCoordinatorOptions["isStoreEnabled"];
  readonly #mightHaveStoreBlockers?: (runKey: WaitpointRunKey) => boolean | Promise<boolean>;

  constructor(options: RoutingWaitpointCoordinatorOptions) {
    this.#legacy = options.legacy;
    this.#store = options.store;
    this.#mintPolicy = options.mintPolicy;
    this.#markStoreWaitpoints = options.markStoreWaitpoints;
    this.#withLegacyRegistrationLock = options.withLegacyRegistrationLock;
    this.#isStoreEnabled = options.isStoreEnabled;
    this.#mightHaveStoreBlockers = options.mightHaveStoreBlockers;
  }

  async isStoreRoutingEnabled(organizationId?: string): Promise<boolean> {
    return (
      this.#store !== undefined &&
      (!this.#isStoreEnabled || (await this.#isStoreEnabled(organizationId)))
    );
  }

  // Only called after the capability and organization gate. Enabled store identities must never
  // silently become a Postgres lookup.
  #coordinatorForId(id: string): WaitpointCoordinator {
    if (classifyWaitpointCoordinator(id) === "store") {
      if (!this.#store) {
        throw new StoreWaitpointWithoutStoreCoordinator(id);
      }
      return this.#store;
    }
    return this.#legacy;
  }

  async #decideMintResidency(
    waitpointType: WaitpointMintType,
    mintContext: WaitpointMintContext | undefined
  ): Promise<WaitpointResidency> {
    // No store client or no mint context means legacy — the dark production default. The org setting
    // and capability are not even consulted, so a never-enabled deployment makes no store call.
    if (!mintContext || !(await this.isStoreRoutingEnabled(mintContext.organizationId))) {
      return "legacy";
    }

    const mintMode = await this.#mintPolicy.resolveMintMode(mintContext.organizationId);
    const decision = decideWaitpointResidency({
      mintMode,
      waitpointType,
      capabilityReady: this.#mintPolicy.isCapabilityReady(),
      eligibleTypes: mintContext.eligibleTypes ?? this.#mintPolicy.eligibleTypes,
    });
    return decision.residency;
  }

  // Native absorption validates wiring and block identity independently of parent TRES residency.
  // The registration guard, shared by both register paths. Fails loud BEFORE any write and returns
  // only the legacy subset — store-format registration is a three-step barrier the single-call seam
  // cannot express (see StoreWaitpointRegistrationUnsupported), so it is refused here rather than
  // silently registered wholly before the transition. This barrier is independent of snapshot residency.
  #legacyRegistrationSubset(
    params: Pick<RegisterBlocksParams, "runId" | "waitpointIds">
  ): string[] {
    const partition = partitionByResidency(params.waitpointIds, (id) => id);
    const storeIds = partition.store.map((e) => e.item);

    if (storeIds.length > 0) {
      if (!this.#store) {
        throw new StoreWaitpointWithoutStoreCoordinator(storeIds[0]!);
      }
      throw new StoreWaitpointRegistrationUnsupported({
        runId: params.runId,
        waitpointIds: storeIds,
      });
    }

    return partition.legacy.map((e) => e.item);
  }

  // Whether a run-keyed read/clear must consult MemoryDB. With no store or a disabled org, never.
  // Once enabled, the caller's
  // durable per-run marker decides; absent OR throwing, it is conservative (consult the store),
  // so a routing-state failure can never produce a false negative that loses store edges.
  async #runMightHaveStoreBlockers(runKey: WaitpointRunKey): Promise<boolean> {
    if (!(await this.isStoreRoutingEnabled(runKey.organizationId))) return false;
    if (!this.#mightHaveStoreBlockers) return true;
    try {
      return await this.#mightHaveStoreBlockers(runKey);
    } catch {
      return true;
    }
  }

  async clearRunBlockState(params: ClearRunBlockStateParams): Promise<{ count: number }> {
    // A run's block edges can span both coordinators, and edge ids are not waitpoint-shaped, so both
    // are cleared when the run could hold store edges — concurrently, since they touch different stores.
    // A run without store state skips MemoryDB entirely, keeping today's behaviour (legacy call, tx included).
    if (
      !(await this.#runMightHaveStoreBlockers({
        runId: params.runId,
        organizationId: params.organizationId,
      }))
    ) {
      // Unmarked / no store: legacy only, and the caller's tx joins the single-store clear.
      return this.#legacy.clearRunBlockState(params);
    }
    // The run may hold MemoryDB blockers. A clear bound to a rollback-capable Postgres lifecycle
    // transaction cannot span MemoryDB, so a clear-then-rollback would destroy store blockers with
    // Postgres intact. Fail loud BEFORE either store is mutated; activation clears MemoryDB only after
    // the durable transition (a non-transactional clear, which reaches both stores below).
    if (params.tx) {
      throw new TransactionalStoreClearUnsupported(params.runId);
    }
    const [legacyResult, storeResult] = await Promise.all([
      this.#legacy.clearRunBlockState(params),
      this.#store!.clearRunBlockState(params),
    ]);
    return { count: legacyResult.count + storeResult.count };
  }

  async currentStoreBlockId(
    runId: string,
    context?: CurrentBlockContext
  ): Promise<string | undefined> {
    if (
      !(await this.#runMightHaveStoreBlockers({ runId, organizationId: context?.organizationId }))
    ) {
      return undefined;
    }
    return this.#store!.currentStoreBlockId(runId, context);
  }

  async abandonRunBlockers(params: AbandonRunBlockersParams): Promise<{ count: number }> {
    if (
      !(await this.#runMightHaveStoreBlockers({
        runId: params.runId,
        organizationId: params.organizationId,
      }))
    ) {
      return this.#legacy.abandonRunBlockers(params);
    }
    // Like releaseRunBlockers: the store abandon cannot join a Postgres transaction, so a run that may
    // hold store blockers is abandoned only AFTER the durable retry transition, never inside its tx.
    if (params.tx) {
      throw new TransactionalStoreClearUnsupported(params.runId);
    }
    // SEQUENCED, legacy FIRST: delete this cycle's legacy edges, then atomically clear+withdraw the store
    // block. Load-bearing — if the legacy delete fails the store block stays active and the obligation can
    // retry the whole initial cleanup safely; once the store block is atomically cleared into its retained
    // withdrawal record, legacy is already gone.
    const legacyResult = await this.#legacy.abandonRunBlockers(params);
    const storeResult = await this.#store!.abandonRunBlockers(params);
    return { count: legacyResult.count + storeResult.count };
  }

  async resumeRetainedWithdrawal(params: {
    runId: string;
    blockId: string;
    organizationId?: string;
  }): Promise<{ count: number }> {
    // Store-only by contract: a delayed obligation whose block is no longer current must never reach the
    // legacy coordinator (its block-id-less delete would drop a newer block's edges).
    if (
      !(await this.#runMightHaveStoreBlockers({
        runId: params.runId,
        organizationId: params.organizationId,
      }))
    ) {
      return { count: 0 };
    }
    return this.#store!.resumeRetainedWithdrawal(params);
  }

  async prepareResume(
    params: PrepareWaitpointResumeParams
  ): Promise<WaitpointResumeIntent | undefined> {
    if (!(await this.#runMightHaveStoreBlockers(params))) return undefined;
    return this.#store!.prepareResume(params);
  }

  async readResumeIntent(
    runId: string,
    context?: RunKeyedRoutingContext
  ): Promise<WaitpointResumeIntent | undefined> {
    if (
      !(await this.#runMightHaveStoreBlockers({ runId, organizationId: context?.organizationId }))
    )
      return undefined;
    return this.#store!.readResumeIntent(runId, context);
  }

  async acknowledgeResume(params: AcknowledgeResumeParams): Promise<void> {
    // Unmarked runs use only Postgres. Marked runs retain proof until both stores acknowledge.
    if (
      !(await this.#runMightHaveStoreBlockers({
        runId: params.runId,
        organizationId: params.organizationId,
      }))
    ) {
      await this.#legacy.acknowledgeResume(params);
      return;
    }
    // Keep MemoryDB's resume proof until the Postgres delete has committed.
    await this.#legacy.acknowledgeResume(params);
    await this.#store!.acknowledgeResume(params);
  }

  async releaseRunBlockers(params: ReleaseRunBlockersParams): Promise<{ count: number }> {
    if (
      !(await this.#runMightHaveStoreBlockers({
        runId: params.runId,
        organizationId: params.organizationId,
      }))
    ) {
      // Unmarked / no store: legacy only, and the caller's tx joins the single-store delete.
      return this.#legacy.releaseRunBlockers(params);
    }
    // The store's terminal-first release cannot join a Postgres transaction, so a run that may hold
    // store blockers must be released AFTER the lifecycle transition commits — never inside its tx.
    if (params.tx) {
      throw new TransactionalStoreClearUnsupported(params.runId);
    }
    // ORDERED, store FIRST: terminalize the exact block and finish its retained withdrawal (the store
    // adapter is replay-safe — it finishes an already-terminalized block's retained withdrawal), THEN
    // delete the Postgres edges. On a partial failure the whole call rejects and the obligation replays:
    // the store half converges (or no-ops) and the legacy delete is retried, so a legacy failure after a
    // successful store terminalization can never strand the Postgres edges. Never concurrent — a store
    // success + legacy failure under Promise.all cleared the block and dropped the legacy retry.
    const storeResult = await this.#store!.releaseRunBlockers(params);
    const legacyResult = await this.#legacy.releaseRunBlockers(params);
    return { count: legacyResult.count + storeResult.count };
  }

  async armCleanupFence(params: {
    runId: string;
    blockId: string;
    organizationId?: string;
  }): Promise<void> {
    // Store-only, and only for a run that may hold store blockers: a unmarked run has no store block
    // to fence and reaches nothing here (no MemoryDB write on the dark path).
    if (
      !(await this.#runMightHaveStoreBlockers({
        runId: params.runId,
        organizationId: params.organizationId,
      }))
    ) {
      return;
    }
    await this.#store!.armCleanupFence(params);
  }

  async assertNoCleanupOwed(runId: string, context?: RunKeyedRoutingContext): Promise<void> {
    if (await this.#runMightHaveStoreBlockers({ runId, organizationId: context?.organizationId })) {
      await this.#store!.assertNoCleanupOwed(runId);
    }
  }

  async clearLegacyBlockersBeforeTransition(params: {
    runId: string;
    organizationId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<{ count: number }> {
    // Unconditional legacy edge delete in the caller's tx. The DECISION to call this (only when the run has
    // no current store block) is made once, per-run, by the caller, so a legacy-only run is still
    // pre-cleared even when other runs in its org use MemoryDB. Store side never
    // touched here.
    return this.#legacy.clearLegacyBlockersBeforeTransition(params);
  }

  async compensateAbsorption(params: {
    runId: string;
    blockId: string;
    absorptionId: string;
    /** Recovery may discard only preparation for this request, never an accepted operation. */
    unacceptedEvidence?: string;
    organizationId?: string;
  }): Promise<void> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) return;
    // Store-only concern: the failed mixed absorption's legacy half wrote nothing (store went first).
    await this.#store!.compensateAbsorption(params);
  }

  async readRunBlockState(
    runId: string,
    context?: RunKeyedRoutingContext
  ): Promise<RunBlockEdge[]> {
    if (
      !(await this.#runMightHaveStoreBlockers({
        runId,
        organizationId: context?.organizationId,
      }))
    ) {
      return this.#legacy.readRunBlockState(runId, context);
    }
    const [legacyEdges, storeEdges] = await Promise.all([
      this.#legacy.readRunBlockState(runId, context),
      this.#store!.readRunBlockState(runId, context),
    ]);
    return [...legacyEdges, ...storeEdges];
  }

  async registerBlocks(params: RegisterBlocksParams): Promise<{ pendingCount: number }> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      return this.#legacy.registerBlocks(params);
    }
    // Store-format blockers are refused inside the guard; only legacy ids reach a write.
    const legacyIds = this.#legacyRegistrationSubset(params);
    if (legacyIds.length === 0) {
      return { pendingCount: 0 };
    }
    await this.assertNoCleanupOwed(params.runId, params);
    return this.#legacy.registerBlocks({ ...params, waitpointIds: legacyIds });
  }

  async registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      return this.#legacy.registerBlocksLockless(params);
    }
    const legacyIds = this.#legacyRegistrationSubset(params);
    if (legacyIds.length === 0) return;
    await this.withLegacyRegistrationLock(params.runId, params, () =>
      this.#legacy.registerBlocksLockless({ ...params, waitpointIds: legacyIds })
    );
  }

  /** Guard a legacy registration's preparation and write with the existing cleanup run lock. */
  async withLegacyRegistrationLock<T>(
    runId: string,
    context: RunKeyedRoutingContext | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    if (
      !this.#store ||
      (this.#isStoreEnabled && !(await this.#isStoreEnabled(context?.organizationId)))
    ) {
      return operation();
    }
    if (!this.#withLegacyRegistrationLock) {
      throw new Error("Enabled legacy registration requires the run lock");
    }
    return this.#withLegacyRegistrationLock(runId, async () => {
      // The marker is monotonic but can change from false to true when the first native wait
      // joins. Decide under the parent lock too, so a stale false cannot authorize child creation
      // across that first block's retry cleanup. Unmarked parents still never read MemoryDB.
      await this.assertNoCleanupOwed(runId, context);
      return operation();
    });
  }

  // Validate wiring and caller-owned block identity before either coordinator is mutated.
  // Parent snapshot residency is independent of a shared waitpoint's storage home.
  #assertStoreBlockersEligible(
    runId: string,
    storeIds: string[],
    blockId: string | undefined
  ): void {
    if (storeIds.length === 0) {
      return;
    }
    if (!this.#store) {
      throw new StoreWaitpointWithoutStoreCoordinator(storeIds[0]!);
    }
    // A store block operation must carry a caller-owned identity — re-deriving it here from run state
    // could not fence a delayed operation from an older cycle. Fail loud before any mutation.
    if (!blockId) {
      throw new StoreWaitpointBlockOperationIdentityRequired({ runId, waitpointIds: storeIds });
    }
  }

  async finalizeBlockers(params: AbsorbedBlockersParams): Promise<void> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) return;
    await this.#store!.finalizeBlockers(params);
  }

  async hasAbsorbedBlockers(params: AbsorbedBlockersParams): Promise<boolean> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) return false;
    return this.#store!.hasAbsorbedBlockers(params);
  }

  async absorbBlockers(params: AbsorbBlockersParams): Promise<AbsorbBlockersResult> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      return this.#legacy.absorbBlockers(params);
    }
    const partition = partitionByResidency(params.waitpointIds, (id) => id);
    const legacyIds = partition.legacy.map((e) => e.item);
    const storeIds = partition.store.map((e) => e.item);

    const hasStoreAdmission = storeIds.length > 0 || !!params.requirePendingWaitpointId;
    this.#assertStoreBlockersEligible(
      params.runId,
      storeIds.length
        ? storeIds
        : params.requirePendingWaitpointId
          ? [params.requirePendingWaitpointId]
          : [],
      params.blockId
    );

    // Native/mixed absorption checks the fence atomically in its store CAS. Legacy-only writes
    // need the same admission barrier before Postgres can accept a later attempt's edges.
    if (storeIds.length === 0 && legacyIds.length > 0) {
      await this.assertNoCleanupOwed(params.runId, params);
    }

    // Commit the discovery marker first. A crash after it leaves only a harmless extra lookup;
    // a crash after absorption can never leave Redis edges hidden from a restarted/rolled-back process.
    if (hasStoreAdmission) await this.#markStoreWaitpoints?.(params.runId, params.organizationId);

    // Store CAS FIRST, then legacy — the two mutating absorptions never run concurrently. A stale/refused
    // store operation throws here BEFORE any legacy edge is written. It cannot change the active store
    // block or register watchers, but may finish an already-retained predecessor withdrawal. Legacy
    // edges are written only after the store half is durably accepted.
    // A native batch also guards a reused PG child before its legacy edge is written.
    // Even zero-native-edge admissions retain exact request proof until tail work finishes.
    const storeResult = hasStoreAdmission
      ? await this.#store!.absorbBlockers({
          ...params,
          waitpointIds: storeIds,
          registrationWaitpointIds: params.waitpointIds,
        })
      : undefined;

    let legacyResult: AbsorbBlockersResult | undefined;
    try {
      legacyResult =
        legacyIds.length > 0
          ? await this.#legacy.absorbBlockers({ ...params, waitpointIds: legacyIds })
          : undefined;
    } catch (legacyError) {
      // Store accepted but legacy failed: compensate ONLY this invocation's store contribution, fenced by
      // the block id and the exact edges just contributed, so an earlier additive call's blockers on the
      // same block and any early-delivery receipts survive. If compensation itself fails, surface the
      // exact fenced targets so the caller arms a durable retry — never report clean while leaving residue.
      if (storeResult) {
        try {
          await this.#store!.compensateAbsorption({
            runId: params.runId,
            blockId: params.blockId!,
            absorptionId: params.absorptionId!,
            organizationId: params.organizationId,
          });
        } catch (compensationError) {
          throw new StoreAbsorptionCompensationFailed({
            runId: params.runId,
            blockId: params.blockId!,
            absorptionId: params.absorptionId!,
            cause: compensationError,
          });
        }
      }
      throw legacyError;
    }

    const parts: BlockerRegistration[] = [];
    let pendingCount = 0;
    if (legacyResult) {
      parts.push(legacyResult.registration);
      pendingCount += legacyResult.pendingCount;
    }
    if (storeResult) {
      parts.push(storeResult.registration);
      pendingCount += storeResult.pendingCount;
    }

    return { pendingCount, registration: { kind: "routing", parts } };
  }

  async registerBlockers(registration: BlockerRegistration): Promise<RegisterBlockersResult> {
    if (registration.kind === "noop") return this.#legacy.registerBlockers(registration);
    if (registration.kind !== "routing") {
      throw new Error(
        `RoutingWaitpointCoordinator.registerBlockers received a ${registration.kind} continuation`
      );
    }

    // Validate every store part before dispatching either store or legacy mutations.
    for (const part of registration.parts) {
      if (
        part.kind === "store" &&
        this.#isStoreEnabled &&
        !(await this.#isStoreEnabled(part.organizationId))
      ) {
        throw new Error("Store waitpoint registration is disabled for this organization");
      }
    }

    // Dispatch each part to the coordinator that produced it, concurrently: `noop` is the legacy half,
    // `store` the MemoryDB half. Their pending counts sum to the run's post-registration pending set.
    const results = await Promise.all(
      registration.parts.map((part) =>
        part.kind === "store"
          ? this.#store!.registerBlockers(part)
          : this.#legacy.registerBlockers(part)
      )
    );

    return {
      pendingCount: results.reduce((sum, r) => sum + r.pendingCount, 0),
      cachedSpanCompletions: results.flatMap((r) => r.cachedSpanCompletions ?? []),
    };
  }

  async complete(params: CompleteParams): Promise<CompleteResult> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      return this.#legacy.complete(params);
    }
    return this.#coordinatorForId(params.waitpointId).complete(params);
  }

  /** Resolve operation routing before a caller acquires a bounded PG connection. */
  async dateTimeCreationCoordinator(mintContext: WaitpointMintContext | undefined) {
    return (await this.#decideMintResidency("DATETIME", mintContext)) === "store"
      ? this.#store!
      : this.#legacy;
  }

  async createDateTimeWaitpoint(
    params: CreateDateTimeWaitpointParams
  ): Promise<CreateWaitpointResult> {
    const residency = await this.#decideMintResidency("DATETIME", params.mintContext);
    return residency === "store"
      ? this.#store!.createDateTimeWaitpoint(params)
      : this.#legacy.createDateTimeWaitpoint(params);
  }

  async manualCreationCoordinator(
    mintContext?: WaitpointMintContext
  ): Promise<WaitpointCoordinator> {
    return (await this.#decideMintResidency("MANUAL", mintContext)) === "store"
      ? this.#store!
      : this.#legacy;
  }
  async canCreateNativeBatch(organizationId: string): Promise<boolean> {
    return (
      (await this.#decideMintResidency("BATCH", {
        organizationId,
        eligibleTypes: new Set(["BATCH"]),
      })) === "store"
    );
  }
  async createBatchWaitpoint(params: CreateBatchWaitpointParams): Promise<CreateWaitpointResult> {
    const owner =
      (await this.#decideMintResidency("BATCH", params.mintContext)) === "store"
        ? this.#store!
        : this.#legacy;
    if (params.requireStore && owner === this.#legacy)
      throw new Error("Native BATCH waitpoint creation is disabled");
    return owner.createBatchWaitpoint(params);
  }
  async createManualWaitpoint(params: CreateManualWaitpointParams): Promise<CreateWaitpointResult> {
    const residency = await this.#decideMintResidency("MANUAL", params.mintContext);
    return residency === "store"
      ? this.#store!.createManualWaitpoint(params)
      : this.#legacy.createManualWaitpoint(params);
  }

  mintAssociatedWaitpointData(params: {
    projectId: string;
    environmentId: string;
    anchorRunId: string;
  }): AssociatedWaitpointData {
    // The synchronous builder is legacy-only: a store RUN mint has no Postgres row to inline and must
    // create after the child commits, so it goes through the async `planAssociatedWaitpoint` instead.
    return this.#legacy.mintAssociatedWaitpointData(params);
  }

  async planAssociatedWaitpoint(params: {
    projectId: string;
    environmentId: string;
    anchorRunId: string;
    mintContext?: WaitpointMintContext;
  }): Promise<AssociatedWaitpointPlan> {
    // Check the rollout before deriving an identity, so disabled creation does no native work.
    // Both run-ops and CUID children retain their existing TaskRun placement.
    const selected = await this.#decideMintResidency("RUN", params.mintContext);
    const residency =
      selected === "store" && deriveRunWaitpointId(params.anchorRunId) ? "store" : "legacy";
    const coordinator = residency === "store" ? this.#store! : this.#legacy;
    return {
      residency,
      data: coordinator.mintAssociatedWaitpointData({
        projectId: params.projectId,
        environmentId: params.environmentId,
        anchorRunId: params.anchorRunId,
      }),
    };
  }

  async createAssociatedWaitpoint(params: {
    runId: string;
    data: AssociatedWaitpointData;
    organizationId?: string;
    requireStore?: boolean;
  }): Promise<Waitpoint> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      if (params.requireStore) {
        throw new Error("Existing store waitpoint association is disabled for this organization");
      }
      return this.#legacy.createAssociatedWaitpoint(params);
    }
    // Check ownership before writing the marker; a missing store must fail without a mutation.
    const coordinator = this.#coordinatorForId(params.data.id);
    if (classifyWaitpointCoordinator(params.data.id) === "store") {
      await this.#markStoreWaitpoints?.(params.runId, params.organizationId);
    }
    return coordinator.createAssociatedWaitpoint(params);
  }

  // Association discovery uses the child's durable storage marker, regardless of the current org
  // flag. A Redis error throws rather than pretending the association is absent.
  async findAssociatedRunWaitpointId(
    runId: string,
    context?: RunKeyedRoutingContext
  ): Promise<string | undefined> {
    if (
      !(await this.#runMightHaveStoreBlockers({ runId, organizationId: context?.organizationId }))
    ) {
      return undefined;
    }
    return this.#store!.findAssociatedRunWaitpointId(runId, context);
  }

  async readAssociatedRunWaitpoint(
    runId: string,
    context?: RunKeyedRoutingContext
  ): Promise<Waitpoint | undefined> {
    if (
      !(await this.#runMightHaveStoreBlockers({ runId, organizationId: context?.organizationId }))
    ) {
      return undefined;
    }
    return this.#store!.readAssociatedRunWaitpoint(runId, context);
  }
}
