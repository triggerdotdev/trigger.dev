import type { Logger } from "@trigger.dev/core/logger";
import type { Waitpoint } from "@trigger.dev/database";
import {
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
  AssociatedWaitpointData,
  ClearRunBlockStateParams,
  CompleteParams,
  CompleteResult,
  CreateDateTimeWaitpointParams,
  CreateManualWaitpointParams,
  CreateWaitpointResult,
  RegisterBlocksLocklessParams,
  RegisterBlocksParams,
  RegisterBlocksResult,
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
  readonly #mintPolicy: RoutingWaitpointCoordinatorMintPolicy;
  readonly #isStoreEnabled?: RoutingWaitpointCoordinatorOptions["isStoreEnabled"];
  readonly #mightHaveStoreBlockers?: (runKey: WaitpointRunKey) => boolean | Promise<boolean>;

  constructor(options: RoutingWaitpointCoordinatorOptions) {
    this.#legacy = options.legacy;
    this.#store = options.store;
    this.#mintPolicy = options.mintPolicy;
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
      // Never-enabled / no store: legacy only, and the caller's tx joins the single-store clear.
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

  async registerBlocks(params: RegisterBlocksParams): Promise<RegisterBlocksResult> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      // Drop routing-only context so the disabled legacy call retains its original shape.
      const { organizationId: _organizationId, ...legacyParams } = params;
      return this.#legacy.registerBlocks(legacyParams);
    }
    // Store-format blockers are refused inside the guard; only legacy ids reach a write.
    const legacyIds = this.#legacyRegistrationSubset(params);
    if (legacyIds.length === 0) {
      return { pendingCount: 0, storeRoutingEnabled: true };
    }
    const result = await this.#legacy.registerBlocks({ ...params, waitpointIds: legacyIds });
    return { ...result, storeRoutingEnabled: true };
  }

  async registerBlocksLockless(params: RegisterBlocksLocklessParams): Promise<void> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      return this.#legacy.registerBlocksLockless(params);
    }
    const legacyIds = this.#legacyRegistrationSubset(params);
    if (legacyIds.length > 0) {
      await this.#legacy.registerBlocksLockless({ ...params, waitpointIds: legacyIds });
    }
  }

  async complete(params: CompleteParams): Promise<CompleteResult> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      return this.#legacy.complete(params);
    }
    return this.#coordinatorForId(params.waitpointId).complete(params);
  }

  async createDateTimeWaitpoint(
    params: CreateDateTimeWaitpointParams
  ): Promise<CreateWaitpointResult> {
    const residency = await this.#decideMintResidency("DATETIME", params.mintContext);
    return residency === "store"
      ? this.#store!.createDateTimeWaitpoint(params)
      : this.#legacy.createDateTimeWaitpoint(params);
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
    // The synchronous RUN-waitpoint data builder stays legacy in this layer; a store RUN mint has its
    // own asynchronous path owned by a later ticket. Dark by construction.
    return this.#legacy.mintAssociatedWaitpointData(params);
  }

  async createAssociatedWaitpoint(params: {
    runId: string;
    data: AssociatedWaitpointData;
  }): Promise<Waitpoint> {
    // RUN minting in this foundation is always legacy and carries no trusted organization context.
    return this.#legacy.createAssociatedWaitpoint(params);
  }
}
