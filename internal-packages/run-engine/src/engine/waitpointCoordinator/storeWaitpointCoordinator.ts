import { deriveRunWaitpointId, deriveBatchWaitpointId } from "./runWaitpointId.js";
import {
  generateWaitpointId,
  parseWaitpointId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import type { Waitpoint } from "@trigger.dev/database";
import pMap from "p-map";
import {
  StoreWaitpointBlockOperationIdentityRequired,
  StoreWaitpointRegistrationUnsupported,
} from "../errors.js";
import { parseEdgeField, idempotencyReceiptKey, registrationEvidence } from "./keys.js";
import {
  WaitpointNotFoundError,
  type AbsorbResult,
  type BlockEdge,
  type WaitpointCompletion,
  type WaitpointRecordInput,
  type WaitpointStoredRecord,
  type WaitpointStoreCoordinator,
} from "./storeCoordinator.js";
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
  StoreBlockEdge,
  StoreBlockerRegistration,
  WaitpointCoordinator,
} from "./types.js";

// Limit concurrent watcher removals to avoid a burst of Redis commands.
const ABANDON_UNREGISTER_CONCURRENCY = 10;

/**
 * Reject registration if the run has moved to another block or has completed cleanup.
 * Neither case can add watchers.
 */
export class StoreWaitpointBlockRefusedError extends Error {
  readonly runId: string;
  readonly outcome: "stale" | "terminal" | "cleanupOwed" | "ownerGone";
  readonly currentBlockId?: string;
  constructor(params: {
    runId: string;
    outcome: "stale" | "terminal" | "cleanupOwed" | "ownerGone";
    currentBlockId?: string;
  }) {
    super(
      `Store block absorption for run ${params.runId} was refused as ${params.outcome}` +
        (params.currentBlockId ? ` (current block ${params.currentBlockId})` : "")
    );
    this.name = "StoreWaitpointBlockRefusedError";
    this.runId = params.runId;
    this.outcome = params.outcome;
    this.currentBlockId = params.currentBlockId;
  }
}

export type StoreWaitpointCoordinatorOptions = {
  store: WaitpointStoreCoordinator;
  /** Injectable so a test can pin edge timestamps. Defaults to Date.now. */
  clock?: () => number;
};

/**
 * Adapt MemoryDB waitpoints to the {@link WaitpointCoordinator} interface.
 * Creation follows the routing coordinator's residency decision.
 * Never route a MemoryDB ID to Postgres.
 *
 * Register waits in three phases:
 * 1. {@link absorbBlockers}: record waits and completed results under the caller's block ID.
 * 2. The caller saves the blocked snapshot.
 * 3. {@link registerBlockers}: add watchers and deliver completed results.
 *
 * Keep the caller's block ID unchanged so Redis can reject retries from an old cycle.
 */
export class StoreWaitpointCoordinator implements WaitpointCoordinator {
  readonly #store: WaitpointStoreCoordinator;
  readonly #clock: () => number;

  constructor(options: StoreWaitpointCoordinatorOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? Date.now;
  }

  // ---- Block protocol -------------------------------------------------------

  async finalizeBlockers(params: AbsorbedBlockersParams): Promise<void> {
    await this.#store.deleteContribution(params);
  }

  async hasAbsorbedBlockers(params: AbsorbedBlockersParams): Promise<boolean> {
    return this.#store.hasAbsorbedBlockers(params);
  }

