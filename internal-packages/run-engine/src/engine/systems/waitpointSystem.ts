import type { ManualWaitpointCatalogListInput } from "../waitpointCoordinator/manualWaitpointCatalog.js";
import { batchTimeoutError } from "./batchSystem.js";
import {
  deriveRunWaitpointId,
  deriveBatchWaitpointId,
} from "../waitpointCoordinator/runWaitpointId.js";
import { timeoutError } from "@trigger.dev/core/v3";
import {
  generateWaitpointId,
  WaitpointId,
  parseWaitpointId,
  generateRunOpsId,
  generateRunOpsIdV2,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { boundedIn } from "@trigger.dev/database";
import type {
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  Waitpoint,
} from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { assertNever } from "assert-never";
import {
  StoreAbsorptionCompensationFailed,
  StoreWaitpointBlockCycleAdvanced,
  WaitpointCompletionGuardArmedError,
} from "../errors.js";
import { registrationEvidence } from "../waitpointCoordinator/keys.js";
import { classifyWaitpointCoordinator } from "../waitpointCoordinator/routing.js";
import { buildCompletedWaitpointRecords } from "./completedWaitpointResolver.js";
import { resolveCompletedWaitpointRecords } from "./completedWaitpointRecordAdapter.js";
import { sendNotificationToWorker } from "../eventBus.js";
import { isExecuting, isFinalRunStatus, isPendingExecuting } from "../statuses.js";
import { LegacyPostgresWaitpointCoordinator } from "../waitpointCoordinator/legacyPostgresCoordinator.js";
import {
  StoreWaitpointBlockRefusedError,
  waitpointFromStoredRecord,
} from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import type { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import {
  assertCreationBudget,
  withCreationBudget,
} from "../waitpointCoordinator/creationBudget.js";
import {
  RoutingWaitpointCoordinator,
  type RoutingWaitpointCoordinatorMintPolicy,
  type WaitpointRunKey,
} from "../waitpointCoordinator/routingCoordinator.js";
import type {
  AbsorbBlockersParams,
  AbsorbBlockersResult,
  BlockerRegistration,
  CompleteParams,
  RunBlockEdge,
  AssociatedWaitpointData,
  AssociatedWaitpointPlan,
  CreateWaitpointResult,
  CreateDateTimeWaitpointParams,
  WaitpointCoordinator,
} from "../waitpointCoordinator/types.js";
import type { EnqueueSystem } from "./enqueueSystem.js";
import type { ExecutionSnapshotSystem } from "./executionSnapshotSystem.js";
import {
  getLatestExecutionSnapshot,
  isExpiredSnapshotOfFinishedRun,
} from "./executionSnapshotSystem.js";
import type { workerCatalog } from "../workerCatalog.js";
import type { z } from "zod";
import type { SystemResources } from "./systems.js";
import {
  hasStoreWaitpoints,
  batchStoreWaitpointId,
  snapshotRouteFromSnapshot,
  WaitpointKeyTransactionBudgetExhaustedError,
  type CompletedWaitpointRecord,
} from "@internal/run-store";

export type WaitpointSystemOptions = {
  waitpointStoreEnabled?: (
    organizationId: string,
    organizationFlags?: unknown
  ) => boolean | Promise<boolean>;
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  enqueueSystem: EnqueueSystem;
  /** Grace before an unacked completion guard fires. Defaults to 30s. */
  completionGuardDelayMs?: number;
  /**
   * Dark routing/mint-selection wiring. Omitted in production today: with no `store` the routing
   * coordinator is a 1:1 legacy passthrough — no MemoryDB client, no store calls, no `wp:v1` keys —
   * and every mint stays legacy. A later ticket supplies a store coordinator and a real mint policy
   * to activate MemoryDB minting per organization.
   */
  waitpointRouting?: {
    store?: WaitpointCoordinator;
    mintPolicy?: RoutingWaitpointCoordinatorMintPolicy;
    /**
     * Optional run-state reader override. By default the owning run's internal waitpointsOnStore
     * annotation decides after the organization's flag permits store access.
     */
    mightHaveStoreBlockers?: (runKey: WaitpointRunKey) => boolean | Promise<boolean>;
  };
  /**
   * Reads store-format waitpoint records for a redis-primary resume. Undefined keeps the resolver
   * Postgres-only, the only reachable state until store-format minting is wired.
   */
  waitpointStore?: Pick<WaitpointStoreCoordinator, "readCompletedRecords"> &
    Partial<
      Pick<
        WaitpointStoreCoordinator,
        | "prepareForKeyedCreation"
        | "beginIdempotencyKeyClaim"
        | "readIdempotencyKey"
        | "recoverIdempotencyCandidate"
        | "acknowledgeIdempotencyCandidate"
        | "retirePendingSource"
        | "readRelatedRunIds"
        | "manualCatalog"
        | "retireManualCatalog"
      >
    >;
};

type RecoverRunWaitpoint = z.infer<typeof workerCatalog.recoverRunWaitpoint.schema>;
type RecoverWaitpointBlock = z.infer<typeof workerCatalog.recoverWaitpointBlock.schema>;
type RecoverDateTimeWaitpoint = z.infer<typeof workerCatalog.recoverDateTimeWaitpoint.schema>;

const DEFAULT_COMPLETION_GUARD_DELAY_MS = 30_000;

export const RUN_WAITPOINT_RECOVERY_COMMIT_WINDOW_MS = 15 * 60_000;

// Delay before the worker retries failed registration or lifecycle cleanup under the run lock.
const BLOCKER_CLEANUP_OBLIGATION_DELAY_MS = 30_000;

// Identify the exact block and lifecycle transition whose cleanup is owed.
export type BlockerCleanupObligation = { blockId: string; transitionId: string } | undefined;

// Keep the caller's block identity on retries. Read the installed identity when resuming.

// Use this exact description to identify a snapshot blocked by a waitpoint.
const WAITPOINT_BLOCKED_SNAPSHOT_DESCRIPTION = "Run was blocked by a waitpoint.";

function legacyResumeEdgeIdsHash(edges: RunBlockEdge[]): string {
  const ids = edges
    .filter((edge) => classifyWaitpointCoordinator(edge.waitpoint.id) === "legacy")
    .map((edge) => edge.id)
    .sort();
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

// Return the snapshot ID that identifies the current wait cycle.
// Before blocking, use the current snapshot. While blocked, use its predecessor.
// A checkpoint preserves the cycle anchor in its metadata.
// Callers capture this ID before registration and check it under the run lock.
// The check rejects old operations after resume or retry, even if the old block is gone.
export function cycleAnchorSnapshotId(snapshot: TaskRunExecutionSnapshot): string {
  // A checkpoint suspends this same active wait, preserving the anchor captured under the run lock.
  if (
    snapshot.executionStatus === "SUSPENDED" &&
    snapshot.description === "Run was suspended after creating a checkpoint."
  ) {
    const metadata = snapshot.metadata;
    if (
      metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      typeof metadata.waitpointCycleAnchor === "string"
    )
      return metadata.waitpointCycleAnchor;
  }
  const isWaitpointBlocked =
    snapshot.executionStatus === "EXECUTING_WITH_WAITPOINTS" ||
    (snapshot.executionStatus === "SUSPENDED" &&
      snapshot.description === WAITPOINT_BLOCKED_SNAPSHOT_DESCRIPTION);
  return isWaitpointBlocked ? (snapshot.previousSnapshotId ?? snapshot.id) : snapshot.id;
}

type WaitpointContinuationWaitpoint = Pick<Waitpoint, "id" | "type" | "completedAfter" | "status">;

export type WaitpointContinuationResult =
  | {
      status: "unblocked";
      waitpoints: Array<WaitpointContinuationWaitpoint>;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "blocked";
      waitpoints: Array<WaitpointContinuationWaitpoint>;
    };

export class WaitpointSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly enqueueSystem: EnqueueSystem;
  private readonly coordinator: WaitpointCoordinator;
  private readonly legacyCoordinator: WaitpointCoordinator &
    Pick<LegacyPostgresWaitpointCoordinator, "withKeyClaim">;
  private readonly completionGuardDelayMs: number;
  readonly #waitpointStore?: Pick<WaitpointStoreCoordinator, "readCompletedRecords"> &
    Partial<
      Pick<
        WaitpointStoreCoordinator,
        | "prepareForKeyedCreation"
        | "beginIdempotencyKeyClaim"
        | "readIdempotencyKey"
        | "recoverIdempotencyCandidate"
        | "acknowledgeIdempotencyCandidate"
        | "retirePendingSource"
        | "readRelatedRunIds"
        | "manualCatalog"
        | "retireManualCatalog"
      >
    >;
  // Whether a store coordinator is wired at all. When it is not, the RUN mint decision and terminal
  // association discovery short-circuit to legacy WITHOUT resolving the parent's residency or making any
  // MemoryDB call, so the dark production path keeps its exact current cost.
  readonly #storeWired: boolean;

  constructor(private readonly options: WaitpointSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.enqueueSystem = options.enqueueSystem;
    this.#waitpointStore = options.waitpointStore;
    this.#storeWired = !!options.waitpointRouting?.store;
    this.completionGuardDelayMs =
      options.completionGuardDelayMs ?? DEFAULT_COMPLETION_GUARD_DELAY_MS;
    const legacyCoordinator = new LegacyPostgresWaitpointCoordinator({
      // A getter, so a `setRunStore` swap (a test seam) also reaches the coordinator.
      runStore: () => this.$.runStore,
      prisma: this.$.prisma,
      logger: this.$.logger,
    });
    // Dark by default: with no store coordinator the router delegates every operation to Postgres and
    // never consults the mint policy, so production behaves exactly as before.
    this.legacyCoordinator = legacyCoordinator;
    this.coordinator = options.waitpointRouting?.store
      ? new RoutingWaitpointCoordinator({
          legacy: legacyCoordinator,
          store: options.waitpointRouting?.store,
          isStoreEnabled: async (organizationId) =>
            organizationId !== undefined &&
            (await options.waitpointStoreEnabled?.(organizationId)) === true,
          mintPolicy: {
            ...options.waitpointRouting?.mintPolicy,
            // The router has already checked this mint operation's organization flag.
            resolveMintMode:
              options.waitpointRouting?.mintPolicy?.resolveMintMode ?? (() => "redis"),
            isCapabilityReady:
              options.waitpointRouting?.mintPolicy?.isCapabilityReady ?? (() => false),
          },
          markStoreWaitpoints: (runId, organizationId) =>
            this.$.runLock.lock("markRunWaitpointsOnStore", [runId], async () => {
              // Reuse the run lock for registration and association creation.
              // Child marking also takes the start-attempt lock, even if the flag changes.
              if (!(await this.isWaitpointStoreEnabled(organizationId))) {
                throw new Error("Waitpoint store was disabled before marking the run");
              }
              await this.$.runStore.markRunWaitpointsOnStore(runId);
            }),
          withLegacyRegistrationLock: (runId, operation) =>
            this.$.runLock.lockQueued("registerLegacyWaitpoint", runId, operation),
          mightHaveStoreBlockers:
            options.waitpointRouting?.mightHaveStoreBlockers ??
            (async ({ runId }) => {
              const run = await this.$.runStore.findRunOnPrimary(
                { id: runId },
                { select: { annotations: true } }
              );
              // Missing runs stay conservative for delayed cleanup; never use a replica here.
              return run ? hasStoreWaitpoints(run.annotations) : true;
            }),
        })
      : legacyCoordinator;
  }

  public get isStoreRoutingWired(): boolean {
    return this.#storeWired;
  }

  public isStoreRoutingEnabled(
    organizationId?: string,
    organizationFlags?: unknown
  ): boolean | Promise<boolean> {
    return (
      this.coordinator instanceof RoutingWaitpointCoordinator &&
      this.isWaitpointStoreEnabled(organizationId, organizationFlags)
    );
  }

  public async isWaitpointStoreEnabled(
    organizationId?: string,
    organizationFlags?: unknown
  ): Promise<boolean> {
    return (
      organizationId !== undefined &&
      (await this.options.waitpointStoreEnabled?.(organizationId, organizationFlags)) === true
    );
  }

  /**
   * The attempt-completion failure cleanup, run AFTER the failure's durable TRES transition and OUTSIDE
   * the Postgres transaction (so MemoryDB never joins a rollback-capable tx and an enabled org never
   * throws). The outcome — known only after retry/cancel/failure is decided — chooses the protocol:
   *
   *  - `retry` abandons and fences the old attempt's block and withdraws its watchers WITHOUT
   *    terminalizing the run, so an in-flight old delivery is refused and the next attempt can block
   *    again with a fresh cycle;
   *  - `cancelled`/`terminal` release TERMINAL-FIRST (fence, then withdraw), so an in-flight delivery
   *    can never resume a run being torn down.
   *
   * A run reaching attempt completion is normally executing with no active store block, so both are a
   * no-op there; legacy is unchanged (a full edge delete).
   */
  public async cleanupBlockersAfterAttemptFailure({
    runId,
    organizationId,
    outcome,
  }: {
    runId: string;
    organizationId?: string;
    outcome: "retry" | "cancelled" | "terminal";
  }): Promise<number> {
    if (outcome === "retry") {
      const abandoned = await this.coordinator.abandonRunBlockers({ runId, organizationId });
      return abandoned.count;
    }
    const released = await this.coordinator.releaseRunBlockers({
      runId,
      reason: outcome,
      organizationId,
    });
    return released.count;
  }

  #blockerCleanupObligationId(runId: string, blockId: string, transitionId: string): string {
    return `ensureBlockersCleanedUp:${runId}:${blockId}:${transitionId}`;
  }

  /**
   * Arm the write-ahead cleanup obligation BEFORE a failed attempt's lifecycle transition, so a crash
   * after the transition commits but before {@link cleanupBlockersAfterAttemptFailure} runs still gets
   * the block cleaned. It observes the exact installed store block under the caller's run lock; a run
   * with no store block (the normal executing attempt, and every legacy/unmarked run) arms nothing,
   * so the dark path keeps its current cost. The obligation is keyed by that block id, so a later cycle's
   * obligation never collides with this one, and delayed so the inline path can ack it first.
   */
  public async armBlockerCleanupObligation({
    runId,
    organizationId,
    transitionId,
  }: {
    runId: string;
    organizationId?: string;
    // The id minted for this attempt's retry/requeue transition (and stamped on that transition's
    // snapshot), so a replay can prove that specific transition committed before abandoning.
    transitionId: string;
  }): Promise<BlockerCleanupObligation> {
    const blockId = await this.coordinator.currentStoreBlockId(runId, { organizationId });
    if (!blockId) {
      return undefined;
    }
    await this.$.worker.enqueueOnce({
      id: this.#blockerCleanupObligationId(runId, blockId, transitionId),
      job: "ensureBlockersCleanedUp",
      payload: { runId, organizationId, blockId, transitionId },
      availableAt: new Date(Date.now() + BLOCKER_CLEANUP_OBLIGATION_DELAY_MS),
    });
    return { blockId, transitionId };
  }

  /**
   * The single pre-transition decision for a failed attempt: observe THIS run's current store block ONCE
   * under the run lock (an unmarked run resolves it without any MemoryDB call). With no current store
   * block — including a legacy-only run in an enabled or rolled-back org — clear the run's legacy edges
   * BEFORE the transition, in the CALLER'S client, restoring the crash-safe ordering; no MemoryDB is
   * touched and no store block is minted. With a store block, arm the write-ahead obligation and let the
   * sequenced (legacy-first) post-transition cleanup own it.
   */
  public async prepareFailedAttemptCleanup({
    runId,
    organizationId,
    transitionId,
    tx,
  }: {
    runId: string;
    // The run's org, so the router can skip MemoryDB for a run whose org could not hold store edges.
    // Undefined keeps legacy routing without discovering an organization.
    organizationId?: string;
    transitionId: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<BlockerCleanupObligation> {
    const blockId = await this.coordinator.currentStoreBlockId(runId, { organizationId });
    if (!blockId) {
      // Legacy-only (or unmarked): no store block, so clear the Postgres edges inline in the caller's
      // tx — atomic with the transition, and safe because there is no MemoryDB cycle to roll over.
      await this.coordinator.clearLegacyBlockersBeforeTransition({ runId, organizationId, tx });
      return undefined;
    }
    // Store/mixed block: durably fence off a NEWER store cycle BEFORE publishing the retry transition, so a
    // rolled-over B2 cannot be absorbed while this block still owes its cross-store cleanup — a block-id-less
    // Postgres delete run after B2 existed would hit B2's reused legacy edges. The legacy half is NOT
    // cleared inline here (passing `tx` to that delete does not make it atomic with the Redis-primary store
    // transition); it is deferred to the fenced cleanup, which deletes the old legacy edges first, then runs
    // the atomic store retain-and-clear/withdrawal, and lifts the fence last. The fence, not call ordering,
    // is what durably proves B2 cannot become active before B1's Postgres cleanup completes.
    await this.coordinator.armCleanupFence({ runId, blockId, organizationId });
    await this.$.worker.enqueueOnce({
      id: this.#blockerCleanupObligationId(runId, blockId, transitionId),
      job: "ensureBlockersCleanedUp",
      payload: { runId, organizationId, blockId, transitionId },
      availableAt: new Date(Date.now() + BLOCKER_CLEANUP_OBLIGATION_DELAY_MS),
    });
    return { blockId, transitionId };
  }

  /**
   * Run the inline failed-attempt cleanup and, on success, ack the obligation armed for this exact block
   * so it never fires. If this throws (a MemoryDB error after the transition), the obligation is left
   * armed and re-drives the cleanup later.
   */
  public async settleBlockerCleanupAfterAttemptFailure({
    obligation,
    runId,
    organizationId,
    outcome,
  }: {
    obligation: BlockerCleanupObligation;
    runId: string;
    organizationId?: string;
    outcome: "retry" | "cancelled" | "terminal";
  }): Promise<number> {
    // No store obligation means preparation already cleared the legacy edges before the transition.
    // Do not add a second Postgres delete (or a new failure point) after the outcome has committed.
    if (!obligation) return 0;

    const count = await this.cleanupBlockersAfterAttemptFailure({ runId, organizationId, outcome });
    await this.$.worker.ack(
      this.#blockerCleanupObligationId(runId, obligation.blockId, obligation.transitionId)
    );
    return count;
  }

  /**
   * Redelivery handler for the failed-attempt cleanup obligation. Runs under the run lock and is fenced
   * to the exact armed block: a newer cycle (or an already-completed cleanup) means the current store
   * block is no longer this one, so there is nothing to do. Otherwise it binds to durable proof of the
   * SPECIFIC intended transition rather than to any snapshot advancement: a durably terminal run releases
   * terminal-first (a checkpoint cannot make a run terminal), and a non-terminal run abandons ONLY once
   * the minted retry/requeue transition has committed — proven by a snapshot with that id existing, so an
   * intermediate SUSPENDED checkpoint never triggers an abandon of a still-valid block. Until one of
   * those is proven it throws to retry.
   */
  public async ensureBlockersCleanedUp({
    runId,
    organizationId,
    blockId,
    transitionId,
  }: {
    runId: string;
    organizationId?: string;
    blockId: string;
    transitionId: string;
  }): Promise<void> {
    if (!(await this.isWaitpointStoreEnabled(organizationId))) return;
    await this.$.runLock.lock("ensureBlockersCleanedUp", [runId], async () => {
      const currentBlockId = await this.coordinator.currentStoreBlockId(runId, { organizationId });
      const snapshot = await getLatestExecutionSnapshot(this.$.prisma, runId, this.$.runStore);

      if (
        snapshot.executionStatus === "FINISHED" ||
        snapshot.executionStatus === "PENDING_CANCEL"
      ) {
        // Durable terminal status is proof on its own. Route ALWAYS through the ordered releaseRunBlockers
        // (store terminalize + finish retained withdrawal FIRST, then the Postgres delete), whether or not
        // the store block is still current: a first pass that terminalized the store half and cleared its
        // block id but failed the concurrent legacy delete would otherwise fall to the store-only branch
        // below and strand the Postgres edges forever. A terminal run has no newer cycle, so a block-id-less
        // legacy delete is safe, and the store adapter finishes any retained withdrawal for THIS exact block
        // before reporting convergence.
        await this.coordinator.releaseRunBlockers({
          runId,
          reason: "terminal",
          organizationId,
          blockId,
        });
        return;
      }

      if (currentBlockId !== blockId) {
        // Non-terminal, and this block is no longer the active one — superseded by a newer cycle, or already
        // cleared by a prior (possibly interrupted) abandon. That is NOT proof the cleanup finished: a
        // partial abandon leaves a durable withdrawal record for THIS block. Resume it STORE-ONLY — never
        // the legacy coordinator (whose block-id-less delete would drop a NEWER block's edges, which may
        // exist here) — fenced to this block id; a no-op if nothing remains.
        await this.coordinator.resumeRetainedWithdrawal({ runId, blockId, organizationId });
        return;
      }

      // Non-terminal: abandon only once the SPECIFIC retry/requeue transition durably committed, proven
      // by its minted-id snapshot existing. A checkpoint or any other advancement is not that proof.
      const committed = await this.$.runStore.findExecutionSnapshot(
        { where: { id: transitionId, runId }, select: { id: true } },
        this.$.prisma
      );
      if (!committed) {
        throw new Error(
          `ensureBlockersCleanedUp: retry transition ${transitionId} not yet committed for run ${runId}`
        );
      }

      await this.coordinator.abandonRunBlockers({ runId, blockId, organizationId });
    });
  }

  /**
   * If Postgres registration fails after MemoryDB accepts its part, undo that part.
   * If immediate cleanup also fails, queue a cleanup retry before returning the error.
   * Scope the retry to this block and operation.
   */
  async #absorbBlockersWithCompensationGuard(
    params: AbsorbBlockersParams
  ): Promise<AbsorbBlockersResult> {
    try {
      return await this.coordinator.absorbBlockers(params);
    } catch (error) {
      if (error instanceof StoreAbsorptionCompensationFailed) {
        // Use one job per operation. Repeated retries reuse the same job.
        // Store only IDs in the payload; read the added edges from the saved record.
        await this.$.worker.enqueueOnce({
          id: this.#absorptionCompensationObligationId(
            error.runId,
            error.blockId,
            error.absorptionId
          ),
          job: "ensureAbsorptionCompensated",
          payload: {
            runId: error.runId,
            blockId: error.blockId,
            absorptionId: error.absorptionId,
            organizationId: params.organizationId,
          },
          availableAt: new Date(Date.now() + BLOCKER_CLEANUP_OBLIGATION_DELAY_MS),
        });
      }
      throw error;
    }
  }

  #absorptionCompensationObligationId(
    runId: string,
    blockId: string,
    absorptionId: string
  ): string {
    return `ensureAbsorptionCompensated:${runId}:${blockId}:${absorptionId}`;
  }

  /**
   * Retry cleanup under the run lock so it cannot race with registration.
   * Check the saved operation record inside the lock. After successful registration,
   * its proof prevents cleanup from removing accepted edges, even if the job was not acknowledged.
   */
  public async ensureAbsorptionCompensated({
    runId,
    blockId,
    absorptionId,
    organizationId,
  }: {
    runId: string;
    blockId: string;
    absorptionId: string;
    organizationId?: string;
  }): Promise<void> {
    if (!(await this.isWaitpointStoreEnabled(organizationId))) return;
    await this.$.runLock.lock("ensureAbsorptionCompensated", [runId], async () => {
      await this.coordinator.compensateAbsorption({ runId, blockId, absorptionId, organizationId });
    });
  }

  /** Completes a waitpoint and schedules a continue for each run it blocked. Safe under races. */
  async completeWaitpoint(
    {
      id,
      output,
      armGuard = false,
      onlyIfPending = false,
      organizationId,
    }: {
      id: string;
      output?: {
        value: string;
        type?: string;
        isError: boolean;
      };
      /** Arms the write-ahead completion guard first. The guard's replay passes false. */
      armGuard?: boolean;
      onlyIfPending?: boolean;
      /** Caller ownership for resume jobs. Missing context keeps legacy routing. */
      organizationId?: string;
    },
    completionLockHeld = false
  ): Promise<Waitpoint> {
    // Keep this pre-check outside guard scheduling and its error handling. The router owns its
    // mutation gate, so an armed call checks again after the durable guard has been persisted.
    const storeRoutingEnabled =
      this.coordinator instanceof RoutingWaitpointCoordinator &&
      (await this.coordinator.isStoreRoutingEnabled(organizationId));

    if (storeRoutingEnabled && !completionLockHeld) {
      const parsed = parseWaitpointId(id);
      if (
        parsed.format === "b32hexW" &&
        (parsed.type === "DATETIME" || parsed.type === "MANUAL" || parsed.type === "BATCH")
      ) {
        return this.withWaitpointCompletionLock(id, () =>
          this.completeWaitpoint({ id, output, armGuard, onlyIfPending, organizationId }, true)
        );
      }
    }

    if (storeRoutingEnabled && organizationId) {
      const parsed = parseWaitpointId(id);
      if (parsed.format === "b32hexW" && parsed.type === "MANUAL")
        await this.prearmManualCatalogRetirement(id, organizationId);
    }

    // Armed before the first mutation, so a committed completion always has a durable watcher. An
    // arm failure is not wrapped, so the caller cannot mistake it for one the guard will replay.
    if (armGuard) {
      await this.#scheduleCompletionGuard(
        id,
        output,
        storeRoutingEnabled ? organizationId : undefined
      );
    }

    // From here the guard owns eventual completion. A failure is wrapped as
    // WaitpointCompletionGuardArmedError, so the API can return success and let the guard replay.
    try {
      if (storeRoutingEnabled && organizationId && classifyWaitpointCoordinator(id) === "store") {
        await this.$.worker.enqueueOnce({
          id: `deliverWaitpointFanout:${id}`,
          job: "deliverWaitpointFanout",
          payload: { waitpointId: id, organizationId },
          availableAt: new Date(Date.now() + 50),
        });
      }

      const params: CompleteParams = { waitpointId: id, output };
      if (storeRoutingEnabled) {
        params.organizationId = organizationId;
        params.onlyIfPending = onlyIfPending;
      }
      const { waitpoint, blockedRuns } = await (
        storeRoutingEnabled ? this.coordinator : this.legacyCoordinator
      ).complete(params);

      if (blockedRuns.length === 0) {
        this.$.logger.debug(`completeWaitpoint: no TaskRunWaitpoints found for waitpoint`, {
          waitpointId: id,
        });
      }

      for (const run of blockedRuns) {
        const jobId = `continueRunIfUnblocked:${run.taskRunId}`;
        const availableAt = new Date(Date.now() + 50);

        this.$.logger.debug(`completeWaitpoint: enqueueing continueRunIfUnblocked`, {
          waitpointId: id,
          runId: run.taskRunId,
          jobId,
          availableAt,
        });

        await this.$.worker.enqueue({
          // The fixed job id debounces repeat enqueues.
          id: jobId,
          job: "continueRunIfUnblocked",
          // Pass the organisation to the resume job. Without it, use Postgres routing.
          payload: storeRoutingEnabled
            ? { runId: run.taskRunId, organizationId }
            : { runId: run.taskRunId },
          availableAt,
        });

        if (run.spanIdToComplete) {
          this.$.eventBus.emit("cachedRunCompleted", {
            time: new Date(),
            span: {
              id: run.spanIdToComplete,
              createdAt: run.createdAt,
            },
            blockedRunId: run.taskRunId,
            hasError: output?.isError ?? false,
            cachedRunId: waitpoint.completedByTaskRunId ?? undefined,
          });
        }
      }

      // Ack only after the commit and the fanout. If the process dies first, the guard replays.
      if (armGuard) {
        await this.#ackCompletionGuard(id);
      }

      return waitpoint;
    } catch (error) {
      if (armGuard) {
        throw new WaitpointCompletionGuardArmedError(id, { cause: error });
      }
      throw error;
    }
  }

  /** Every MANUAL TTL writer prearms this while holding the existing source completion lock. */
  public async prearmManualCatalogRetirement(
    waitpointId: string,
    organizationId: string,
    availableAt = new Date()
  ): Promise<void> {
    await this.$.worker.enqueueOnce({
      id: `retireManualWaitpointCatalog:${waitpointId}`,
      job: "retireManualWaitpointCatalog",
      payload: { waitpointId, organizationId },
      availableAt,
    });
  }

  public async retireManualCatalog(payload: {
    waitpointId: string;
    organizationId: string;
  }): Promise<number | undefined> {
    if (!this.#waitpointStore?.retireManualCatalog)
      throw new Error("MANUAL catalog maintenance requires native store");
    return this.#waitpointStore.retireManualCatalog(payload.waitpointId, payload.organizationId);
  }

  public canReadStoreManualWaitpoints(organizationId: string): boolean | Promise<boolean> {
    return this.#storeWired ? this.isWaitpointStoreEnabled(organizationId) : false;
  }

  public async listStoreManualWaitpoints(
    params: ManualWaitpointCatalogListInput
  ): Promise<Waitpoint[]> {
    if (!this.#storeWired || !(await this.isWaitpointStoreEnabled(params.organizationId)))
      return [];
    if (params.id && classifyWaitpointCoordinator(params.id) !== "store") return [];
    if (!this.#waitpointStore?.manualCatalog) throw new Error("MANUAL catalog is not wired");
    return (await this.#waitpointStore.manualCatalog.list(params)).map((stored) =>
      waitpointFromStoredRecord(stored.record.id, stored)
    );
  }

  /** Native DATETIME, MANUAL and BATCH producers serialize with final delivery acknowledgement. */
  withWaitpointCompletionLock<T>(waitpointId: string, operation: () => Promise<T>): Promise<T> {
    return this.$.runLock.lockQueued(
      "waitpointCompletion",
      `waitpoint-completion:${waitpointId}`,
      operation
    );
  }

  #completionGuardId(waitpointId: string): string {
    return `ensureWaitpointCompleted:${waitpointId}`;
  }

  // enqueueOnce keeps the first writer's output. The delay gives the inline path time to ack. The
  // status-guarded update fixes the winning output, so a replay never overwrites it.
  async #scheduleCompletionGuard(
    waitpointId: string,
    output?: { value: string; type?: string; isError: boolean },
    organizationId?: string
  ): Promise<void> {
    await this.$.worker.enqueueOnce({
      id: this.#completionGuardId(waitpointId),
      job: "ensureWaitpointCompleted",
      payload:
        organizationId !== undefined
          ? { waitpointId, output, organizationId }
          : { waitpointId, output },
      availableAt: new Date(Date.now() + this.completionGuardDelayMs),
    });
  }

  async #ackCompletionGuard(waitpointId: string): Promise<void> {
    await this.$.worker.ack(this.#completionGuardId(waitpointId));
  }

  /**
   * Completion guard redelivery: replays the completion and fanout when the inline path died after
   * arming. The status-guarded update and the debounced continue make the replay idempotent. The
   * worker retries this job until it succeeds.
   */
  public async ensureWaitpointCompleted({
    waitpointId,
    output,
    organizationId,
  }: {
    waitpointId: string;
    output?: { value: string; type?: string; isError: boolean };
    organizationId?: string;
  }): Promise<void> {
    await this.completeWaitpoint({ id: waitpointId, output, organizationId, armGuard: false });
  }

  /**
   * Creates a DATETIME waitpoint that completes at `completedAfter`. With an `idempotencyKey`, an
   * existing waitpoint is returned.
   */
  async createDateTimeWaitpoint({
    runId,
    projectId,
    environmentId,
    organizationId,
    completedAfter,
    idempotencyKey,
    idempotencyKeyExpiresAt,
  }: {
    runId?: string;
    projectId: string;
    environmentId: string;
    /** The blocking run's org. Required to consider a store DATETIME mint; absent ⇒ legacy (dark). */
    organizationId?: string;
    completedAfter: Date;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
  }) {
    const enabled = !!(
      this.#storeWired &&
      organizationId &&
      (await this.isWaitpointStoreEnabled(organizationId))
    );
    let result: CreateWaitpointResult;
    if (!enabled) {
      result = await this.legacyCoordinator.createDateTimeWaitpoint({
        runId,
        projectId,
        environmentId,
        completedAfter,
        idempotencyKey,
        idempotencyKeyExpiresAt,
      });
    } else {
      const mintContext =
        enabled && runId && organizationId
          ? {
              organizationId,
            }
          : undefined;
      // The real application flag resolver reads PG. Resolve before the key transaction owns
      // a connection; the selected coordinator is trusted for this creation operation.
      const creationCoordinator =
        this.coordinator instanceof RoutingWaitpointCoordinator
          ? await this.coordinator.dateTimeCreationCoordinator(mintContext)
          : this.legacyCoordinator;
      const creationAcceptUntil = enabled && !idempotencyKey ? Date.now() + 300_000 : undefined;
      let storeId: string | undefined;
      const prearm = async (
        waitpointId: string,
        keyedCreation?: CreateDateTimeWaitpointParams["keyedCreation"]
      ) => {
        await this.$.worker.enqueueOnce({
          id: `recoverDateTimeWaitpoint:${waitpointId}`,
          job: "recoverDateTimeWaitpoint",
          payload: {
            waitpointId,
            organizationId: organizationId!,
            projectId,
            environmentId,
            completedAfter,
            creationAcceptUntil,
            ...(keyedCreation && idempotencyKey
              ? {
                  keyedCreation: {
                    scope: keyedCreation.scope,
                    acceptUntil: keyedCreation.acceptUntil,
                    idempotencyKey,
                  },
                }
              : {}),
          },
          availableAt: completedAfter,
        });
      };
      result = await this.#createUnderKeyClaim(
        { runId, projectId, environmentId, organizationId, idempotencyKey, enabled },
        async (keyedCreation, keyClaim) =>
          (creationCoordinator === this.legacyCoordinator && keyClaim
            ? this.legacyCoordinator.withKeyClaim(keyClaim)
            : creationCoordinator
          ).createDateTimeWaitpoint({
            runId,
            projectId,
            environmentId,
            completedAfter,
            idempotencyKey,
            idempotencyKeyExpiresAt,
            mintContext,
            keyedCreation,
            creationAcceptUntil,
            storeId,
            keyClaim,
            beforeStoreCreate: async (waitpointId) => {
              if (!storeId) await prearm(waitpointId, keyedCreation);
            },
          }),
        async (keyedCreation) => {
          storeId = generateWaitpointId("DATETIME");
          await prearm(storeId, keyedCreation);
        }
      );
    }

    if (result.kind === "cached") {
      // Reuse preserves the original identity and completion deadline in either owning store.
      return { waitpoint: result.waitpoint, isCached: true };
    }

    if (enabled && classifyWaitpointCoordinator(result.waitpoint.id) === "store") {
      return { waitpoint: result.waitpoint, isCached: false };
    }
    await this.$.worker.enqueue({
      id: `finishWaitpoint.${result.waitpoint.id}`,
      job: "finishWaitpoint",
      payload: enabled
        ? { waitpointId: result.waitpoint.id, organizationId }
        : { waitpointId: result.waitpoint.id },
      availableAt: completedAfter,
    });

    return { waitpoint: result.waitpoint, isCached: false };
  }

  #keyClaimOwner(params: {
    runId?: string;
    standaloneResidency?: "NEW" | "LEGACY";
    standaloneShardKey?: ShardKey;
  }): string {
    if (params.runId) return params.runId;
    const shard =
      params.standaloneShardKey ?? (params.standaloneResidency === "NEW" ? "new" : "legacy");
    return shard === "new"
      ? generateRunOpsId()
      : shard === "legacy"
        ? RunId.generate().id
        : generateRunOpsIdV2(shard);
  }

  /** One claim seam for enabled native token and PG creators sharing the existing raw key. */
  async #createUnderKeyClaim(
    params: {
      runId?: string;
      projectId: string;
      environmentId: string;
      organizationId?: string;
      idempotencyKey?: string;
      enabled: boolean;
      standaloneResidency?: "NEW" | "LEGACY";
      standaloneShardKey?: ShardKey;
    },
    create: (
      keyedCreation?: CreateDateTimeWaitpointParams["keyedCreation"],
      keyClaim?: CreateDateTimeWaitpointParams["keyClaim"]
    ) => Promise<CreateWaitpointResult>,
    prepare?: (
      keyedCreation: NonNullable<CreateDateTimeWaitpointParams["keyedCreation"]>
    ) => Promise<void>
  ): Promise<CreateWaitpointResult> {
    if (!params.enabled || !params.idempotencyKey) return create();
    if (!params.organizationId)
      throw new Error("Keyed waitpoint creation requires organization context");
    const key = params.idempotencyKey;
    const lowLevel = this.#waitpointStore;
    if (!lowLevel?.beginIdempotencyKeyClaim)
      throw new Error("Keyed waitpoint creation requires the waitpoint store");
    const beginClaim = lowLevel.beginIdempotencyKeyClaim.bind(lowLevel);
    const owner = this.#keyClaimOwner(params);
    // Preserve standalone token's existing cross-DB cached PG lookup, without holding a
    // connection while another primary read may need the same bounded connection pool.
    if (!params.runId && params.standaloneResidency) {
      const cached = await this.$.runStore.findWaitpoint(
        { where: { environmentId: params.environmentId, idempotencyKey: key } },
        this.$.prisma,
        { residency: params.standaloneResidency }
      );
      if (
        cached &&
        (!cached.idempotencyKeyExpiresAt || cached.idempotencyKeyExpiresAt.getTime() >= Date.now())
      )
        return { kind: "cached", waitpoint: cached };
    }
    await lowLevel.prepareForKeyedCreation?.();
    // Prearm candidate recovery before taking the PG mutex. Even a cached PG winner can
    // leave this unused candidate: recovery safely fences and retires its absent identity.
    const keyedCreation = {
      scope: `${params.environmentId}:${this.$.runStore.getWaitpointKeyScope(owner)}`,
      claimToken: nanoid(),
      acceptUntil: Date.now() + 4_500,
    };
    await prepare?.(keyedCreation);
    if (Date.now() >= keyedCreation.acceptUntil) {
      throw new WaitpointKeyTransactionBudgetExhaustedError();
    }
    return this.$.runStore.runInWaitpointKeyTransaction(
      owner,
      params.organizationId,
      keyedCreation.acceptUntil,
      async (store, tx) =>
        withCreationBudget(keyedCreation.acceptUntil, async () => {
          assertCreationBudget();
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([params.environmentId, key])}, 0))::text`;
          const legacy = await store.findWaitpoint(
            { where: { environmentId: params.environmentId, idempotencyKey: key } },
            tx
          );
          if (
            legacy &&
            (!legacy.idempotencyKeyExpiresAt ||
              legacy.idempotencyKeyExpiresAt.getTime() >= Date.now())
          )
            return { kind: "cached", waitpoint: legacy };
          const claim = await beginClaim({
            environmentId: keyedCreation.scope,
            idempotencyKey: key,
            token: keyedCreation.claimToken,
            acceptUntil: keyedCreation.acceptUntil,
          });
          // Prove the PG mutex still belongs to this exact transaction before any store
          // publication or expiry retirement. A delayed BEGIN never authorizes a dead tx.
          await tx.$queryRaw`SELECT 1`;
          if (legacy) {
            await store.updateWaitpoint(
              {
                where: { id: legacy.id },
                data: {
                  idempotencyKey: nanoid(24),
                  inactiveIdempotencyKey: legacy.idempotencyKey,
                },
              },
              tx
            );
          }
          if (claim.winnerId) {
            const waitpoint = await this.#readStoreDateTimeWaitpoint({
              waitpointId: claim.winnerId,
              environmentId: params.environmentId,
              projectId: params.projectId,
            });
            if (!waitpoint) throw new Error("Keyed DATETIME reservation winner is unavailable");
            return { kind: "cached", waitpoint };
          }
          return create(keyedCreation, { store, tx });
        })
    );
  }

  public async readExistingStoreDateTimeWaitpointByKey(params: {
    runId?: string;
    environmentId: string;
    projectId: string;
    organizationId?: string;
    idempotencyKey: string;
    standaloneResidency?: "NEW" | "LEGACY";
    standaloneShardKey?: ShardKey;
  }): Promise<Waitpoint | null> {
    if (
      !this.#storeWired ||
      !this.#waitpointStore?.readIdempotencyKey ||
      !params.organizationId ||
      !(await this.isWaitpointStoreEnabled(params.organizationId))
    )
      return null;
    const scope = `${params.environmentId}:${this.$.runStore.getWaitpointKeyScope(this.#keyClaimOwner(params))}`;
    const id = await this.#waitpointStore.readIdempotencyKey(scope, params.idempotencyKey);
    return id ? this.readExistingStoreDateTimeWaitpoint({ ...params, waitpointId: id }) : null;
  }

  /** The run's current block edges from both stores, as continuation reads them. */
  public readRunBlockState(runId: string, organizationId: string): Promise<RunBlockEdge[]> {
    return this.coordinator.readRunBlockState(runId, { organizationId });
  }

  /** Internal, tenant-scoped history page; does not read or consume live fanout state. */
  public async readStoreWaitpointRelatedRunIds(params: {
    waitpointId: string;
    environmentId: string;
    projectId: string;
    organizationId?: string;
    cursor?: string;
  }): Promise<{ runIds: string[]; nextCursor?: string }> {
    const source = await this.readExistingStoreDateTimeWaitpoint(params);
    if (!source) return { runIds: [] };
    return (
      this.#waitpointStore?.readRelatedRunIds?.(params.waitpointId, params.cursor) ?? { runIds: [] }
    );
  }

  /** Read native DATETIME and MANUAL tokens for existing API, callback and dashboard consumers. */
  public async readExistingStoreDateTimeWaitpoint(params: {
    waitpointId: string;
    environmentId: string;
    projectId: string;
    organizationId?: string;
  }): Promise<Waitpoint | null> {
    if (
      !this.#waitpointStore ||
      !params.organizationId ||
      !(await this.isWaitpointStoreEnabled(params.organizationId))
    )
      return null;
    return this.#readStoreDateTimeWaitpoint(params);
  }

  /** Only callers that already authorized the operation may bypass the DB-backed flag resolver. */
  async #readStoreDateTimeWaitpoint(params: {
    waitpointId: string;
    environmentId: string;
    projectId: string;
  }): Promise<Waitpoint | null> {
    const parsed = parseWaitpointId(params.waitpointId);
    if (parsed.format !== "b32hexW" || (parsed.type !== "DATETIME" && parsed.type !== "MANUAL"))
      return null;
    const stored = (await this.#waitpointStore!.readCompletedRecords([params.waitpointId])).get(
      params.waitpointId
    );
    if (
      !stored ||
      (stored.record.type !== "DATETIME" && stored.record.type !== "MANUAL") ||
      stored.record.environmentId !== params.environmentId ||
      stored.record.projectId !== params.projectId
    )
      return null;
    const waitpoint = waitpointFromStoredRecord(params.waitpointId, stored);
    waitpoint.output = stored.completion?.output
      ? "inline" in stored.completion.output
        ? stored.completion.output.inline
        : stored.completion.output.ref
      : null;
    return waitpoint;
  }

  /** Native batch admission is decided once from the already-committed batch header. */
  async blockRunWithNativeBatch(params: {
    runId: string;
    batchId: string;
    projectId: string;
    environmentId: string;
    organizationId: string;
  }): Promise<Waitpoint | null | undefined> {
    if (
      !(this.coordinator instanceof RoutingWaitpointCoordinator) ||
      !(await this.coordinator.canCreateNativeBatch(params.organizationId))
    )
      return undefined;
    const id = deriveBatchWaitpointId(params.batchId);
    if (!id) return undefined;
    const batch = await this.$.runStore.findBatchTaskRunById(params.batchId);
    if (!batch) throw new Error("Batch header is not committed");
    if (batch.resumedAt) return null;
    const marked = batchStoreWaitpointId(batch.options);
    // Existing Postgres headers keep their immutable storage when the flag changes.
    if (
      !marked &&
      (await this.$.runStore.findWaitpoint(
        { where: { completedByBatchId: params.batchId } },
        this.$.prisma
      ))
    )
      return undefined;
    const snapshot = await getLatestExecutionSnapshot(
      this.$.prisma,
      params.runId,
      this.$.runStore,
      params.environmentId,
      params.organizationId
    );
    const payload = { ...params, cycleAnchor: cycleAnchorSnapshotId(snapshot) };
    await this.$.worker.enqueueOnce({
      id: `recoverBatchWaitpoint:${params.batchId}`,
      job: "recoverBatchWaitpoint",
      payload,
      availableAt: new Date(Date.now() + (this.options.completionGuardDelayMs ?? 30000)),
    });
    if (!(await this.isStoreRoutingEnabled(params.organizationId)))
      throw new Error("Native batch publication is disabled");
    await this.$.runStore.markBatchWaitpointOnStore(params.batchId, id);
    const result = await this.#publishNativeBatch(payload);
    await this.$.worker.ack(`recoverBatchWaitpoint:${params.batchId}`);
    return result;
  }

  async recoverBatchWaitpoint(
    payload: z.infer<typeof workerCatalog.recoverBatchWaitpoint.schema>
  ): Promise<void> {
    if (!(await this.isWaitpointStoreEnabled(payload.organizationId))) return;
    const batch = await this.$.runStore.findBatchTaskRunById(payload.batchId);
    if (!batch || batch.runtimeEnvironmentId !== payload.environmentId)
      throw new Error("Batch recovery ownership conflict");
    if (batch.resumedAt) return;
    if (batchStoreWaitpointId(batch.options) !== deriveBatchWaitpointId(payload.batchId))
      throw new Error("Batch publication not committed");
    await this.#publishNativeBatch(payload);
  }

  async #publishNativeBatch(
    payload: z.infer<typeof workerCatalog.recoverBatchWaitpoint.schema>
  ): Promise<Waitpoint> {
    const result = await this.coordinator.createBatchWaitpoint({
      ...payload,
      requireStore: true,
      mintContext: {
        organizationId: payload.organizationId,
        eligibleTypes: new Set(["BATCH"] as const),
      },
    });
    if (classifyWaitpointCoordinator(result.waitpoint.id) !== "store")
      throw new Error("Native batch publication is disabled");
    // The batch can finish while its native header is being published. Reconcile the durable
    // business state before registration, as RUN publication does for already-finished children.
    const batch = await this.$.runStore.findBatchTaskRunById(payload.batchId);
    let waitpoint = result.waitpoint;
    if (batch?.status === "COMPLETED" || batch?.status === "ABORTED") {
      waitpoint = await this.completeWaitpoint({
        id: waitpoint.id,
        organizationId: payload.organizationId,
        output:
          batch.status === "ABORTED"
            ? { value: JSON.stringify(batchTimeoutError(batch)), isError: true }
            : { value: "Batch waitpoint completed", isError: false },
      });
    }
    try {
      await this.blockRunWithWaitpoint({
        runId: payload.runId,
        waitpoints: result.waitpoint.id,
        projectId: payload.projectId,
        organizationId: payload.organizationId,
        batch: { id: payload.batchId },
        blockOperation: {
          id: `block:${payload.runId}:${payload.cycleAnchor}`,
          absorptionId: payload.batchId,
          cycleAnchor: payload.cycleAnchor,
        },
      });
    } catch (error) {
      if (!(error instanceof StoreWaitpointBlockCycleAdvanced)) throw error;
    }
    if (batch?.status === "COMPLETED" || batch?.status === "ABORTED")
      await this.$.runStore.updateManyBatchTaskRun(
        { where: { id: payload.batchId, resumedAt: null }, data: { resumedAt: new Date() } },
        this.$.prisma
      );
    return waitpoint;
  }

  async completeBatchWaitpoint(params: {
    batchId: string;
    options: unknown;
    organizationId?: string;
    output: { value: string; isError: boolean };
  }): Promise<boolean> {
    // Read the internal identity only after rollout admission. Disabled paths preserve the PG lookup.
    const enabled =
      this.coordinator instanceof RoutingWaitpointCoordinator &&
      (await this.coordinator.isStoreRoutingEnabled(params.organizationId));
    const id = enabled ? batchStoreWaitpointId(params.options) : undefined;
    if (id) {
      await this.completeWaitpoint({
        id,
        organizationId: params.organizationId,
        output: params.output,
      });
      return true;
    }
    return false;
  }

  async nativeBatchWaitpointId(batchId: string): Promise<string | undefined> {
    const batch = await this.$.runStore.findBatchTaskRunById(batchId);
    return batchStoreWaitpointId(batch?.options);
  }

  async blockBatchChild(params: {
    runId: string;
    waitpointId: string;
    projectId: string;
    organizationId: string;
    batch: { id: string; index?: number };
    workerId?: string;
    runnerId?: string;
    ownerWaitpointId?: string;
  }): Promise<void> {
    const snapshot = await getLatestExecutionSnapshot(
      this.$.prisma,
      params.runId,
      this.$.runStore,
      undefined,
      params.organizationId
    );
    const owner = params.ownerWaitpointId ?? (await this.nativeBatchWaitpointId(params.batch.id));
    try {
      await this.blockRunWithWaitpoint({
        ...params,
        waitpoints: params.waitpointId,
        requirePendingWaitpointId: owner,
        blockOperation: {
          id: `block:${params.runId}:${cycleAnchorSnapshotId(snapshot)}`,
          absorptionId: params.waitpointId,
          cycleAnchor: cycleAnchorSnapshotId(snapshot),
        },
      });
    } catch (error) {
      if (
        error instanceof StoreWaitpointBlockCycleAdvanced ||
        (error instanceof StoreWaitpointBlockRefusedError && error.outcome === "ownerGone")
      )
        return;
      throw error;
    }
  }

  /** Creates a MANUAL waitpoint. With an `idempotencyKey`, an existing waitpoint is returned. */
  async createManualWaitpoint({
    runId,
    environmentId,
    projectId,
    organizationId,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    timeout,
    tags,
    standaloneResidency,
    standaloneShardKey,
  }: {
    runId?: string;
    environmentId: string;
    projectId: string;
    organizationId?: string;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    timeout?: Date;
    tags?: string[];
    // Standalone token only (no `runId`): the env's mint residency, so the token does not default
    // to LEGACY by its cuid id shape. Ignored when `runId` is set.
    standaloneResidency?: "NEW" | "LEGACY";
    standaloneShardKey?: ShardKey;
  }): Promise<{ waitpoint: Waitpoint; isCached: boolean }> {
    const enabled = !!(
      this.#storeWired &&
      organizationId &&
      (await this.isWaitpointStoreEnabled(organizationId))
    );
    let result: CreateWaitpointResult;
    if (!enabled) {
      result = await this.legacyCoordinator.createManualWaitpoint({
        runId,
        environmentId,
        projectId,
        idempotencyKey,
        idempotencyKeyExpiresAt,
        timeout,
        tags,
        standaloneResidency,
        standaloneShardKey,
      });
    } else {
      const mintContext =
        runId && organizationId
          ? { organizationId, eligibleTypes: new Set(["MANUAL"] as const) }
          : undefined;
      const creationCoordinator =
        this.coordinator instanceof RoutingWaitpointCoordinator
          ? await this.coordinator.manualCreationCoordinator(mintContext)
          : this.legacyCoordinator;
      const creationAcceptUntil = !idempotencyKey ? Date.now() + 300_000 : undefined;
      let storeId: string | undefined;
      const prearm = async (
        waitpointId: string,
        keyedCreation?: CreateDateTimeWaitpointParams["keyedCreation"]
      ) => {
        await this.prearmManualCatalogRetirement(
          waitpointId,
          organizationId!,
          new Date(keyedCreation?.acceptUntil ?? creationAcceptUntil!)
        );
        await this.$.worker.enqueueOnce({
          id: `recoverDateTimeWaitpoint:${waitpointId}`,
          job: "recoverDateTimeWaitpoint",
          payload: {
            waitpointId,
            organizationId: organizationId!,
            projectId,
            environmentId,
            completedAfter: timeout ?? new Date(keyedCreation?.acceptUntil ?? creationAcceptUntil!),
            manual: true,
            creationAcceptUntil,
            ...(keyedCreation && idempotencyKey
              ? {
                  keyedCreation: {
                    scope: keyedCreation.scope,
                    acceptUntil: keyedCreation.acceptUntil,
                    idempotencyKey,
                  },
                }
              : {}),
          },
          availableAt: timeout ?? new Date(keyedCreation?.acceptUntil ?? creationAcceptUntil!),
        });
      };
      result = await this.#createUnderKeyClaim(
        {
          runId,
          projectId,
          environmentId,
          organizationId,
          idempotencyKey,
          enabled,
          standaloneResidency,
          standaloneShardKey,
        },
        async (keyedCreation, keyClaim) =>
          (creationCoordinator === this.legacyCoordinator && keyClaim
            ? this.legacyCoordinator.withKeyClaim(keyClaim)
            : creationCoordinator
          ).createManualWaitpoint({
            runId,
            environmentId,
            projectId,
            idempotencyKey,
            idempotencyKeyExpiresAt,
            timeout,
            tags,
            standaloneResidency,
            standaloneShardKey,
            mintContext,
            keyedCreation,
            creationAcceptUntil,
            storeId,
            keyClaim,
            beforeStoreCreate: async (id) => {
              if (!storeId) await prearm(id, keyedCreation);
            },
          }),
        creationCoordinator === this.legacyCoordinator
          ? undefined
          : async (keyedCreation) => {
              storeId = generateWaitpointId("MANUAL");
              await prearm(storeId, keyedCreation);
            }
      );
    }

    if (enabled && classifyWaitpointCoordinator(result.waitpoint.id) === "store") {
      return { waitpoint: result.waitpoint, isCached: result.kind === "cached" };
    }
    if (result.kind === "cached") {
      return { waitpoint: result.waitpoint, isCached: true };
    }

    if (timeout) {
      await this.$.worker.enqueue({
        id: `finishWaitpoint.${result.waitpoint.id}`,
        job: "finishWaitpoint",
        payload: enabled
          ? {
              waitpointId: result.waitpoint.id,
              organizationId,
              error: JSON.stringify(timeoutError(timeout)),
            }
          : {
              waitpointId: result.waitpoint.id,
              error: JSON.stringify(timeoutError(timeout)),
            },
        availableAt: timeout,
      });
    }

    return { waitpoint: result.waitpoint, isCached: false };
  }

  /**
   * Blocks a run until the waitpoints complete.
   *
   * The edge write is routed by run id to the run's store. Pinning it to the caller's control-plane
   * tx would join `Waitpoint` on the wrong DB and write 0 edges, so the parent never suspends. The
   * edge write is idempotent, so a retry after a crash before the snapshot write is safe.
   *
   * The pending check is a separate statement on purpose: under READ COMMITTED it sees a completion
   * that commits after the edge write. It checks every requested id, because an existing edge to a
   * PENDING waitpoint must still block.
   */
  async blockRunWithWaitpoint({
    runId,
    waitpoints,
    projectId,
    organizationId,
    timeout,
    spanIdToComplete,
    batch,
    workerId,
    runnerId,
    expectedEnvironmentId,
    blockOperation,
    requirePendingWaitpointId,
    recoverOnly = false,
    tx,
  }: {
    runId: string;
    waitpoints: string | string[];
    projectId: string;
    organizationId: string;
    timeout?: Date;
    spanIdToComplete?: string;
    batch?: { id: string; index?: number };
    workerId?: string;
    runnerId?: string;
    // Use the caller's block ID and cycle anchor for MemoryDB waits.
    // Keep them unchanged within a wait cycle. Check the anchor under the run lock
    // before writing to MemoryDB, even if the old block is gone.
    // Postgres-only waits ignore these fields.
    blockOperation?: {
      id: string;
      absorptionId: string;
      cycleAnchor: string;
      expectedPreviousBlockId?: string;
    };
    // An environment the run MUST belong to. When set, the run's snapshot read is scoped to it, so a
    // run from another org/project/env yields no snapshot and throws (404) BEFORE any edge is
    // registered — the cross-org registration guard for the public token-wait route. The run's
    // snapshots are all in its own environment, so a snapshot found under this id proves membership.
    expectedEnvironmentId?: string;
    /** Recovery can finish an accepted request. It cannot accept a new request. */
    recoverOnly?: boolean;
    requirePendingWaitpointId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRunExecutionSnapshot> {
    const prisma = tx ?? this.$.prisma;
    await this.$.raceSimulationSystem.waitForRacepoint({ runId });

    let $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    return await this.$.runLock.lock("blockRunWithWaitpoint", [runId], async () => {
      // Scoped to expectedEnvironmentId when the caller supplied one: a foreign run has no snapshot in
      // that env, so this throws before registerBlocks and no cross-org edge is written.
      let snapshot: TaskRunExecutionSnapshot = await getLatestExecutionSnapshot(
        prisma,
        runId,
        this.$.runStore,
        expectedEnvironmentId,
        organizationId
      );

      const storeRoutingEnabled =
        this.coordinator instanceof RoutingWaitpointCoordinator &&
        (await this.coordinator.isStoreRoutingEnabled(organizationId));
      if (storeRoutingEnabled && batch && !requirePendingWaitpointId) {
        const owner = await this.nativeBatchWaitpointId(batch.id);
        // The header publishes its own edge. All later items, including cached legacy
        // associations, must join while that header still belongs to this parent block.
        if (owner && !$waitpoints.includes(owner)) requirePendingWaitpointId = owner;
      }
      const hasStoreAdmission =
        storeRoutingEnabled &&
        (!!requirePendingWaitpointId ||
          $waitpoints.some((id) => classifyWaitpointCoordinator(id) === "store"));
      if (!blockOperation && storeRoutingEnabled && hasStoreAdmission) {
        const anchor = cycleAnchorSnapshotId(snapshot);
        blockOperation = {
          id: `block:${runId}:${anchor}`,
          absorptionId: $waitpoints.join(":"),
          cycleAnchor: anchor,
        };
      }
      // Lifecycle precondition for a store-format blocker, checked UNDER THE RUN LOCK and BEFORE any
      // coordinator is mutated: the caller-captured TRES cycle anchor must still match the run's current
      // active cycle. This fences a delayed operation from an attempt that has since resumed, retried or
      // requeued — even when MemoryDB currently holds no block (a non-terminal abandon), which the store's
      // compare-and-set alone cannot catch. A same-cycle registration or retry sees a matching anchor.
      if (storeRoutingEnabled && hasStoreAdmission) {
        const currentAnchor = cycleAnchorSnapshotId(snapshot);
        if (blockOperation && blockOperation.cycleAnchor !== currentAnchor) {
          throw new StoreWaitpointBlockCycleAdvanced({
            runId,
            waitpointIds: $waitpoints.filter((id) => classifyWaitpointCoordinator(id) === "store"),
            expectedCycleAnchor: blockOperation.cycleAnchor,
            currentCycleAnchor: currentAnchor,
          });
        }

        if (blockOperation && batch) {
          // Give each batch position its own registration ID, including its waitpoint set.
          // Derive it from the original request so caller retries and recovery use the same ID.
          // Hash the inputs to limit key length. Keep the block and cycle IDs unchanged.
          const registrationId = createHash("sha256")
            .update(
              JSON.stringify([batch.id, batch.index ?? null, [...new Set($waitpoints)].sort()])
            )
            .digest("hex");
          blockOperation = {
            ...blockOperation,
            absorptionId: `${blockOperation.id}:batch:${registrationId}`,
          };
        }
      }

      if (
        recoverOnly &&
        (!storeRoutingEnabled ||
          !blockOperation ||
          !(await this.coordinator.hasAbsorbedBlockers({
            runId,
            blockId: blockOperation.id,
            absorptionId: blockOperation.absorptionId,
            waitpointIds: $waitpoints,
            batchIndex: batch?.index,
            organizationId,
          })))
      ) {
        if (storeRoutingEnabled && blockOperation) {
          // A crash may leave source holds before absorption was accepted.
          await this.coordinator.compensateAbsorption({
            runId,
            blockId: blockOperation.id,
            absorptionId: blockOperation.absorptionId,
            organizationId,
            unacceptedEvidence: registrationEvidence($waitpoints, batch?.index),
          });
        }
        return snapshot;
      }

      if (
        storeRoutingEnabled &&
        blockOperation &&
        $waitpoints.some((id) => classifyWaitpointCoordinator(id) === "store")
      ) {
        await this.$.worker.enqueueOnce({
          id: `recoverWaitpointBlock:${runId}:${blockOperation.absorptionId}`,
          job: "recoverWaitpointBlock",
          payload: {
            runId,
            organizationId,
            projectId,
            waitpoints: $waitpoints,
            blockOperation,
            timeout,
            spanIdToComplete,
            batch,
            workerId,
            runnerId,
            expectedEnvironmentId,
          },
          availableAt: new Date(Date.now() + (this.options.completionGuardDelayMs ?? 30_000)),
        });
      }

      // Phase 1: record the waits and count pending results.
      // MemoryDB waits require the caller's block identity, independent of TRES residency.
      // Pass the returned registration to phase 3 without changes.
      let registration: BlockerRegistration | undefined;
      let pendingCount: number;
      if (storeRoutingEnabled) {
        let absorbed;
        try {
          absorbed = await this.#absorbBlockersWithCompensationGuard({
            runId,
            blockId: blockOperation?.id,
            absorptionId: blockOperation?.absorptionId,
            expectedPreviousBlockId: blockOperation?.expectedPreviousBlockId,
            organizationId,
            waitpointIds: $waitpoints,
            projectId,
            spanIdToComplete,
            batchId: batch?.id,
            batchIndex: batch?.index,
            client: prisma,
            parentResidency: snapshotRouteFromSnapshot(snapshot)?.residency,
            requirePendingWaitpointId,
          });
        } catch (error) {
          if (
            requirePendingWaitpointId &&
            error instanceof StoreWaitpointBlockRefusedError &&
            error.outcome === "ownerGone"
          )
            return snapshot;
          throw error;
        }
        registration = absorbed.registration;
        pendingCount = absorbed.pendingCount;
      } else {
        ({ pendingCount } = await this.legacyCoordinator.registerBlocks({
          runId,
          waitpointIds: $waitpoints,
          projectId,
          spanIdToComplete,
          batchId: batch?.id,
          batchIndex: batch?.index,
          client: prisma,
        }));
      }

      let newStatus: TaskRunExecutionStatus = "SUSPENDED";
      if (
        snapshot.executionStatus === "EXECUTING" ||
        snapshot.executionStatus === "EXECUTING_WITH_WAITPOINTS"
      ) {
        newStatus = "EXECUTING_WITH_WAITPOINTS";
      }

      // Phase 2: save the blocked snapshot before registering MemoryDB watchers.
      if (newStatus !== snapshot.executionStatus) {
        snapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run: {
            id: snapshot.runId,
            status: snapshot.runStatus,
            attemptNumber: snapshot.attemptNumber,
          },
          snapshot: {
            executionStatus: newStatus,
            description: WAITPOINT_BLOCKED_SNAPSHOT_DESCRIPTION,
          },
          previousSnapshotId: snapshot.id,
          previousSnapshot: snapshot,
          snapshotRoute: snapshotRouteFromSnapshot(snapshot),
          environmentId: snapshot.environmentId,
          environmentType: snapshot.environmentType,
          projectId: snapshot.projectId,
          organizationId,
          // Never carry over the previous snapshot's batchId.
          batchId: batch?.id,
          workerId,
          runnerId,
        });

        // Tell the worker now, so it can suspend the run.
        await sendNotificationToWorker({ runId, snapshot, eventBus: this.$.eventBus });
      }

      // Phase 3: register watchers and collect results that completed during registration.
      // Use the updated pending count to decide whether the run can resume.
      if (registration) {
        const result = await this.coordinator.registerBlockers(registration);
        pendingCount = result.pendingCount;
        const cachedSpanCompletions = result.cachedSpanCompletions;

        // Registration succeeded. Remove this operation's cleanup job.
        // Keep its acceptance proof until the remaining jobs and events are handled.
        if (blockOperation?.absorptionId) {
          await this.$.worker.ack(
            this.#absorptionCompensationObligationId(
              runId,
              blockOperation.id,
              blockOperation.absorptionId
            )
          );
        }

        // Close trace spans for results that completed before watcher registration.
        // Other waits can still block the run. Repeated completion events are safe.
        for (const span of cachedSpanCompletions ?? []) {
          this.$.eventBus.emit("cachedRunCompleted", {
            time: new Date(),
            span: { id: span.spanId, createdAt: new Date(span.spanCreatedAt) },
            blockedRunId: span.blockedRunId,
            hasError: span.hasError,
            cachedRunId: span.cachedRunId,
          });
        }
      }
      const isRunBlocked = pendingCount > 0;

      if (timeout) {
        for (const waitpoint of $waitpoints) {
          await this.$.worker.enqueue({
            id: `finishWaitpoint.${waitpoint}`,
            job: "finishWaitpoint",
            payload: storeRoutingEnabled
              ? {
                  waitpointId: waitpoint,
                  organizationId,
                  error: JSON.stringify(timeoutError(timeout)),
                }
              : { waitpointId: waitpoint, error: JSON.stringify(timeoutError(timeout)) },
            availableAt: timeout,
          });
        }
      }

      if (!isRunBlocked) {
        await this.$.worker.enqueue({
          // The fixed job id debounces rapid repeat blocks.
          id: `continueRunIfUnblocked:${runId}`,
          job: "continueRunIfUnblocked",
          payload: storeRoutingEnabled ? { runId, organizationId } : { runId },
          availableAt: new Date(Date.now() + 50),
        });
      }

      if (storeRoutingEnabled && blockOperation) {
        await this.coordinator.finalizeBlockers({
          runId,
          blockId: blockOperation.id,
          absorptionId: blockOperation.absorptionId,
          waitpointIds: $waitpoints,
          batchIndex: batch?.index,
          organizationId,
        });
        await this.$.worker.ack(`recoverWaitpointBlock:${runId}:${blockOperation.absorptionId}`);
      }
      return snapshot;
    });
  }

  /** Use the same cleanup guard for the batch header and its Postgres edge. */
  async withLegacyRegistrationLock<T>(
    runId: string,
    organizationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    // The router checks the flag before admission and again under the acquired run lock.
    return this.coordinator instanceof RoutingWaitpointCoordinator
      ? this.coordinator.withLegacyRegistrationLock(runId, { organizationId }, operation)
      : operation();
  }

  /**
   * Lockless early refusal for a legacy child whose parent already owes store cleanup.
   * The parent run lock is taken only by the edge write, which re-reads the fence under it; a fence
   * armed between this check and that write refuses the edge there, so the parent's edge set stays safe.
   */
  async admitLegacyRegistration<T>(
    runId: string,
    organizationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.coordinator instanceof RoutingWaitpointCoordinator) {
      await this.coordinator.assertNoCleanupOwed(runId, { organizationId });
    }
    return operation();
  }

  /**
   * Register batch-item edges after the batch header has published the blocked snapshot.
   * Disabled organisations retain the lockless, idempotent Postgres insert and timeout scheduling.
   * Enabled organisations queue admission locally and take the parent run lock only around the
   * edge write, which re-checks the cleanup fence.
   */
  async blockRunWithWaitpointLockless({
    runId,
    waitpoints,
    projectId,
    organizationId,
    timeout,
    spanIdToComplete,
    batch,
  }: {
    runId: string;
    waitpoints: string | string[];
    projectId: string;
    organizationId?: string;
    timeout?: Date;
    spanIdToComplete?: string;
    batch: { id: string; index?: number };
  }): Promise<void> {
    const $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    // Keep the lockless path when disabled. When enabled, take the run lock before
    // checking the marker and writing the edge. Unmarked parents do not access MemoryDB.
    // The batch already has a blocked snapshot, so no pending count is needed.
    // Routing checks the flag before native preparation or locking.
    await this.coordinator.registerBlocksLockless({
      runId,
      organizationId,
      waitpointIds: $waitpoints,
      projectId,
      spanIdToComplete,
      batchId: batch.id,
      batchIndex: batch.index,
    });

    if (timeout) {
      for (const waitpoint of $waitpoints) {
        await this.$.worker.enqueue({
          id: `finishWaitpoint.${waitpoint}`,
          job: "finishWaitpoint",
          payload: {
            waitpointId: waitpoint,
            organizationId,
            error: JSON.stringify(timeoutError(timeout)),
          },
          availableAt: timeout,
        });
      }
    }
  }

  /**
   * For a pre-failed child run: blocks the parent so it receives the error output, then completes
   * the waitpoint.
   */
  async blockRunAndCompleteWaitpoint({
    runId,
    waitpointId,
    output,
    projectId,
    organizationId,
    batch,
    blockOperation,
  }: {
    runId: string;
    waitpointId: string;
    output: { value: string; type?: string; isError: boolean };
    projectId: string;
    organizationId: string;
    batch?: { id: string; index?: number };
    /** Caller-owned identity for a store-format waitpoint; undefined for a legacy blocker (ignored). */
    blockOperation?: { id: string; absorptionId: string; cycleAnchor: string };
  }): Promise<void> {
    if (
      batch &&
      classifyWaitpointCoordinator(waitpointId) === "store" &&
      (await this.isStoreRoutingEnabled(organizationId))
    ) {
      await this.blockBatchChild({ runId, waitpointId, projectId, organizationId, batch });
    } else {
      await this.blockRunWithWaitpoint({
        runId,
        waitpoints: waitpointId,
        projectId,
        organizationId,
        batch,
        blockOperation,
      });
    }

    await this.completeWaitpoint({
      id: waitpointId,
      output,
      organizationId,
    });
  }

  /** Finish cleanup only when the exact resume snapshot committed. */
  async #convergeAdvancedResumeHandoff({
    runId,
    observedStoreBlockId,
    organizationId,
    waitpointsOnStore,
    blockingWaitpoints,
    terminal,
  }: {
    runId: string;
    observedStoreBlockId: string | undefined;
    organizationId?: string;
    waitpointsOnStore: boolean;
    blockingWaitpoints: RunBlockEdge[];
    terminal: boolean;
  }): Promise<void> {
    if (!observedStoreBlockId && !waitpointsOnStore) return;
    // Nothing to converge: no store block observed AND no consumed edges left behind. Keep the no-op skip
    // (and its cost) for the common case of an already-fully-drained advanced run.
    if (!observedStoreBlockId && blockingWaitpoints.length === 0) {
      return;
    }
    if (terminal) {
      // Terminal-first release deletes the run's legacy edge rows and installs the store fence (fenced to
      // the observed block, a no-op when none is observed).
      await this.coordinator.releaseRunBlockers({
        runId,
        reason: "terminal",
        organizationId,
        blockId: observedStoreBlockId,
      });
      return;
    }
    const intent = await this.coordinator.readResumeIntent(runId, { organizationId });
    if (!intent || (observedStoreBlockId && intent.blockId !== observedStoreBlockId)) return;
    // The legacy delete is atomic. Empty means it may already have succeeded before the store ack failed.
    const hasLegacyEdges = blockingWaitpoints.some(
      (edge) => classifyWaitpointCoordinator(edge.waitpoint.id) === "legacy"
    );
    if (hasLegacyEdges && intent.legacyEdgeIdsHash !== legacyResumeEdgeIdsHash(blockingWaitpoints))
      return;
    const resumed = await this.$.runStore.findExecutionSnapshot(
      { where: { id: intent.snapshotId, runId }, select: { id: true } },
      this.$.prisma,
      organizationId
    );
    if (!resumed) return;
    await this.coordinator.acknowledgeResume({
      runId,
      blockId: observedStoreBlockId,
      organizationId,
      edgeIds: blockingWaitpoints.map((edge) => edge.id),
      resumeSnapshotId: intent.snapshotId,
    });
  }

  public async continueRunIfUnblocked({
    runId,
    organizationId,
  }: {
    runId: string;
    // The blocked run's org, carried independently of the route: the common delayed-completion enqueue
    // has no route but does know the org, so this keeps run-keyed routing from querying MemoryDB for
    // every legacy run. Old payloads recover this context from the environment already loaded below.
    organizationId?: string;
  }): Promise<WaitpointContinuationResult> {
    this.$.logger.debug(`continueRunIfUnblocked: start`, {
      runId,
    });

    await this.$.raceSimulationSystem.waitForRacepoint({ runId });

    // The org flag gates store discovery; enabled operations then consult this run's durable marker.
    let routingOrganizationId = organizationId;

    return await this.$.runLock.lock("continueRunIfUnblocked", [runId], async () => {
      // 1. Disabled orgs use the legacy reader; enabled orgs consult the durable run marker.
      let blockingWaitpoints = await this.coordinator.readRunBlockState(runId, {
        organizationId: routingOrganizationId,
      });

      // OBSERVE the exact store block this continuation is about to resume, before the resume transition,
      // so the acknowledgement below targets THIS block and not whichever block is installed by the time
      // it runs. A newer cycle installed in between makes the acknowledgement a stale no-op. Undefined for
      // a legacy-only run or an unmarked run.
      // Recheck in the router after the preceding read; do not cache enablement across I/O.
      let observedStoreBlockId =
        this.coordinator instanceof RoutingWaitpointCoordinator
          ? await this.coordinator.currentStoreBlockId(runId, {
              organizationId: routingOrganizationId,
            })
          : undefined;

      // 2. There are blockers still, so do nothing
      if (blockingWaitpoints.some((w) => w.waitpoint.status !== "COMPLETED")) {
        this.$.logger.debug(`continueRunIfUnblocked: blocking waitpoints still exist`, {
          runId,
          blockingWaitpointCount: blockingWaitpoints.length,
        });

        return {
          status: "blocked",
          waitpoints: blockingWaitpoints.map((w) => w.waitpoint),
        };
      }

      // The environment comes from the control-plane resolver, so there is no cross-provider join.
      const run = await this.$.runStore.findRun(
        {
          id: runId,
        },
        this.$.prisma
      );

      if (!run) {
        this.$.logger.error(`continueRunIfUnblocked: run not found`, {
          runId,
        });
        throw new Error(`continueRunIfUnblocked: run not found: ${runId}`);
      }

      const env = await this.$.controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);

      if (!env) {
        this.$.logger.error(`continueRunIfUnblocked: environment not found`, {
          runId,
          runtimeEnvironmentId: run.runtimeEnvironmentId,
        });
        throw new Error(
          `continueRunIfUnblocked: environment not found: ${run.runtimeEnvironmentId}`
        );
      }

      // A pre-deployment job may carry no org while its legacy batch parent subsequently
      // acquired reused store children. The environment was already loaded by the ordinary
      // continuation; only an enabled org re-reads the complete blocker set before resuming.
      if (
        routingOrganizationId === undefined &&
        (await this.isWaitpointStoreEnabled(env.organizationId))
      ) {
        routingOrganizationId = env.organizationId;
        blockingWaitpoints = await this.coordinator.readRunBlockState(runId, {
          organizationId: routingOrganizationId,
        });
        observedStoreBlockId = await this.coordinator.currentStoreBlockId(runId, {
          organizationId: routingOrganizationId,
        });
        if (blockingWaitpoints.some((w) => w.waitpoint.status !== "COMPLETED")) {
          return { status: "blocked", waitpoints: blockingWaitpoints.map((w) => w.waitpoint) };
        }
      }

      //4. Continue the run whether it's executing or not
      let snapshot: Awaited<ReturnType<typeof getLatestExecutionSnapshot>>;
      try {
        snapshot = await getLatestExecutionSnapshot(
          this.$.prisma,
          runId,
          this.$.runStore,
          undefined,
          env.organizationId
        );
      } catch (error) {
        if (!isExpiredSnapshotOfFinishedRun(error, run.status)) {
          throw error;
        }
        this.$.logger.warn("continueRunIfUnblocked: snapshot state expired, run already finished", {
          runId,
        });
        if (await this.isWaitpointStoreEnabled(routingOrganizationId)) {
          await this.#convergeAdvancedResumeHandoff({
            runId,
            observedStoreBlockId,
            organizationId: routingOrganizationId,
            waitpointsOnStore: hasStoreWaitpoints(run.annotations),
            blockingWaitpoints,
            terminal: true,
          });
        }
        return {
          status: "skipped",
          reason: "run is finished",
        };
      }

      let resumeSnapshotId: string | undefined;
      if (
        (snapshot.executionStatus === "EXECUTING_WITH_WAITPOINTS" ||
          snapshot.executionStatus === "SUSPENDED") &&
        (observedStoreBlockId || hasStoreWaitpoints(run.annotations)) &&
        (await this.isWaitpointStoreEnabled(routingOrganizationId))
      ) {
        const intent = await this.coordinator.prepareResume({
          runId,
          organizationId: env.organizationId,
          intent: {
            snapshotId: this.executionSnapshotSystem.nextSnapshotIdentity(snapshot, runId).id,
            previousSnapshotId: snapshot.id,
            blockId: observedStoreBlockId,
            legacyEdgeIdsHash: legacyResumeEdgeIdsHash(blockingWaitpoints),
          },
        });
        resumeSnapshotId = intent?.snapshotId;
      }

      switch (snapshot.executionStatus) {
        case "RUN_CREATED": {
          this.$.logger.info(`continueRunIfUnblocked: run is run created, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already executing",
          };
        }
        case "DELAYED": {
          this.$.logger.debug(`continueRunIfUnblocked: run is delayed, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is delayed",
          };
        }
        case "QUEUED":
        case "PENDING_EXECUTING":
        case "QUEUED_EXECUTING":
        case "EXECUTING": {
          this.$.logger.info(`continueRunIfUnblocked: run already advanced, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          // Advanced status alone is not resume proof; converge only a durably consumed exact block.
          if (await this.isWaitpointStoreEnabled(routingOrganizationId)) {
            await this.#convergeAdvancedResumeHandoff({
              runId,
              observedStoreBlockId,
              organizationId: routingOrganizationId,
              waitpointsOnStore: hasStoreWaitpoints(run.annotations),
              blockingWaitpoints,
              terminal: false,
            });
          }

          return {
            status: "skipped",
            reason: "run already advanced past the blocked snapshot",
          };
        }
        case "PENDING_CANCEL":
        case "FINISHED": {
          this.$.logger.debug(`continueRunIfUnblocked: run is finished, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          // The run was torn down; release this exact block terminal-first rather than acknowledge it.
          if (await this.isWaitpointStoreEnabled(routingOrganizationId)) {
            await this.#convergeAdvancedResumeHandoff({
              runId,
              observedStoreBlockId,
              organizationId: routingOrganizationId,
              waitpointsOnStore: hasStoreWaitpoints(run.annotations),
              blockingWaitpoints,
              terminal: true,
            });
          }

          return {
            status: "skipped",
            reason: "run is finished",
          };
        }
        case "EXECUTING_WITH_WAITPOINTS": {
          const resolveCompletedWaitpointRecords = await this.#completedWaitpointRecordsResolver(
            runId,
            snapshot,
            blockingWaitpoints
          );
          const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
            this.$.prisma,
            {
              snapshotId: resumeSnapshotId,
              run: {
                id: runId,
                status: snapshot.runStatus,
                attemptNumber: snapshot.attemptNumber,
              },
              snapshot: {
                executionStatus: "EXECUTING",
                description: "Run was continued, whilst still executing.",
              },
              previousSnapshotId: snapshot.id,
              previousSnapshot: snapshot,
              snapshotRoute: snapshotRouteFromSnapshot(snapshot),
              environmentId: snapshot.environmentId,
              environmentType: snapshot.environmentType,
              projectId: snapshot.projectId,
              organizationId: snapshot.organizationId,
              batchId: this.#resumeBatchId(runId, snapshot.batchId, blockingWaitpoints),
              completedWaitpoints: blockingWaitpoints.map((b) => ({
                id: b.waitpoint.id,
                index: b.batchIndex ?? undefined,
              })),
              resolveCompletedWaitpointRecords,
            }
          );

          this.$.logger.debug(
            `continueRunIfUnblocked: run was still executing, sending notification`,
            {
              runId,
              snapshotId: snapshot.id,
              snapshotExecutionStatus: snapshot.executionStatus,
              newSnapshotId: newSnapshot.id,
              newSnapshotExecutionStatus: newSnapshot.executionStatus,
            }
          );

          await sendNotificationToWorker({
            runId,
            snapshot: newSnapshot,
            eventBus: this.$.eventBus,
          });

          break;
        }
        case "SUSPENDED": {
          if (!snapshot.checkpointId || !snapshot.checkpoint) {
            // Cancel clears the checkpoint of a run canceled mid-suspend: nothing to resume.
            if (snapshot.runStatus === "CANCELED") {
              this.$.logger.warn(
                `continueRunIfUnblocked: run was canceled while suspended, skipping`,
                {
                  runId,
                  snapshotId: snapshot.id,
                  executionStatus: snapshot.executionStatus,
                  runStatus: snapshot.runStatus,
                }
              );
              return {
                status: "skipped",
                reason: "run was canceled while suspended",
              };
            }

            this.$.logger.error(`continueRunIfUnblocked: run is suspended, but has no checkpoint`, {
              runId,
              snapshotId: snapshot.id,
              executionStatus: snapshot.executionStatus,
              runStatus: snapshot.runStatus,
            });
            throw new Error(
              `continueRunIfUnblocked: run is suspended, but has no checkpoint: ${runId}`
            );
          }

          // Re-enqueue with the original timestamp, so waiting runs dequeue before new runs.
          const resolveCompletedWaitpointRecords = await this.#completedWaitpointRecordsResolver(
            runId,
            snapshot,
            blockingWaitpoints
          );
          const newSnapshot = await this.enqueueSystem.enqueueRun({
            run,
            env,
            snapshotId: resumeSnapshotId,
            previousSnapshotId: snapshot.id,
            previousSnapshot: snapshot,
            snapshotRoute: snapshotRouteFromSnapshot(snapshot),
            snapshot: {
              status: "QUEUED",
              description: "Run was QUEUED, because all waitpoints are completed",
            },
            batchId: this.#resumeBatchId(runId, snapshot.batchId, blockingWaitpoints),
            completedWaitpoints: blockingWaitpoints.map((b) => ({
              id: b.waitpoint.id,
              index: b.batchIndex ?? undefined,
            })),
            resolveCompletedWaitpointRecords,
            checkpoint: snapshot.checkpoint,
          });

          this.$.logger.debug(`continueRunIfUnblocked: run goes to QUEUED`, {
            runId,
            snapshotId: snapshot.id,
            snapshotExecutionStatus: snapshot.executionStatus,
            newSnapshotId: newSnapshot.id,
            newSnapshotExecutionStatus: newSnapshot.executionStatus,
          });

          break;
        }
        default: {
          assertNever(snapshot.executionStatus);
        }
      }

      if (blockingWaitpoints.length > 0) {
        if (await this.isWaitpointStoreEnabled(routingOrganizationId)) {
          // 5. The resume snapshot above is now durable, so acknowledge the store handoff and drain the
          // consumed edges under the block-id fence. Until this boundary, the store keeps completed
          // receipts so a transient TRES failure retries rather than losing them.
          await this.coordinator.acknowledgeResume({
            runId,
            blockId: observedStoreBlockId,
            resumeSnapshotId,
            organizationId: routingOrganizationId,
            edgeIds: blockingWaitpoints.map((b) => b.id),
          });

          this.$.logger.debug(
            `continueRunIfUnblocked: acknowledged resume and drained waitpoints`,
            {
              runId,
              blockingWaitpointCount: blockingWaitpoints.length,
            }
          );
        } else {
          //5. Remove the blocking waitpoints
          await this.legacyCoordinator.clearRunBlockState({
            runId,
            organizationId: routingOrganizationId,
            edgeIds: blockingWaitpoints.map((b) => b.id),
          });

          this.$.logger.debug(`continueRunIfUnblocked: removed blocking waitpoints`, {
            runId,
            blockingWaitpointCount: blockingWaitpoints.length,
          });
        }
      }

      return {
        status: "unblocked",
        waitpoints: blockingWaitpoints.map((w) => w.waitpoint),
      };
    });
  }

  // A retried batch create can block an already-waiting run, leaving the snapshot on the first batch.
  // Child results carry their real batch on the edge, and the SDK matches results by it.
  #resumeBatchId(
    runId: string,
    snapshotBatchId: string | null,
    blockingWaitpoints: RunBlockEdge[]
  ): string | undefined {
    const childBatchIds: string[] = [];
    for (const edge of blockingWaitpoints) {
      // Only child-result edges carry a batchIndex. A batch's own waitpoint edge doesn't, and
      // counting it would add the abandoned batch from a retried create.
      if (edge.batchIndex !== null && edge.batchId && !childBatchIds.includes(edge.batchId)) {
        childBatchIds.push(edge.batchId);
      }
    }

    if (childBatchIds.length === 1) {
      const childBatchId = childBatchIds[0];
      if (childBatchId !== snapshotBatchId) {
        this.$.logger.warn("continueRunIfUnblocked: resuming with the child results' batch", {
          runId,
          snapshotBatchId,
          batchId: childBatchId,
        });
      }
      return childBatchId;
    }

    if (childBatchIds.length > 1) {
      this.$.logger.warn("continueRunIfUnblocked: child results belong to more than one batch", {
        runId,
        snapshotBatchId,
        batchIds: childBatchIds,
      });
    }

    return snapshotBatchId ?? undefined;
  }

  // A redis-primary cycle is built inside the owning Postgres transaction. Fetching its records
  // there waits for a second pooled connection, and concurrent resumes can exhaust the pool. So a
  // redis-primary resume fetches them here, before the transaction opens. Otherwise the thunk stays
  // lazy, and the store calls it only for a redis-primary write, never for postgres or mirrored.
  async #completedWaitpointRecordsResolver(
    runId: string,
    snapshot: { organizationId: string; metadata?: unknown },
    blockingWaitpoints: { waitpoint: { id: string } }[]
  ): Promise<() => Promise<CompletedWaitpointRecord[]>> {
    if (
      blockingWaitpoints.length > 0 &&
      snapshotRouteFromSnapshot(snapshot).residency === "redis-primary"
    ) {
      const records = await this.resolveResumeCompletedWaitpointRecords(
        runId,
        blockingWaitpoints,
        snapshot.organizationId
      );
      return async () => records;
    }
    return () =>
      this.resolveResumeCompletedWaitpointRecords(
        runId,
        blockingWaitpoints,
        snapshot.organizationId
      );
  }

  // Full records for a redis-primary cycle: the blocking edges carry only a 4-field pick. See
  // #completedWaitpointRecordsResolver for when it runs. The adapter path reads only COMPLETED
  // legacy rows, so a stray PENDING row is never described as a completion. TS-private so a test
  // can call it.
  private async resolveResumeCompletedWaitpointRecords(
    runId: string,
    blockingWaitpoints: { waitpoint: { id: string } }[],
    organizationId?: string
  ) {
    // Without a store, or for a disabled org, read Postgres only and do not classify ids.
    const organizationEnabled =
      this.#waitpointStore !== undefined &&
      organizationId !== undefined &&
      (await this.options.waitpointStoreEnabled?.(organizationId)) === true;
    if (!organizationEnabled) {
      const rows = await this.$.runStore.findManyWaitpoints(
        { where: { id: { in: boundedIn(blockingWaitpoints.map((b) => b.waitpoint.id)) } } },
        this.$.prisma,
        runId
      );
      return buildCompletedWaitpointRecords(rows);
    }
    return resolveCompletedWaitpointRecords({
      requestedIds: blockingWaitpoints.map((b) => b.waitpoint.id),
      legacyReader: async (ids) =>
        buildCompletedWaitpointRecords(
          await this.$.runStore.findManyWaitpoints(
            { where: { id: { in: boundedIn(ids) }, status: "COMPLETED" } },
            this.$.prisma,
            runId
          )
        ),
      storeReader: this.#waitpointStore
        ? (ids) => this.#waitpointStore!.readCompletedRecords(ids, runId)
        : undefined,
    });
  }

  public buildRunAssociatedWaitpoint({
    projectId,
    environmentId,
    anchorRunId,
  }: {
    projectId: string;
    environmentId: string;
    anchorRunId: string;
  }) {
    return this.legacyCoordinator.mintAssociatedWaitpointData({
      projectId,
      environmentId,
      anchorRunId,
    });
  }

  /**
   * Decide a NEW RUN waitpoint's residency from the per-org mint policy, independently of
   * the blocking parent's snapshot residency, and mint its data. With no store wired this is the legacy sync builder with NO parent-residency
   * resolution and NO MemoryDB call. Blocking uses the route on its authoritative snapshot.
   */
  public async planRunAssociatedWaitpoint(params: {
    projectId: string;
    environmentId: string;
    anchorRunId: string;
    parentRunId: string;
    organizationId: string;
    organizationFlags?: unknown;
  }): Promise<{ plan: AssociatedWaitpointPlan }> {
    if (
      !this.#storeWired ||
      !(await this.isWaitpointStoreEnabled(params.organizationId, params.organizationFlags))
    ) {
      return {
        plan: {
          residency: "legacy",
          data: this.buildRunAssociatedWaitpoint({
            projectId: params.projectId,
            environmentId: params.environmentId,
            anchorRunId: params.anchorRunId,
          }),
        },
      };
    }
    const plan = await this.coordinator.planAssociatedWaitpoint({
      projectId: params.projectId,
      environmentId: params.environmentId,
      anchorRunId: params.anchorRunId,
      mintContext: {
        organizationId: params.organizationId,
      },
    });
    return { plan };
  }

  /** Armed before child commit, carrying the original parent cycle. No active-run polling. */
  public async armRunWaitpointRecovery(
    payload: Omit<RecoverRunWaitpoint, "armedAt">
  ): Promise<void> {
    await this.$.worker.enqueueOnce({
      id: `recoverRunWaitpoint:${payload.runId}`,
      job: "recoverRunWaitpoint",
      payload: { ...payload, armedAt: new Date() },
      availableAt: new Date(Date.now() + (this.options.completionGuardDelayMs ?? 30_000)),
    });
  }

  public async recoverRunWaitpoint(payload: RecoverRunWaitpoint): Promise<"retired" | void> {
    if (!(await this.isWaitpointStoreEnabled(payload.organizationId))) return;
    const run = await this.$.runStore.findRunOnPrimary(
      { id: payload.runId },
      {
        select: {
          id: true,
          organizationId: true,
          projectId: true,
          runtimeEnvironmentId: true,
          status: true,
          output: true,
          outputType: true,
          error: true,
        },
      }
    );
    if (!run) {
      // Absence inside the window is not convergence: the producer may still be committing. Past
      // it, retire. A commit that lands later is inert: the parent is blocked only after createRun
      // by the same producer, the caller already received the trigger error and retried with a new
      // id, and the row is never enqueued, exactly as a flag-off crash between createRun and
      // publishRun leaves it. Keeping the job would retry for ~35 days and then DLQ.
      if (
        !payload.armedAt ||
        Date.now() - payload.armedAt.getTime() < RUN_WAITPOINT_RECOVERY_COMMIT_WINDOW_MS
      ) {
        throw new Error(`RUN waitpoint child not committed: ${payload.runId}`);
      }
      this.$.logger.warn("recoverRunWaitpoint: child never committed, retiring recovery", {
        runId: payload.runId,
        parentRunId: payload.parentRunId,
        waitpointId: payload.waitpointId,
      });
      return "retired";
    }
    if (
      run.organizationId !== payload.organizationId ||
      deriveRunWaitpointId(run.id) !== payload.waitpointId
    ) {
      throw new Error(`RUN waitpoint recovery ownership conflict: ${payload.runId}`);
    }
    // A shared child may be waited on by a different parent from the one that triggered it.
    // Bind this recovery to the child's identity and the waiting parent's owning environment.
    const parent = await this.$.runStore.findRunOnPrimary(
      {
        id: payload.parentRunId,
        organizationId: payload.organizationId,
        runtimeEnvironmentId: run.runtimeEnvironmentId,
        projectId: run.projectId,
      },
      { select: { id: true } }
    );
    if (!parent) {
      throw new Error(`RUN waitpoint recovery parent scope conflict: ${payload.parentRunId}`);
    }
    const data = {
      id: payload.waitpointId,
      friendlyId: WaitpointId.toFriendlyId(payload.waitpointId),
      type: "RUN" as const,
      status: "PENDING" as const,
      idempotencyKey: payload.waitpointId,
      userProvidedIdempotencyKey: false as const,
      projectId: run.projectId,
      environmentId: run.runtimeEnvironmentId,
    };
    await this.createAssociatedWaitpointRecord({
      runId: run.id,
      data,
      organizationId: payload.organizationId,
    });
    if (payload.batch) {
      await this.blockBatchChild({
        runId: payload.parentRunId,
        waitpointId: payload.waitpointId,
        projectId: run.projectId,
        organizationId: payload.organizationId,
        batch: payload.batch,
      });
      return;
    }
    await this.recoverWaitpointBlock({
      runId: payload.parentRunId,
      organizationId: payload.organizationId,
      projectId: run.projectId,
      waitpoints: [payload.waitpointId],
      blockOperation: payload.blockOperation,
      expectedEnvironmentId: run.runtimeEnvironmentId,
    });
    // Publication already reconciled terminal state. Normal finalization owns later completion;
    // parent registration captures completion that arrived before or during this block.
  }

  public async recoverWaitpointBlock(payload: RecoverWaitpointBlock): Promise<void> {
    if (!(await this.isWaitpointStoreEnabled(payload.organizationId))) return;
    try {
      await this.blockRunWithWaitpoint({ ...payload, recoverOnly: true });
    } catch (error) {
      // The run has moved to a later cycle. Clean up this old operation.
      if (error instanceof StoreWaitpointBlockCycleAdvanced) {
        // Reacquire the run lock before cleanup. Leave newer and terminal blocks unchanged.
        await this.ensureAbsorptionCompensated({
          runId: payload.runId,
          organizationId: payload.organizationId,
          blockId: payload.blockOperation.id,
          absorptionId: payload.blockOperation.absorptionId,
        });
        return;
      }
      throw error;
    }
  }

  // Existing DATETIME helper/job names and diagnostics also cover MANUAL deadlines and allocation
  // recovery. Keep the persisted job identity compatible with already queued work.
  public async recoverDateTimeWaitpoint(payload: RecoverDateTimeWaitpoint): Promise<void> {
    if (!(await this.isWaitpointStoreEnabled(payload.organizationId))) return;
    if (payload.keyedCreation) {
      const store = this.#waitpointStore;
      if (!store?.recoverIdempotencyCandidate || !store.acknowledgeIdempotencyCandidate) {
        throw new Error("Keyed DATETIME recovery requires the waitpoint store");
      }
      const recoverCandidate = store.recoverIdempotencyCandidate.bind(store);
      const acknowledgeCandidate = store.acknowledgeIdempotencyCandidate.bind(store);
      const candidate = {
        candidateId: payload.waitpointId,
        environmentId: payload.keyedCreation.scope,
        idempotencyKey: payload.keyedCreation.idempotencyKey,
        acceptUntil: payload.keyedCreation.acceptUntil,
      };
      const recover = async (pendingAllocation = false) => {
        const outcome = await recoverCandidate(candidate);
        // Only THIS attempt's published winner owns this deadline. A losing candidate must
        // not complete the winner at its own (possibly earlier) requested deadline.
        if (outcome.winnerId === payload.waitpointId && !outcome.completed) {
          const manual = payload.manual
            ? await this.readExistingStoreDateTimeWaitpoint({
                ...payload,
                waitpointId: outcome.winnerId,
              })
            : undefined;
          if (!pendingAllocation && (!payload.manual || manual?.completedAfter))
            await this.completeWaitpoint({
              id: payload.waitpointId,
              organizationId: payload.organizationId,
              onlyIfPending: true,
              ...(payload.manual && manual?.completedAfter
                ? {
                    output: {
                      value: JSON.stringify(timeoutError(manual.completedAfter)),
                      isError: true,
                    },
                  }
                : {}),
            });
        }
        const pendingManual =
          pendingAllocation &&
          (await this.#readStoreDateTimeWaitpoint(payload))?.status === "PENDING";
        const acknowledge = async () => {
          if (payload.manual)
            await this.prearmManualCatalogRetirement(payload.waitpointId, payload.organizationId);
          await acknowledgeCandidate({
            ...candidate,
            ...outcome,
            organizationId: payload.organizationId,
            pendingManual,
          });
        };
        if (payload.manual && !pendingAllocation) {
          await this.withWaitpointCompletionLock(payload.waitpointId, async () => {
            if (!(await this.isWaitpointStoreEnabled(payload.organizationId))) return;
            await acknowledge();
          });
        } else await acknowledge();
      };
      const manual = payload.manual ? await this.#readStoreDateTimeWaitpoint(payload) : undefined;
      if (manual && !manual.completedAfter) {
        // Allocation may finish independently of an untimed token. Fence every foreground
        // publication first, then serialize receipt retirement with completion/final fanout ACK.
        if (Date.now() <= candidate.acceptUntil)
          throw new Error("MANUAL allocation publication is not yet fenced");
        await this.withWaitpointCompletionLock(payload.waitpointId, async () => {
          if (!(await this.isWaitpointStoreEnabled(payload.organizationId))) return;
          await recover(true);
        });
      } else await recover();
      return;
    }
    const existing = await this.readExistingStoreDateTimeWaitpoint(payload);
    if (!existing) {
      // A published PENDING source has no TTL. Missing therefore means creation has not
      // published, or a completed source expired. Never recreate either identity. Until
      // the fixed fence closes, retry so a near/past deadline cannot outrun publication.
      if (payload.creationAcceptUntil === undefined || Date.now() <= payload.creationAcceptUntil) {
        throw new Error("DATETIME waitpoint publication is not yet fenced");
      }
      await this.#waitpointStore?.retirePendingSource?.(
        payload.waitpointId,
        payload.organizationId
      );
      return;
    }
    if (existing.status === "COMPLETED") {
      await this.#waitpointStore?.retirePendingSource?.(
        payload.waitpointId,
        payload.organizationId
      );
      return;
    }
    if (!payload.manual || existing.completedAfter)
      await this.completeWaitpoint({
        id: payload.waitpointId,
        organizationId: payload.organizationId,
        onlyIfPending: true,
        ...(payload.manual && existing.completedAfter
          ? {
              output: {
                value: JSON.stringify(timeoutError(existing.completedAfter)),
                isError: true,
              },
            }
          : {}),
      });
  }

  /** Publish a native RUN association and reconcile terminal state before its parent registers. */
  public async createAssociatedWaitpointRecord(params: {
    runId: string;
    data: AssociatedWaitpointData;
    organizationId?: string;
  }): Promise<void> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) {
      throw new Error("Existing store waitpoint association is disabled for this organization");
    }
    await this.coordinator.createAssociatedWaitpoint({ ...params, requireStore: true });
    if (classifyWaitpointCoordinator(params.data.id) !== "store") return;

    // Publish BEFORE the fresh primary read: completion before publication is replayed here;
    // completion after this read discovers the published source through the normal finish path.
    // The run returned by the original create is stale if cancellation won during publication.
    const publishedRun = await this.$.runStore.findRunOnPrimary(
      { id: params.runId },
      {
        select: { status: true, output: true, outputType: true, error: true, organizationId: true },
      }
    );
    if (!publishedRun) throw new Error(`RUN waitpoint child not committed: ${params.runId}`);
    if (!isFinalRunStatus(publishedRun.status)) return;

    if (publishedRun.status === "CANCELED") {
      try {
        const snapshot = await getLatestExecutionSnapshot(
          this.$.prisma,
          params.runId,
          this.$.runStore,
          undefined,
          publishedRun.organizationId ?? undefined
        );
        // Cancellation persists the final row before asking an executing worker to wind down.
        // Its existing finalization guard owns completion until that worker actually finishes.
        if (
          isExecuting(snapshot.executionStatus) ||
          isPendingExecuting(snapshot.executionStatus) ||
          snapshot.executionStatus === "PENDING_CANCEL"
        ) {
          return;
        }
      } catch (error) {
        if (!isExpiredSnapshotOfFinishedRun(error, publishedRun.status)) throw error;
      }
    }

    await this.completeWaitpoint({
      id: params.data.id,
      output: this.buildWaitpointOutputFromRun(publishedRun, params.data.id),
      organizationId: publishedRun.organizationId ?? undefined,
    });
  }

  /**
   * The single association-resolution helper every terminal-completion caller uses (success, failure,
   * cancellation, expiry, finalization). A Postgres association wins unchanged; otherwise, gated by the
   * organization flag and owning run's durable storage marker, discover the deterministically-derived store id by a bounded
   * presence probe. Undefined means the run has no associated RUN waitpoint. Never mints a Postgres
   * replacement; disabling enrollment stops store discovery. Capability and child snapshot residency do not re-route IDs, and a
   * MemoryDB availability failure throws rather than reading as absent.
   */
  public async resolveAssociatedRunWaitpointId(params: {
    runId: string;
    legacyAssociatedWaitpointId?: string;
    organizationId?: string;
  }): Promise<string | undefined> {
    if (params.legacyAssociatedWaitpointId) {
      return params.legacyAssociatedWaitpointId;
    }
    return this.coordinator.findAssociatedRunWaitpointId(params.runId, {
      organizationId: params.organizationId,
    });
  }

  /**
   * Create the IDs for a MemoryDB wait registration.
   * The block ID belongs to the run and wait cycle. Concurrent waits share it.
   * The absorption ID also includes the waitpoint. Batch registration adds the batch and position.
   * Retries in the same cycle reuse these IDs. A new cycle gets a new block ID.
   * Capture the cycle anchor from the current snapshot.
   * For Postgres waits, return undefined without reading a snapshot.
   */
  public async buildStoreBlockOperation(params: {
    runId: string;
    waitpointId: string;
    organizationId?: string;
  }): Promise<{ id: string; absorptionId: string; cycleAnchor: string } | undefined> {
    if (!(await this.isStoreRoutingEnabled(params.organizationId))) return undefined;
    if (classifyWaitpointCoordinator(params.waitpointId) !== "store") return undefined;
    const snapshot = await getLatestExecutionSnapshot(this.$.prisma, params.runId, this.$.runStore);
    const cycleAnchor = cycleAnchorSnapshotId(snapshot);
    const id = `block:${params.runId}:${cycleAnchor}`;
    return { id, absorptionId: `${id}:${params.waitpointId}`, cycleAnchor };
  }

  /** Store RUN errors must survive JSONB object-key reordering during finalization replay. */
  public serializeRunError(waitpointId: string, error: unknown): string {
    const parsed = parseWaitpointId(waitpointId);
    if (parsed.format === "legacy" || parsed.type !== "RUN") {
      return JSON.stringify(error);
    }
    // Only error objects are normalized. Success payloads and legacy completion bytes retain their
    // existing encoding, and the coordinator still rejects genuinely different completions.
    return JSON.stringify(error, (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]])
          )
        : value
    );
  }

  /** Undefined for a success with no output, or for a run that is not final. */
  public buildWaitpointOutputFromRun(
    run: Pick<TaskRun, "status" | "output" | "outputType" | "error">,
    storeWaitpointId?: string
  ): { value: string; type?: string; isError: boolean } | undefined {
    if (run.status === "COMPLETED_SUCCESSFULLY") {
      if (run.output == null) {
        return undefined;
      }
      return {
        value: run.output,
        type: run.outputType ?? undefined,
        isError: false,
      };
    }
    if (isFinalRunStatus(run.status)) {
      return {
        value: storeWaitpointId
          ? this.serializeRunError(storeWaitpointId, run.error ?? {})
          : JSON.stringify(run.error ?? {}),
        isError: true,
      };
    }
    return undefined;
  }

  /**
   * Returns the run's waitpoint, creating it for a late triggerAndWait caller on a run created
   * without one. If the run already finished, the new waitpoint is completed with its output.
   */
  public async getOrCreateRunWaitpoint({
    runId,
    projectId,
    environmentId,
    blockingParentRunId,
    organizationId,
    blockingViaBatch,
    blockingBatchId,
  }: {
    runId: string;
    projectId: string;
    environmentId: string;
    /**
     * The late-waiting parent that owns a NEW mint's block operation. Snapshot residency does not
     * select waitpoint storage. Absent ⇒ a new mint stays legacy. Never consulted when an
     * existing association is reused.
     */
    blockingParentRunId?: string;
    organizationId?: string;
    /**
     * The waiting batch header fixes new child residency. Existing associations stay unchanged.
     */
    blockingViaBatch?: boolean;
    blockingBatchId?: string;
  }): Promise<Waitpoint> {
    // Fast path: reuse an existing Postgres association (unchanged legacy behaviour).
    const run = await this.$.runStore.findRun(
      { id: runId },
      { include: { associatedWaitpoint: true } },
      this.$.prisma
    );

    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.associatedWaitpoint) {
      return run.associatedWaitpoint;
    }

    // Enabled organizations reuse the existing store association before choosing a new mint.
    // Rollback may abandon store-era runs, but must never create a replacement PG association.
    if (
      hasStoreWaitpoints(run.annotations) &&
      !(await this.isWaitpointStoreEnabled(organizationId ?? run.organizationId ?? undefined))
    ) {
      throw new Error("Existing store waitpoint association is disabled for this organization");
    }
    const existingStore = hasStoreWaitpoints(run.annotations)
      ? await this.coordinator.readAssociatedRunWaitpoint(runId, {
          organizationId: organizationId ?? run.organizationId ?? undefined,
        })
      : undefined;
    if (existingStore) {
      return existingStore;
    }

    // Need to create - use run lock to prevent races (operational decisions use latest snapshot inside lock)
    return this.$.runLock.lock("getOrCreateRunWaitpoint", [runId], async () => {
      const prisma = this.$.prisma;

      // Double-check both stores after acquiring the lock.
      const runAfterLock = await this.$.runStore.findRun(
        { id: runId },
        { include: { associatedWaitpoint: true } },
        prisma
      );

      if (!runAfterLock) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (runAfterLock.associatedWaitpoint) {
        return runAfterLock.associatedWaitpoint;
      }
      // Rollback may abandon store-era runs, but must never create a replacement PG association.
      if (
        hasStoreWaitpoints(runAfterLock.annotations) &&
        !(await this.isWaitpointStoreEnabled(
          organizationId ?? runAfterLock.organizationId ?? undefined
        ))
      ) {
        throw new Error("Existing store waitpoint association is disabled for this organization");
      }
      const storeAfterLock = hasStoreWaitpoints(runAfterLock.annotations)
        ? await this.coordinator.readAssociatedRunWaitpoint(runId, {
            organizationId: organizationId ?? runAfterLock.organizationId ?? undefined,
          })
        : undefined;
      if (storeAfterLock) {
        return storeAfterLock;
      }

      // Mint by the organization's waitpoint rollout; a lazy create with no known parent stays
      // legacy. The id is deterministic (store) or a fresh Postgres row (legacy); create-if-absent makes the
      // store write idempotent, so a completion racing this create converges either way.
      // Shared children reuse their durable association. Native batch headers permit native new mints;
      // older Postgres batch headers retain their existing child registration protocol.
      const org = organizationId ?? runAfterLock.organizationId ?? undefined;
      let plan: AssociatedWaitpointPlan | undefined;
      if (this.#storeWired) {
        // A legacy eager association commits inline with the child. Missing it on a single
        // triggerAndWait means its eager store mint may still be pending (or recovering).
        // Reconstruct that plan from the committed birth parent, never a later PG/batch waiter.
        const eagerParentRunId =
          runAfterLock.resumeParentOnCompletion && !runAfterLock.batchId
            ? runAfterLock.parentTaskRunId
            : undefined;
        const mintParentRunId = eagerParentRunId ?? blockingParentRunId;
        const mintLegacy =
          !eagerParentRunId &&
          blockingViaBatch &&
          !(
            blockingBatchId &&
            org &&
            (await this.isStoreRoutingEnabled(org)) &&
            (await this.nativeBatchWaitpointId(blockingBatchId))
          );
        if (this.#storeWired && mintParentRunId && org && !mintLegacy) {
          plan = (
            await this.planRunAssociatedWaitpoint({
              projectId,
              environmentId,
              anchorRunId: runId,
              parentRunId: mintParentRunId,
              organizationId: org,
            })
          ).plan;
        }
      }

      // Failed-at-creation store children have no snapshot; otherwise use the snapshot, with the
      // final run row as proof only when the owning Redis snapshot state has explicitly expired.
      let finished = plan?.residency === "store" && runAfterLock.status === "SYSTEM_FAILURE";
      if (!finished) {
        try {
          const snapshot = await getLatestExecutionSnapshot(
            prisma,
            runId,
            this.$.runStore,
            undefined,
            runAfterLock.organizationId ?? undefined
          );
          finished = snapshot.executionStatus === "FINISHED";
        } catch (error) {
          if (!isExpiredSnapshotOfFinishedRun(error, runAfterLock.status)) {
            throw error;
          }
          this.$.logger.warn(
            "getOrCreateRunWaitpoint: snapshot state expired, using final run row",
            {
              runId,
            }
          );
          finished = true;
        }
      }

      if (plan?.residency === "store" && blockingParentRunId && org) {
        const operation = await this.buildStoreBlockOperation({
          runId: blockingParentRunId,
          waitpointId: plan.data.id,
          organizationId: org,
        });
        if (!operation) throw new Error("Store RUN recovery requires a parent block operation");
        await this.armRunWaitpointRecovery({
          runId,
          parentRunId: blockingParentRunId,
          organizationId: org,
          waitpointId: plan.data.id,
          blockOperation: operation,
        });
      }

      const waitpoint =
        plan?.residency === "store"
          ? await this.coordinator.createAssociatedWaitpoint({
              runId,
              data: plan.data,
              organizationId: org,
              requireStore: true,
            })
          : await this.legacyCoordinator.createAssociatedWaitpoint({
              runId,
              data:
                plan?.data ??
                this.buildRunAssociatedWaitpoint({
                  projectId,
                  environmentId,
                  anchorRunId: runId,
                }),
              organizationId: org,
            });

      // Complete a terminal child immediately so late registration cannot strand its parent.
      if (finished) {
        const output = this.buildWaitpointOutputFromRun(
          runAfterLock,
          plan?.residency === "store" ? waitpoint.id : undefined
        );
        const completed = await this.completeWaitpoint({
          id: waitpoint.id,
          output,
          organizationId: org,
        });
        return completed;
      }

      return waitpoint;
    });
  }
}
