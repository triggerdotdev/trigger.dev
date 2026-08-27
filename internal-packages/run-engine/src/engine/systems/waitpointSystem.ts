import { timeoutError } from "@trigger.dev/core/v3";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { CompletedWaitpointRecord } from "@internal/run-store";
import type {
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  Waitpoint,
} from "@trigger.dev/database";
import { assertNever } from "assert-never";
import { sendNotificationToWorker } from "../eventBus.js";
import { isFinalRunStatus } from "../statuses.js";
import { buildCompletedWaitpointRecords } from "../waitpointCoordinator/completedWaitpointRecords.js";
import type {
  AssociatedWaitpointData,
  RunBlockEdge,
  WaitpointCoordinator,
  WaitpointMintKind,
} from "../waitpointCoordinator/types.js";
import type { EnqueueSystem } from "./enqueueSystem.js";
import type { ExecutionSnapshotSystem } from "./executionSnapshotSystem.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import type { SystemResources } from "./systems.js";

export type WaitpointSystemOptions = {
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  enqueueSystem: EnqueueSystem;
  /** Which coordinator owns waitpoint state. The engine supplies a router over both arms. */
  coordinator: WaitpointCoordinator;
};

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

  constructor(private readonly options: WaitpointSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.enqueueSystem = options.enqueueSystem;
    this.coordinator = options.coordinator;
  }

  public async clearBlockingWaitpoints({
    runId,
    tx,
  }: {
    runId: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const deleted = await this.coordinator.clearRunBlockState({ runId, tx });

    return deleted.count;
  }

  /** This completes a waitpoint and updates all entries so the run isn't blocked,
   * if they're no longer blocked. This doesn't suffer from race conditions. */
  async completeWaitpoint({
    id,
    output,
  }: {
    id: string;
    output?: {
      value: string;
      type?: string;
      isError: boolean;
    };
  }): Promise<Waitpoint> {
    const { waitpoint, blockedRuns } = await this.coordinator.complete({
      waitpointId: id,
      output,
    });

    if (blockedRuns.length === 0) {
      this.$.logger.debug(`completeWaitpoint: no TaskRunWaitpoints found for waitpoint`, {
        waitpointId: id,
      });
    }

    // 3. Schedule trying to continue the runs
    for (const run of blockedRuns) {
      const jobId = `continueRunIfUnblocked:${run.taskRunId}`;
      //50ms in the future
      const availableAt = new Date(Date.now() + 50);

      this.$.logger.debug(`completeWaitpoint: enqueueing continueRunIfUnblocked`, {
        waitpointId: id,
        runId: run.taskRunId,
        jobId,
        availableAt,
      });

      await this.$.worker.enqueue({
        //this will debounce the call
        id: jobId,
        job: "continueRunIfUnblocked",
        payload: { runId: run.taskRunId },
        availableAt,
      });

      // emit an event to complete associated cached runs
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

    return waitpoint;
  }

  /**
   * This creates a DATETIME waitpoint, that will be completed automatically when the specified date is reached.
   * If you pass an `idempotencyKey`, the waitpoint will be created only if it doesn't already exist.
   */
  async createDateTimeWaitpoint({
    runId,
    projectId,
    environmentId,
    completedAfter,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    waitpointMintKind,
  }: {
    runId?: string;
    projectId: string;
    environmentId: string;
    completedAfter: Date;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    waitpointMintKind?: WaitpointMintKind;
  }) {
    const result = await this.coordinator.createDateTimeWaitpoint({
      mintKind: waitpointMintKind ?? "legacy",
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

  /** This creates a MANUAL waitpoint, that can be explicitly completed (or failed).
   * If you pass an `idempotencyKey` and it already exists, it will return the existing waitpoint.
   */
  async createManualWaitpoint({
    runId,
    environmentId,
    projectId,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    timeout,
    tags,
    standaloneResidency,
    waitpointMintKind,
  }: {
    runId?: string;
    environmentId: string;
    projectId: string;
    waitpointMintKind?: WaitpointMintKind;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    timeout?: Date;
    tags?: string[];
    // For a STANDALONE token (no owning `runId`): the residency the env's mint kind resolves to, so
    // the token lands on the run-ops DB (NEW) in a fully-minted-new deployment instead of defaulting
    // to LEGACY by its cuid id-shape. Ignored when `runId` is set (co-location wins).
    standaloneResidency?: "NEW" | "LEGACY";
  }): Promise<{ waitpoint: Waitpoint; isCached: boolean }> {
    const result = await this.coordinator.createManualWaitpoint({
      mintKind: waitpointMintKind ?? "legacy",
      runId,
      environmentId,
      projectId,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      timeout,
      tags,
      standaloneResidency,
    });

    if (result.kind === "cached") {
      return { waitpoint: result.waitpoint, isCached: true };
    }

    //schedule the timeout
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
   * Prevents a run from continuing until the waitpoint is completed.
   *
   * The block edge is written via the run-ops store, routed by the owning run id so it co-resides
   * with the run (`blockRunWithWaitpointEdges`). It is NOT pinned to the caller's control-plane tx:
   * doing so joined `Waitpoint` on the wrong DB for a run whose waitpoint lives on the run-ops DB,
   * wrote 0 edges, and silently never suspended the parent. Like `blockRunWithCreatedBatch`, this is
   * a routed, run-co-resident write rather than part of the control-plane trigger tx — there is no
   * cross-DB transaction. The edge write is idempotent (ON CONFLICT DO NOTHING) and the snapshot
   * transition is re-derivable, so a crash between the two leaves no corruption: a retry re-writes
   * the same edge and re-checks the pending count.
   *
   * The pending check is a SEPARATE store call (not folded into the edge write) on purpose: under
   * PostgreSQL READ COMMITTED each statement gets its own snapshot, so if a concurrent
   * `completeWaitpoint` commits between the edge write and the check, this fresh query still sees the
   * COMPLETED status. It queries ALL requested waitpoint IDs (not just the ones inserted): a row
   * that already existed (ON CONFLICT skipped the insert) but is still PENDING must still block.
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
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRunExecutionSnapshot> {
    const prisma = tx ?? this.$.prisma;

    await this.$.raceSimulationSystem.waitForRacepoint({ runId });

    let $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    return await this.$.runLock.lock("blockRunWithWaitpoint", [runId], async () => {
      let snapshot: TaskRunExecutionSnapshot = await getLatestExecutionSnapshot(
        prisma,
        runId,
        this.$.runStore
      );

      // Insert the blocking + historical connections and re-check the pending count. The
      // coordinator keeps these as two separate store statements, in this order, for the READ
      // COMMITTED reason documented on the method and in the doc comment above.
      const { pendingCount } = await this.coordinator.registerBlocks({
        runId,
        waitpointIds: $waitpoints,
        projectId,
        spanIdToComplete,
        batchId: batch?.id,
        batchIndex: batch?.index,
        client: prisma,
      });

      const isRunBlocked = pendingCount > 0;

      let newStatus: TaskRunExecutionStatus = "SUSPENDED";
      if (
        snapshot.executionStatus === "EXECUTING" ||
        snapshot.executionStatus === "EXECUTING_WITH_WAITPOINTS"
      ) {
        newStatus = "EXECUTING_WITH_WAITPOINTS";
      }

      //if the state has changed, create a new snapshot
      if (newStatus !== snapshot.executionStatus) {
        snapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run: {
            id: snapshot.runId,
            status: snapshot.runStatus,
            attemptNumber: snapshot.attemptNumber,
          },
          snapshot: {
            executionStatus: newStatus,
            description: "Run was blocked by a waitpoint.",
          },
          previousSnapshotId: snapshot.id,
          environmentId: snapshot.environmentId,
          environmentType: snapshot.environmentType,
          projectId: snapshot.projectId,
          organizationId,
          // Do NOT carry over the batchId from the previous snapshot
          batchId: batch?.id,
          workerId,
          runnerId,
        });

        // Let the worker know immediately, so it can suspend the run
        await sendNotificationToWorker({ runId, snapshot, eventBus: this.$.eventBus });
      }

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

      //no pending waitpoint, schedule unblocking the run
      //debounce if we're rapidly adding waitpoints
      if (!isRunBlocked) {
        await this.$.worker.enqueue({
          //this will debounce the call
          id: `continueRunIfUnblocked:${runId}`,
          job: "continueRunIfUnblocked",
          payload: { runId: runId },
          //in the near future
          availableAt: new Date(Date.now() + 50),
        });
      }

      return snapshot;
    });
  }

  /**
   * Lockless version of blockRunWithWaitpoint for batch item processing.
   *
   * When processing batchTriggerAndWait items, blockRunWithCreatedBatch has already
   * transitioned the parent run to EXECUTING_WITH_WAITPOINTS before any items are
   * processed. Per-item calls to blockRunWithWaitpoint would all compete for the same
   * parent run lock just to insert a TaskRunWaitpoint row — causing lock contention
   * and LockAcquisitionTimeoutError with large batches.
   *
   * This method performs only the CTE insert (which is idempotent via ON CONFLICT DO
   * NOTHING) and timeout scheduling, without acquiring the parent run lock.
   */
  async blockRunWithWaitpointLockless({
    runId,
    waitpoints,
    projectId,
    timeout,
    spanIdToComplete,
    batch,
    batchWaitpointId,
  }: {
    runId: string;
    waitpoints: string | string[];
    projectId: string;
    timeout?: Date;
    spanIdToComplete?: string;
    batch: { id: string; index?: number };
    /** The parent's BATCH waitpoint, so the store arm can assert it is still pending. */
    batchWaitpointId?: string;
  }): Promise<void> {
    const $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    // Same routed edge write as blockRunWithWaitpoint. No lock needed: ON CONFLICT DO NOTHING
    // makes concurrent inserts safe, and the parent snapshot is already
    // EXECUTING_WITH_WAITPOINTS from blockRunWithCreatedBatch. No pending count here.
    await this.coordinator.registerBlocksLockless({
      runId,
      waitpointIds: $waitpoints,
      projectId,
      spanIdToComplete,
      batchId: batch.id,
      batchIndex: batch.index,
      batchWaitpointId,
    });

    // Schedule timeout jobs if needed
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
   * Blocks a run with a waitpoint and immediately completes the waitpoint.
   *
   * Used when creating a pre-failed child run: the parent needs to be blocked
   * by the waitpoint so it can receive the error output, but the waitpoint is
   * already resolved because the child run is terminal from the start.
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
    });
  }

  public async continueRunIfUnblocked({
    runId,
  }: {
    runId: string;
  }): Promise<WaitpointContinuationResult> {
    this.$.logger.debug(`continueRunIfUnblocked: start`, {
      runId,
    });

    await this.$.raceSimulationSystem.waitForRacepoint({ runId });

    return await this.$.runLock.lock("continueRunIfUnblocked", [runId], async () => {
      // 1. Get the any blocking waitpoints
      const blockingWaitpoints = await this.coordinator.readRunBlockState(runId);

      // 2. There are blockers still, so do nothing
      if (blockingWaitpoints.some((w) => w.waitpoint.status !== "COMPLETED")) {
        this.$.logger.debug(`continueRunIfUnblocked: blocking waitpoints still exist`, {
          runId,
          blockingWaitpoints,
        });

        return {
          status: "blocked",
          waitpoints: blockingWaitpoints.map((w) => w.waitpoint),
        };
      }

      // 3. Get the run (run-ops scalars) + resolve its environment via the control-plane resolver,
      // so the run-ops DB can split without a cross-provider join.
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

      //4. Continue the run whether it's executing or not
      const snapshot = await getLatestExecutionSnapshot(this.$.prisma, runId, this.$.runStore);

      switch (snapshot.executionStatus) {
        case "RUN_CREATED": {
          this.$.logger.info(`continueRunIfUnblocked: run is run created, skipping`, {
            runId,
            snapshot,
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
            snapshot,
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
            snapshot,
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
            snapshot,
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
            snapshot,
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
            snapshot,
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
            snapshot,
            executionStatus: snapshot.executionStatus,
          });
          return {
            status: "skipped",
            reason: "run is finished",
          };
        }
        case "EXECUTING_WITH_WAITPOINTS": {
          // Built inside the branch, not before the switch: the statuses above return without
          // appending, and they must not pay an envelope read to do it.
          const completedWaitpointRecords = await this.#completedWaitpointRecordsFor(
            runId,
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
              environmentId: snapshot.environmentId,
              environmentType: snapshot.environmentType,
              projectId: snapshot.projectId,
              organizationId: snapshot.organizationId,
              batchId: snapshot.batchId ?? undefined,
              completedWaitpoints: blockingWaitpoints.map((b) => ({
                id: b.waitpoint.id,
                index: b.batchIndex ?? undefined,
              })),
              ...(completedWaitpointRecords && { completedWaitpointRecords }),
            }
          );

          this.$.logger.debug(
            `continueRunIfUnblocked: run was still executing, sending notification`,
            {
              runId,
              snapshot,
              newSnapshot,
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
          if (!snapshot.checkpointId) {
            // A run canceled mid-suspend has its checkpoint cleared by the
            // cancel path; reaching here just means cancel won the race.
            // Skip rather than throw — there's nothing to resume.
            if (snapshot.runStatus === "CANCELED") {
              this.$.logger.warn(
                `continueRunIfUnblocked: run was canceled while suspended, skipping`,
                { runId, snapshot }
              );
              return {
                status: "skipped",
                reason: "run was canceled while suspended",
              };
            }

            this.$.logger.error(`continueRunIfUnblocked: run is suspended, but has no checkpoint`, {
              runId,
              snapshot,
            });
            throw new Error(
              `continueRunIfUnblocked: run is suspended, but has no checkpoint: ${runId}`
            );
          }

          const completedWaitpointRecords = await this.#completedWaitpointRecordsFor(
            runId,
            blockingWaitpoints
          );

          //put it back in the queue, with the original timestamp (w/ priority)
          //this prioritizes dequeuing waiting runs over new runs
          const newSnapshot = await this.enqueueSystem.enqueueRun({
            run,
            env,
            snapshot: {
              status: "QUEUED",
              description: "Run was QUEUED, because all waitpoints are completed",
            },
            batchId: snapshot.batchId ?? undefined,
            completedWaitpoints: blockingWaitpoints.map((b) => ({
              id: b.waitpoint.id,
              index: b.batchIndex ?? undefined,
            })),
            ...(completedWaitpointRecords && { completedWaitpointRecords }),
            checkpointId: snapshot.checkpointId ?? undefined,
          });

          this.$.logger.debug(`continueRunIfUnblocked: run goes to QUEUED`, {
            runId,
            snapshot,
            newSnapshot,
          });

          break;
        }
        default: {
          assertNever(snapshot.executionStatus);
        }
      }

      if (blockingWaitpoints.length > 0) {
        //5. Remove the blocking waitpoints
        await this.coordinator.clearRunBlockState({
          runId,
          edgeIds: blockingWaitpoints.map((b) => b.id),
        });

        this.$.logger.debug(`continueRunIfUnblocked: removed blocking waitpoints`, {
          runId,
          blockingWaitpoints,
        });
      }

      return {
        status: "unblocked",
        waitpoints: blockingWaitpoints.map((w) => w.waitpoint),
      };
    }); // end of runlock
  }

  /** The BATCH waitpoint for a batch. Returns null when the batch already has one. */
  public async createBatchWaitpoint(params: {
    batchId: string;
    environmentId: string;
    projectId: string;
    mintKind?: WaitpointMintKind;
    tx?: PrismaClientOrTransaction;
  }): Promise<Waitpoint | null> {
    return this.coordinator.createBatchWaitpoint({
      ...params,
      mintKind: params.mintKind ?? "legacy",
    });
  }

  /**
   * Mint the RUN waitpoint's data for a run that a parent will block on.
   *
   * A store mint derives the id from the anchor run's own id body, so the id is a pure
   * function of the run id and create-if-absent needs no lock. Derivation only works when
   * the run itself carries a run-ops id, so a legacy-shaped run keeps a legacy waitpoint
   * even in a flipped organization, which is the coexistence rule the id routing relies on.
   */
  public buildRunAssociatedWaitpoint({
    projectId,
    environmentId,
    anchorRunId,
    mintKind,
  }: {
    projectId: string;
    environmentId: string;
    anchorRunId?: string;
    mintKind?: WaitpointMintKind;
  }) {
    return this.coordinator.mintAssociatedWaitpointData({
      projectId,
      environmentId,
      anchorRunId,
      mintKind,
    });
  }

  /**
   * Create the RUN waitpoint that `buildRunAssociatedWaitpoint` minted.
   *
   * Only the store path calls this: the legacy path writes the row inside the run's own
   * create. A crash between the run commit and this call leaves the waitpoint absent, and
   * the parent's register step then fails loud rather than resuming without it.
   */
  public async createRunAssociatedWaitpoint(params: {
    runId: string;
    data: AssociatedWaitpointData;
  }): Promise<Waitpoint> {
    return this.coordinator.createAssociatedWaitpoint(params);
  }

  /**
   * The record set for one resume, or undefined when no blocking waitpoint carries a store-format
   * id.
   *
   * Gated on id FORMAT, not residency. The two are not the same during a migration: a
   * store-format id can still be served by the Postgres arm, exactly as run-ops ids were for
   * runs. Whichever arm owns it answers, so the gate only decides whether to ask at all.
   *
   * That gate is what keeps this inert. `parseWaitpointId` reports legacy for every id minted
   * today, so no live resume reads an envelope or writes a record until a waitpoint mints in
   * store format.
   */
  async #completedWaitpointRecordsFor(
    runId: string,
    blockingWaitpoints: RunBlockEdge[]
  ): Promise<CompletedWaitpointRecord[] | undefined> {
    const storeFormatIds = [
      ...new Set(
        blockingWaitpoints
          .map((b) => b.waitpoint.id)
          .filter((id) => parseWaitpointId(id).format === "b32hexW")
      ),
    ];

    if (storeFormatIds.length === 0) {
      return undefined;
    }

    const sources = await this.coordinator.readCompletionEnvelopes({
      runId,
      waitpointIds: storeFormatIds,
    });

    return buildCompletedWaitpointRecords(sources);
  }

  /**
   * Builds the waitpoint output payload from a completed run's stored output/error.
   */
  #buildWaitpointOutputFromRun(
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
   * Gets an existing run waitpoint or creates one lazily.
   * Used for debounce/idempotency when a late-arriving triggerAndWait caller
   * needs to block on an existing run that was created without a waitpoint.
   * When the run has already completed, creates the waitpoint and immediately
   * completes it with the run's output/error so the parent can resume.
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
    // Fast path: check if waitpoint already exists
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

    // Need to create - use run lock to prevent races (operational decisions use latest snapshot inside lock)
    return this.$.runLock.lock("getOrCreateRunWaitpoint", [runId], async () => {
      const prisma = this.$.prisma;

      // Double-check after acquiring lock
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

      // Operational decision: use latest execution snapshot, not TaskRun status
      const snapshot = await getLatestExecutionSnapshot(prisma, runId, this.$.runStore);

      // Create waitpoint and link to run atomically
      const waitpointData = this.buildRunAssociatedWaitpoint({ projectId, environmentId });

      const waitpoint = await this.coordinator.createAssociatedWaitpoint({
        runId,
        data: waitpointData,
      });

      // If run has already finished (per snapshot), complete the waitpoint immediately so the parent can resume
      if (snapshot.executionStatus === "FINISHED") {
        const output = this.#buildWaitpointOutputFromRun(runAfterLock);
        const completed = await this.completeWaitpoint({
          id: waitpoint.id,
          output,
        });
        return completed;
      }

      return waitpoint;
    });
  }
}
