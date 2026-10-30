import { createHash } from "node:crypto";
import { timeoutError } from "@trigger.dev/core/v3";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { boundedIn } from "@trigger.dev/database";
import type {
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  Waitpoint,
} from "@trigger.dev/database";
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
import { isFinalRunStatus } from "../statuses.js";
import { LegacyPostgresWaitpointCoordinator } from "../waitpointCoordinator/legacyPostgresCoordinator.js";
import type { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
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
  snapshotRouteFromSnapshot,
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
  waitpointStore?: Pick<WaitpointStoreCoordinator, "readCompletedRecords">;
};

type RecoverWaitpointBlock = z.infer<typeof workerCatalog.recoverWaitpointBlock.schema>;

const DEFAULT_COMPLETION_GUARD_DELAY_MS = 30_000;

// Delay before the worker retries failed registration cleanup under the run lock.
const BLOCKER_CLEANUP_OBLIGATION_DELAY_MS = 30_000;

// Keep the caller's block identity on retries. Do not replace it with the current block ID.
// When resuming, read the installed block ID with currentStoreBlockId.

// Use this exact description to identify a snapshot blocked by a waitpoint.
const WAITPOINT_BLOCKED_SNAPSHOT_DESCRIPTION = "Run was blocked by a waitpoint.";

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
  private readonly legacyCoordinator: WaitpointCoordinator;
  private readonly completionGuardDelayMs: number;
  readonly #waitpointStore?: Pick<WaitpointStoreCoordinator, "readCompletedRecords">;

  constructor(private readonly options: WaitpointSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.enqueueSystem = options.enqueueSystem;
    this.#waitpointStore = options.waitpointStore;
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
            this.$.runLock.lock("registerLegacyWaitpoint", [runId], operation),
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

  public isStoreRoutingEnabled(organizationId?: string): boolean | Promise<boolean> {
    return (
      this.coordinator instanceof RoutingWaitpointCoordinator &&
      this.coordinator.isStoreRoutingEnabled(organizationId)
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
  async completeWaitpoint({
    id,
    output,
    armGuard = false,
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
    /**
     * Use the caller's organisation for each resume job. Blocking runs belong to the
     * same organisation, so no extra lookup is needed for each edge.
     * Without an organisation, use Postgres routing and reject MemoryDB IDs.
     */
    organizationId?: string;
  }): Promise<Waitpoint> {
    // Keep this pre-check outside guard scheduling and its error handling. The router owns its
    // mutation gate, so an armed call checks again after the durable guard has been persisted.
    const storeRoutingEnabled =
      this.coordinator instanceof RoutingWaitpointCoordinator &&
      (await this.coordinator.isStoreRoutingEnabled(organizationId));

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
      const params: CompleteParams = { waitpointId: id, output };
      if (storeRoutingEnabled) params.organizationId = organizationId;
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
    completedAfter,
    idempotencyKey,
    idempotencyKeyExpiresAt,
  }: {
    runId?: string;
    projectId: string;
    environmentId: string;
    completedAfter: Date;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
  }) {
    const result = await this.coordinator.createDateTimeWaitpoint({
      runId,
      projectId,
      environmentId,
      completedAfter,
      idempotencyKey,
      idempotencyKeyExpiresAt,
    });

    if (result.kind === "cached") {
      return { waitpoint: result.waitpoint, isCached: true };
    }

    await this.$.worker.enqueue({
      id: `finishWaitpoint.${result.waitpoint.id}`,
      job: "finishWaitpoint",
      payload: { waitpointId: result.waitpoint.id },
      availableAt: completedAfter,
    });

    return { waitpoint: result.waitpoint, isCached: false };
  }

  /** Creates a MANUAL waitpoint. With an `idempotencyKey`, an existing waitpoint is returned. */
  async createManualWaitpoint({
    runId,
    environmentId,
    projectId,
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
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    timeout?: Date;
    tags?: string[];
    // Standalone token only (no `runId`): the env's mint residency, so the token does not default
    // to LEGACY by its cuid id shape. Ignored when `runId` is set.
    standaloneResidency?: "NEW" | "LEGACY";
    standaloneShardKey?: ShardKey;
  }): Promise<{ waitpoint: Waitpoint; isCached: boolean }> {
    const result = await this.coordinator.createManualWaitpoint({
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

    if (result.kind === "cached") {
      return { waitpoint: result.waitpoint, isCached: true };
    }

    if (timeout) {
      await this.$.worker.enqueue({
        id: `finishWaitpoint.${result.waitpoint.id}`,
        job: "finishWaitpoint",
        payload: {
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
      // Reject operations from an earlier cycle before changing either store.
      // The run lock protects this check. Check the anchor even if the old block is gone.
      if (
        storeRoutingEnabled &&
        $waitpoints.some((id) => classifyWaitpointCoordinator(id) === "store")
      ) {
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
      // MemoryDB waits require the caller's block identity.
      // Pass the returned registration to phase 3 without changes.
      let registration: BlockerRegistration | undefined;
      let pendingCount: number;
      if (storeRoutingEnabled) {
        const absorbed = await this.#absorbBlockersWithCompensationGuard({
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
        });
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
    return this.coordinator instanceof RoutingWaitpointCoordinator
      ? this.coordinator.withLegacyRegistrationLock(runId, { organizationId }, operation)
      : operation();
  }

  /**
   * blockRunWithWaitpoint without the run lock, for batch items. blockRunWithCreatedBatch has
   * already moved the parent to EXECUTING_WITH_WAITPOINTS, and a per-item lock causes
   * LockAcquisitionTimeoutError on large batches. Writes only the idempotent edges and timeouts.
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
  }: {
    runId: string;
    waitpointId: string;
    output: { value: string; type?: string; isError: boolean };
    projectId: string;
    organizationId: string;
    batch?: { id: string; index?: number };
  }): Promise<void> {
    await this.blockRunWithWaitpoint({
      runId,
      waitpoints: waitpointId,
      projectId,
      organizationId,
      batch,
    });

    await this.completeWaitpoint({
      id: waitpointId,
      output,
      organizationId,
    });
  }

  public async continueRunIfUnblocked({
    runId,
    organizationId,
  }: {
    runId: string;
    // The blocked run's org, carried independently of the route: the common delayed-completion enqueue
    // has no route but does know the org, so this keeps run-keyed routing from querying MemoryDB for
    // every legacy run. Undefined (old payload / no org) keeps the legacy route.
    organizationId?: string;
  }): Promise<WaitpointContinuationResult> {
    this.$.logger.debug(`continueRunIfUnblocked: start`, {
      runId,
    });

    await this.$.raceSimulationSystem.waitForRacepoint({ runId });

    // Use the explicitly carried org for the flag check. Without it, keep the legacy route
    // without discovering an organisation or consulting MemoryDB.
    const routingOrganizationId = organizationId;

    return await this.$.runLock.lock("continueRunIfUnblocked", [runId], async () => {
      // 1. Get the any blocking waitpoints, routed by the run's org.
      const storeRoutingEnabled =
        this.coordinator instanceof RoutingWaitpointCoordinator &&
        (await this.coordinator.isStoreRoutingEnabled(routingOrganizationId));
      const blockingWaitpoints = storeRoutingEnabled
        ? await this.coordinator.readRunBlockState(runId, {
            organizationId: routingOrganizationId,
          })
        : await this.legacyCoordinator.readRunBlockState(runId);

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
        return {
          status: "skipped",
          reason: "run is finished",
        };
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
        case "QUEUED": {
          this.$.logger.info(`continueRunIfUnblocked: run is queued, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already queued",
          };
        }
        case "PENDING_EXECUTING": {
          this.$.logger.info(`continueRunIfUnblocked: run is pending executing, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already pending executing",
          };
        }
        case "QUEUED_EXECUTING": {
          this.$.logger.info(`continueRunIfUnblocked: run is already queued executing, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already queued executing",
          };
        }
        case "EXECUTING": {
          this.$.logger.info(`continueRunIfUnblocked: run is already executing, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });

          return {
            status: "skipped",
            reason: "run is already executing",
          };
        }
        case "PENDING_CANCEL":
        case "FINISHED": {
          this.$.logger.debug(`continueRunIfUnblocked: run is finished, skipping`, {
            runId,
            snapshotId: snapshot.id,
            executionStatus: snapshot.executionStatus,
          });
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
        await this.coordinator.clearRunBlockState({
          runId,
          organizationId: routingOrganizationId,
          edgeIds: blockingWaitpoints.map((b) => b.id),
        });

        this.$.logger.debug(`continueRunIfUnblocked: removed blocking waitpoints`, {
          runId,
          blockingWaitpointCount: blockingWaitpoints.length,
        });
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
    return this.coordinator.mintAssociatedWaitpointData({
      projectId,
      environmentId,
      anchorRunId,
    });
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

  /** Undefined for a success with no output, or for a run that is not final. */
  public buildWaitpointOutputFromRun(
    run: Pick<TaskRun, "status" | "output" | "outputType" | "error">
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
        value: JSON.stringify(run.error ?? {}),
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
  }: {
    runId: string;
    projectId: string;
    environmentId: string;
  }): Promise<Waitpoint> {
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

    // Create under the run lock to prevent a race.
    return this.$.runLock.lock("getOrCreateRunWaitpoint", [runId], async () => {
      const prisma = this.$.prisma;

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

      // Decide from the latest snapshot, not the TaskRun status.
      let runFinished: boolean;
      try {
        const snapshot = await getLatestExecutionSnapshot(
          prisma,
          runId,
          this.$.runStore,
          undefined,
          runAfterLock.organizationId ?? undefined
        );
        runFinished = snapshot.executionStatus === "FINISHED";
      } catch (error) {
        if (!isExpiredSnapshotOfFinishedRun(error, runAfterLock.status)) {
          throw error;
        }
        this.$.logger.warn("getOrCreateRunWaitpoint: snapshot state expired, using final run row", {
          runId,
        });
        runFinished = true;
      }

      // Creates and links the waitpoint atomically.
      const waitpointData = this.buildRunAssociatedWaitpoint({
        projectId,
        environmentId,
        anchorRunId: runId,
      });

      const waitpoint = await this.coordinator.createAssociatedWaitpoint({
        runId,
        data: waitpointData,
      });

      if (runFinished) {
        const output = this.buildWaitpointOutputFromRun(runAfterLock);
        const completed = await this.completeWaitpoint({
          id: waitpoint.id,
          output,
          organizationId: runAfterLock.organizationId ?? undefined,
        });
        return completed;
      }

      return waitpoint;
    });
  }

  public async clearBlockingWaitpoints({
    runId,
    organizationId,
    tx,
  }: {
    runId: string;
    // Use the run's organisation for routing. If absent, use Postgres without an org lookup.
    organizationId?: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const deleted = await this.coordinator.clearRunBlockState({ runId, organizationId, tx });

    return deleted.count;
  }
}