  async absorbBlockers(params: AbsorbBlockersParams): Promise<AbsorbBlockersResult> {
    // Require the caller's block identity to reject old operations.
    // Check direct calls as well as calls through the router.
    if (!params.blockId || !params.absorptionId) {
      throw new StoreWaitpointBlockOperationIdentityRequired({
        runId: params.runId,
        waitpointIds: params.waitpointIds,
      });
    }
    const blockId = params.blockId;
    const absorptionId = params.absorptionId;
    const evidence = registrationEvidence(
      params.registrationWaitpointIds ?? params.waitpointIds,
      params.batchIndex
    );
    const edges = this.#buildEdges(params);
    // Read completed results before creating the block. On retry, use retained results first.
    // Save the results with the block in one atomic operation.
    // Source expiry must not leave an active block without its result.
    if (!params.organizationId)
      throw new Error("Native absorption requires trusted organization ownership");
    await this.#store.publishRunOwnership(params.runId, params.organizationId);
    try {
      await this.#store.prepareRegistrationSources({
        runId: params.runId,
        blockId,
        absorptionId,
        waitpointIds: params.waitpointIds,
        evidence,
        expectedPreviousBlockId: params.expectedPreviousBlockId,
      });
      const sources = await this.#store.readCompletedRecords(params.waitpointIds, params.runId);
      const reportedEdges: BlockEdge[] = edges.map((edge) => {
        const source = sources.get(edge.waitpointId);
        if (!source) throw new WaitpointNotFoundError(edge.waitpointId);
        edge.completedAfter = source.record.completedAfter;
        return source.status === "COMPLETED" && source.completion
          ? {
              ...edge,
              reported: { completion: { ...source.completion, record: source.record } },
            }
          : edge;
      });

      // Pass the caller's block ID and expected previous ID unchanged.
      // If Redis rejects the block as stale or terminal, do not register watchers.
      const absorbed = await this.#store.absorbBlockers({
        runId: params.runId,
        blockId,
        edges: reportedEdges,
        registrationEvidence: evidence,
        batchIndex: params.batchIndex,
        expectedPreviousBlockId: params.expectedPreviousBlockId,
        absorptionId,
        requirePendingWaitpointId: params.requirePendingWaitpointId,
      });

      if (absorbed.outcome !== "absorbed") {
        throw new StoreWaitpointBlockRefusedError({
          runId: params.runId,
          outcome: absorbed.outcome,
          currentBlockId: absorbed.currentBlockId,
        });
      }

      const registration: StoreBlockerRegistration = {
        kind: "store",
        registrationEvidence: evidence,
        runId: params.runId,
        blockId,
        absorptionId,
        organizationId: params.organizationId,
        edges,
        storePendingTotal: absorbed.storePendingTotal,
        alreadyDelivered: absorbed.alreadyDelivered,
        supersededCleanup: absorbed.supersededCleanup,
      };

      return { pendingCount: absorbed.pendingOfRequested, registration };
    } catch (error) {
      // Failed preparation has no accepted block; release its source holds immediately.
      // If cleanup fails too, the prearmed recovery job retains the indexed targets.
      await this.#store.compensateAbsorption({
        runId: params.runId,
        blockId,
        absorptionId,
        unacceptedEvidence: evidence,
      });
      throw error;
    }
  }

  #buildEdges(params: AbsorbBlockersParams): StoreBlockEdge[] {
    const nowIso = new Date(this.#clock()).toISOString();
    return params.waitpointIds.map((waitpointId) => {
      const parsed = parseWaitpointId(waitpointId);
      if (parsed.format !== "b32hexW") {
        // Postgres IDs belong in the legacy coordinator. Reject a routing error here.
        throw new Error(
          `StoreWaitpointCoordinator.absorbBlockers received a non-store waitpoint id ${waitpointId}`
        );
      }
      return {
        waitpointId,
        batchId: params.batchId,
        batchIndex: params.batchIndex,
        spanIdToComplete: params.spanIdToComplete,
        createdAt: nowIso,
        type: parsed.type,
      };
    });
  }

  async registerBlockers(registration: BlockerRegistration): Promise<RegisterBlockersResult> {
    if (registration.kind !== "store") {
      throw new Error(
        `StoreWaitpointCoordinator.registerBlockers received a ${registration.kind} continuation`
      );
    }

    const result = await this.#store.registerAndDeliver({
      runId: registration.runId,
      blockId: registration.blockId,
      organizationId: registration.organizationId,
      edges: registration.edges as BlockEdge[],
      absorbed: {
        storePendingTotal: registration.storePendingTotal,
        alreadyDelivered: registration.alreadyDelivered as AbsorbResult["alreadyDelivered"],
        supersededCleanup: registration.supersededCleanup as AbsorbResult["supersededCleanup"],
      },
    });

    // After phase 3, prevent cleanup from undoing accepted waits.
    // Keep request proof until the caller finishes timeout jobs, resume jobs and events.
    await this.#store.markRegistrationComplete({
      runId: registration.runId,
      blockId: registration.blockId,
      absorptionId: registration.absorptionId,
      evidence: registration.registrationEvidence,
    });

    return {
      pendingCount: result.pendingOfRequested,
      cachedSpanCompletions: result.cachedSpanCompletions,
    };
  }

  async currentStoreBlockId(runId: string): Promise<string | undefined> {
    return this.#store.currentBlockId(runId);
  }

  async prepareResume(params: PrepareWaitpointResumeParams): Promise<WaitpointResumeIntent> {
    // Publish discovery before writing run state, including a legacy-only resume on a marked run.
    await this.#store.publishRunOwnership(params.runId, params.organizationId);
    return this.#store.prepareResume(params.runId, params.intent);
  }

  async readResumeIntent(runId: string): Promise<WaitpointResumeIntent | undefined> {
    return this.#store.readResumeIntent(runId);
  }

  async acknowledgeResume(params: AcknowledgeResumeParams): Promise<void> {
    if (params.blockId) {
      const ack = await this.#store.acknowledgeResumeHandoff({
        runId: params.runId,
        blockId: params.blockId,
      });
      if (ack.outcome !== "acknowledged") return;
      await this.#store.clearBlockState({ runId: params.runId, blockId: params.blockId });
      return;
    }
    if (params.resumeSnapshotId) {
      await this.#store.clearResumeIntent(params.runId, params.resumeSnapshotId);
    }
  }

  async abandonRunBlockers(params: AbandonRunBlockersParams): Promise<{ count: number }> {
    // Save this block's watcher-removal list and clear its active state atomically.
    // Then remove the watchers. If removal fails, keep the list for retry.
    // Do not change a newer block. The router removes Postgres edges first.
    const target = params.blockId ?? (await this.#store.currentBlockId(params.runId));
    if (!target) {
      return { count: 0 };
    }
    const result = await this.#store.abandonRetainAndClear({
      runId: params.runId,
      blockId: target,
    });
    if (result.outcome !== "retained") {
      // This block is no longer active. Nothing needs to be abandoned.
      return { count: 0 };
    }
    return this.#withdrawRetained(params.runId, target);
  }

  async resumeRetainedWithdrawal(params: {
    runId: string;
    blockId: string;
    organizationId?: string;
  }): Promise<{ count: number }> {
    // Finish watcher removal from the saved list. Leave Postgres and newer blocks unchanged.
    // Do nothing if the list was already removed.
    return this.#withdrawRetained(params.runId, params.blockId);
  }

  /** Remove watchers in bounded pages. Keep a page until every removal succeeds. */
  async #withdrawRetained(runId: string, blockId: string): Promise<{ count: number }> {
    let retained = await this.#store.readWithdrawalPage({ runId, blockId });
    if (!retained) return { count: 0 };
    let count = 0;
    while (retained && retained.fields.length > 0) {
      await pMap(
        retained.fields,
        (field) => {
          const parsed = parseEdgeField(field);
          if (!parsed) throw new Error(`Invalid retained withdrawal target: ${field}`);
          return this.#store.unregisterWatcher({
            waitpointId: parsed.waitpointId,
            runId,
            blockId,
            batchIndex: parsed.batchIndex,
          });
        },
        { concurrency: ABANDON_UNREGISTER_CONCURRENCY }
      );
      await this.#store.acknowledgeWithdrawalPage({ runId, blockId, fields: retained.fields });
      // Count completed removals, including watchers that were already absent.
      count += retained.fields.length;
      retained = await this.#store.readWithdrawalPage({ runId, blockId });
    }
    // Remove the empty list and this block's cleanup guard atomically.
    await this.#store.finalizeRetainedWithdrawal({ runId, blockId });
    return { count };
  }

  async releaseRunBlockers(params: ReleaseRunBlockersParams): Promise<{ count: number }> {
    // Mark the run terminal before removing watchers. Fanout must not resume a terminal run.
    // Keep the saved edges and terminal marker if removal fails, so cleanup can retry.
    // If a block ID is supplied, clean up only that block.
    const result = await this.#store.releaseRunWatchers({
      runId: params.runId,
      reason: params.reason,
      blockId: params.blockId,
    });
    // A stale exact-block obligation is a benign no-op; the current block's owner still owes cleanup.
    if (result.stale) return { count: result.unregistered };
    const detached = await this.#store.finishTerminalRunCleanup(params.runId);
    if (
      params.organizationId &&
      !(await this.#store.retireRunOwnership(params.runId, params.organizationId))
    ) {
      // Preserve the caller's durable terminal cleanup retry instead of acknowledging residue.
      throw new Error(`Terminal waitpoint ownership cleanup is incomplete for ${params.runId}`);
    }
    return { count: result.unregistered + detached };
  }

  // This adapter has no Postgres edges to clear.
  async clearLegacyBlockersBeforeTransition(): Promise<{ count: number }> {
    return { count: 0 };
  }

  async armCleanupFence(params: { runId: string; blockId: string }): Promise<void> {
    // Prevent new blocks until this block's cleanup finishes in both stores.
    await this.#store.armCleanupFence({ runId: params.runId, blockId: params.blockId });
  }

  async assertNoCleanupOwed(runId: string): Promise<void> {
    const blockId = await this.#store.readCleanupFence(runId);
    if (blockId) {
      throw new StoreWaitpointBlockRefusedError({
        runId,
        outcome: "cleanupOwed",
        currentBlockId: blockId,
      });
    }
  }

  async compensateAbsorption(params: {
    runId: string;
    blockId: string;
    absorptionId: string;
    /** Recovery may discard only preparation for this request, never an accepted operation. */
    unacceptedEvidence?: string;
  }): Promise<void> {
    // Release this operation's claims. Preserve edges claimed by other operations.
    // Clear the block ID if no edges remain. Leave newer and terminal blocks unchanged.
    // The test hook can pause cleanup; production callers hold the run lock.
    await this._beforeCompensateDrain();
    await this.#store.compensateAbsorption(params);
  }

  /** Test hook to pause cleanup before the atomic operation. */
  protected async _beforeCompensateDrain(): Promise<void> {}

  // ---- Completion, read, clear (routed here by id shape) --------------------

  async complete({
    waitpointId,
    output,
    onlyIfPending,
    organizationId,
  }: CompleteParams): Promise<CompleteResult> {
    const completion: WaitpointCompletion = {
      completedAt: new Date(this.#clock()).toISOString(),
      outputType: output?.type ?? "application/json",
      outputIsError: output?.isError ?? false,
      output: output ? { inline: output.value } : null,
    };

    // Complete the waitpoint and queue fanout. Repeating the same result is safe.
    // A different result throws WaitpointCompletionConflictError.
    // The fanout worker delivers results in bounded pages.
    const parsed = parseWaitpointId(waitpointId);
    const nativeManual = parsed.format === "b32hexW" && parsed.type === "MANUAL";
    const manualRecord = nativeManual
      ? (await this.#store.readCompletedRecords([waitpointId])).get(waitpointId)?.record
      : undefined;
    if (manualRecord)
      await this.#store.manualCatalog.publishCompletedCandidate(
        manualRecord,
        completion.outputIsError
      );
    try {
      await this.#store.complete({
        waitpointId,
        completion,
        organizationId,
        completionId:
          onlyIfPending &&
          parsed.format === "b32hexW" &&
          (parsed.type === "DATETIME" || parsed.type === "MANUAL")
            ? ""
            : undefined,
      });
    } finally {
      if (manualRecord) await this.#store.manualCatalog.reconcileStatus(manualRecord);
    }
    const waitpoint = await this.#waitpointFromStore(waitpointId);
    return { waitpoint, blockedRuns: [] };
  }

  async readRunBlockState(runId: string): Promise<RunBlockEdge[]> {
    const state = await this.#store.readBlockState(runId);
    const delivered = new Set(state.deliveredIds);
    return state.edges.map((edge) => ({
      id: edge.edgeId,
      batchId: edge.batchId ?? null,
      batchIndex: edge.batchIndex ?? null,
      waitpoint: {
        id: edge.waitpointId,
        status: delivered.has(edge.waitpointId) ? "COMPLETED" : "PENDING",
        type: edge.type,
        completedAfter: edge.completedAfter ? new Date(edge.completedAfter) : null,
      },
    }));
  }

  async clearRunBlockState(params: ClearRunBlockStateParams): Promise<{ count: number }> {
    const state = await this.#store.readBlockState(params.runId);
    if (!state.blockId) {
      return { count: 0 };
    }

    if (params.edgeIds && params.edgeIds.length > 0) {
      // Ignore Postgres edge IDs. The router sends mixed lists to both coordinators.
      const owned = new Set(state.edges.map((edge) => edge.edgeId));
      const toDrain = params.edgeIds.filter((id) => owned.has(id));
      if (toDrain.length === 0) {
        return { count: 0 };
      }
      await this.#store.clearBlockState({
        runId: params.runId,
        blockId: state.blockId,
        edgeIds: toDrain,
      });
      return { count: toDrain.length };
    }

    await this.#store.clearBlockState({ runId: params.runId, blockId: state.blockId });
    return { count: state.edges.length };
  }

  // Creation is added by later PRs.

  registerBlocks(params: RegisterBlocksParams): Promise<{ pendingCount: number }> {
    // MemoryDB waits require all three registration phases.
    // Reject direct calls to this single-step method, as the router does.
    return Promise.reject(
      new StoreWaitpointRegistrationUnsupported({
        runId: params.runId,
        waitpointIds: params.waitpointIds,
      })
    );
  }

  registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void> {
    return Promise.reject(
      new StoreWaitpointRegistrationUnsupported({
        runId: params.runId,
        waitpointIds: params.waitpointIds,
      })
    );
  }

  // DATETIME and run-bound MANUAL tokens allocate fresh store identities. Key reservations reuse
  // a live winner; unkeyed publication respects the caller's fixed candidate fence.
  async createDateTimeWaitpoint(
    params: CreateDateTimeWaitpointParams
  ): Promise<CreateWaitpointResult> {
    return this.#createTimedToken(params, "DATETIME");
  }

  async #createTimedToken(
    params: Omit<CreateDateTimeWaitpointParams, "completedAfter"> & {
      completedAfter?: Date;
      tags?: string[];
    },
    type: "DATETIME" | "MANUAL"
  ): Promise<CreateWaitpointResult> {
    const id = params.storeId ?? generateWaitpointId(type);
    await params.beforeStoreCreate?.(id);
    const organizationId = params.mintContext?.organizationId;
    const acceptUntil =
      params.keyedCreation?.acceptUntil ?? params.creationAcceptUntil ?? Date.now() + 300_000;
    if (organizationId)
      await this.#store.publishPendingSource(
        id,
        organizationId,
        params.idempotencyKey
          ? {
              key: idempotencyReceiptKey(
                params.keyedCreation?.scope ?? params.environmentId,
                params.idempotencyKey,
                id
              ),
              acceptUntil,
            }
          : undefined
      );
    const record = this.#newRecord({
      id,
      type,
      tags: params.tags ?? [],
      projectId: params.projectId,
      environmentId: params.environmentId,
      organizationId,
      completedAfter: params.completedAfter?.toISOString(),
      idempotencyKey: params.idempotencyKey,
      idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt?.toISOString(),
      userProvidedIdempotencyKey: !!params.idempotencyKey,
    });

    if (type === "MANUAL") await this.#store.manualCatalog.publish(record, acceptUntil);

    if (params.idempotencyKey) {
      const reserved = await this.#store.createWithIdempotencyKey({
        record,
        environmentId: params.keyedCreation?.scope ?? params.environmentId,
        idempotencyKey: params.idempotencyKey,
        acceptUntil,
        claimToken: params.keyedCreation?.claimToken,
      });
      if (reserved.created) {
        return { kind: "created", waitpoint: this.#pendingWaitpoint(record) };
      }
      if (organizationId && reserved.waitpointId !== id)
        await this.#store.retirePendingSource(id, organizationId);
      return { kind: "cached", waitpoint: await this.#waitpointFromStore(reserved.waitpointId) };
    }

    if (params.creationAcceptUntil !== undefined) {
      await this.#store.createDateTimeCandidate(record, params.creationAcceptUntil);
    } else {
      await this.#store.createIfAbsent({ record, status: "PENDING" });
    }
    return { kind: "created", waitpoint: this.#pendingWaitpoint(record) };
  }

  createManualWaitpoint(params: CreateManualWaitpointParams): Promise<CreateWaitpointResult> {
    return this.#createTimedToken({ ...params, completedAfter: params.timeout }, "MANUAL");
  }

  async createBatchWaitpoint(params: CreateBatchWaitpointParams): Promise<CreateWaitpointResult> {
    const id = deriveBatchWaitpointId(params.batchId);
    if (!id) throw new Error("Native BATCH requires a derivable batch identity");
    const record = this.#newRecord({
      id,
      type: "BATCH",
      environmentId: params.environmentId,
      projectId: params.projectId,
      organizationId: params.mintContext?.organizationId,
      completedByBatchId: params.batchId,
      idempotencyKey: params.batchId,
      userProvidedIdempotencyKey: false,
    });
    if (params.mintContext?.organizationId)
      await this.#store.publishPendingSource(id, params.mintContext.organizationId);
    const result = await this.#store.createIfAbsent({ record, status: "PENDING" });
    return result.outcome === "created"
      ? { kind: "created", waitpoint: this.#pendingWaitpoint(record) }
      : { kind: "cached", waitpoint: await this.#waitpointFromStore(id) };
  }

  // The RUN mint id is a pure function of the child anchor, so create-if-absent is idempotent
  // without a lock and a replay cannot mint a competing waitpoint. Unsupported anchors stay legacy.
  mintAssociatedWaitpointData(params: {
    projectId: string;
    environmentId: string;
    anchorRunId: string;
  }): AssociatedWaitpointData {
    const id = deriveRunWaitpointId(params.anchorRunId);
    if (!id) {
      throw new Error(
        `Store RUN waitpoint requires a supported anchor id, got ${params.anchorRunId}`
      );
    }
    return {
      id,
      friendlyId: WaitpointId.toFriendlyId(id),
      type: "RUN",
      status: "PENDING",
      // No user idempotency key on a RUN waitpoint; the deterministic id is its dedup key. Kept
      // deterministic (the id) so a replay builds identical data, and inert — the resolver omits a
      // non-user key and create-if-absent dedups on the id, never this field.
      idempotencyKey: id,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
    };
  }

  async createAssociatedWaitpoint({
    runId,
    data,
    organizationId,
  }: {
    runId: string;
    data: AssociatedWaitpointData;
    organizationId?: string;
  }): Promise<Waitpoint> {
    const record = this.#newRecord({
      id: data.id,
      friendlyId: data.friendlyId,
      type: "RUN",
      projectId: data.projectId,
      environmentId: data.environmentId,
      idempotencyKey: data.idempotencyKey,
      userProvidedIdempotencyKey: data.userProvidedIdempotencyKey,
      // The reverse back-pointer a delayed sweep re-derives the completion from (child run → its RUN
      // waitpoint), and the cachedRunId a completion carries. Matches the legacy row's column.
      completedByTaskRunId: runId,
      organizationId,
    });
    if (organizationId) await this.#store.publishPendingSource(data.id, organizationId);
    const created = await this.#store.createIfAbsent({ record, status: "PENDING" });
    if (created.outcome === "exists") {
      if (
        created.record.type !== "RUN" ||
        created.record.completedByTaskRunId !== runId ||
        created.record.projectId !== data.projectId ||
        created.record.environmentId !== data.environmentId
      ) {
        throw new Error(`RUN waitpoint ownership conflict: ${data.id}`);
      }
      if (organizationId && created.status === "COMPLETED")
        await this.#store.retirePendingSource(data.id, organizationId);
      return waitpointFromStoredRecord(data.id, {
        status: created.status,
        record: created.record,
        completion: created.completion,
      });
    }
    return this.#pendingWaitpoint(record);
  }

  // The store adapter always mints store; the router only routes here when the decision is store.
  async planAssociatedWaitpoint(params: {
    projectId: string;
    environmentId: string;
    anchorRunId: string;
  }): Promise<AssociatedWaitpointPlan> {
    return { residency: "store", data: this.mintAssociatedWaitpointData(params) };
  }

  // Association discovery for a deterministically-known store RUN id: derive it from the anchor and probe
  // its presence with one bounded read (no output, no watchers). Undefined for an unsupported anchor (no
  // store id can exist) or a confirmed-absent record; a Redis error throws, so an availability failure is
  // never reported as absence. Not a store-first residency probe — the id is fixed by the anchor and the
  // answer never re-routes an already-classified id.
  async findAssociatedRunWaitpointId(runId: string): Promise<string | undefined> {
    const id = deriveRunWaitpointId(runId);
    if (!id) {
      return undefined;
    }
    return (await this.#store.probeWaitpointPresence(id)) === "present" ? id : undefined;
  }

  // Read the run's existing store RUN waitpoint as a Waitpoint (for lazy reuse). A Redis error throws, so
  // an availability failure is never seen as "no association" and never triggers a second mint.
  async readAssociatedRunWaitpoint(runId: string): Promise<Waitpoint | undefined> {
    const id = deriveRunWaitpointId(runId);
    if (!id) {
      return undefined;
    }
    const stored = (await this.#store.readCompletedRecords([id])).get(id);
    return stored ? waitpointFromStoredRecord(id, stored) : undefined;
  }

  #newRecord(fields: {
    id: string;
    friendlyId?: string;
    type: WaitpointRecordInput["type"];
    projectId: string;
    environmentId: string;
    organizationId?: string;
    completedAfter?: string;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: string;
    userProvidedIdempotencyKey: boolean;
    completedByTaskRunId?: string;
    completedByBatchId?: string;
    tags?: string[];
  }): WaitpointRecordInput {
    const nowIso = new Date(this.#clock()).toISOString();
    return {
      id: fields.id,
      friendlyId: fields.friendlyId ?? WaitpointId.toFriendlyId(fields.id),
      type: fields.type,
      environmentId: fields.environmentId,
      organizationId: fields.organizationId,
      projectId: fields.projectId,
      createdAt: nowIso,
      updatedAt: nowIso,
      userProvidedIdempotencyKey: fields.userProvidedIdempotencyKey,
      tags: fields.tags ?? [],
      idempotencyKey: fields.idempotencyKey,
      idempotencyKeyExpiresAt: fields.idempotencyKeyExpiresAt,
      completedAfter: fields.completedAfter,
      completedByTaskRunId: fields.completedByTaskRunId,
      completedByBatchId: fields.completedByBatchId,
    };
  }

  #pendingWaitpoint(record: WaitpointRecordInput): Waitpoint {
    return waitpointFromStoredRecord(record.id, { status: "PENDING", record });
  }

  // Convert the stored record to the Waitpoint return type. Reject missing records.
  async #waitpointFromStore(waitpointId: string): Promise<Waitpoint> {
    const records = await this.#store.readCompletedRecords([waitpointId]);
    const stored = records.get(waitpointId);
    if (!stored) {
      throw new WaitpointNotFoundError(waitpointId);
    }
    return waitpointFromStoredRecord(waitpointId, stored);
  }
}

/**
 * Convert a store record to the existing Waitpoint return type.
 * Fill the fields callers read. Set the remaining fields to null.
 */
export function waitpointFromStoredRecord(
  waitpointId: string,
  stored: WaitpointStoredRecord
): Waitpoint {
  const record = stored.record;
  const completion = stored.completion;
  return {
    id: waitpointId,
    friendlyId: record.friendlyId ?? WaitpointId.toFriendlyId(waitpointId),
    type: record.type,
    status: stored.status,
    completedAt: completion ? new Date(completion.completedAt) : null,
    idempotencyKey: record.idempotencyKey ?? null,
    idempotencyKeyExpiresAt: record.idempotencyKeyExpiresAt
      ? new Date(record.idempotencyKeyExpiresAt)
      : null,
    userProvidedIdempotencyKey: record.userProvidedIdempotencyKey,
    inactiveIdempotencyKey: null,
    projectId: record.projectId,
    environmentId: record.environmentId,
    completedByTaskRunId: record.completedByTaskRunId ?? null,
    completedByBatchId: record.completedByBatchId ?? null,
    completedAfter: record.completedAfter ? new Date(record.completedAfter) : null,
    output: completion?.output
      ? "inline" in completion.output
        ? completion.output.inline
        : completion.output.ref
      : null,
    outputType: completion?.outputType ?? null,
    outputIsError: completion?.outputIsError ?? false,
    createdAt: record.createdAt ? new Date(record.createdAt) : new Date(),
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(),
    tags: record.tags ?? [],
  } as unknown as Waitpoint;
}
