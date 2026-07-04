import { timeoutError, tryCatch } from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type {
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  Waitpoint,
} from "@trigger.dev/database";
import { Prisma } from "@trigger.dev/database";
import type { RunStore } from "@internal/run-store";
import { assertNever } from "assert-never";
import { nanoid } from "nanoid";
import { UnclassifiableWaitpointId } from "../errors.js";
import { sendNotificationToWorker } from "../eventBus.js";
import { isFinalRunStatus } from "../statuses.js";
import type { EnqueueSystem } from "./enqueueSystem.js";
import type { ExecutionSnapshotSystem } from "./executionSnapshotSystem.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import type { SystemResources } from "./systems.js";

export type WaitpointSystemOptions = {
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  enqueueSystem: EnqueueSystem;
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

  constructor(private readonly options: WaitpointSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.enqueueSystem = options.enqueueSystem;
  }

  public async clearBlockingWaitpoints({
    runId,
    tx,
  }: {
    runId: string;
    tx?: PrismaClientOrTransaction;
  }) {
    // A tx pins a specific client and must not be re-routed through the store.
    const deleted = tx
      ? await tx.taskRunWaitpoint.deleteMany({
          where: {
            taskRunId: runId,
          },
        })
      : await this.$.runStore.deleteManyTaskRunWaitpoints({
          where: {
            taskRunId: runId,
          },
        });

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
    // Residency store-selection guard. completeWaitpoint arrives with only
    // (waitpointId, output) — no run id — so the owning run-ops store is selected
    // by the waitpoint's own residency. In single-DB this is the one store
    // (no classification). An unclassifiable id throws loud — never default-routes.
    let store: RunStore;
    try {
      store = await this.$.runStore.forWaitpointCompletion(id, { routeKind: "MANUAL" });
    } catch (error) {
      this.$.logger.error("completeWaitpoint: unclassifiable waitpointId", {
        waitpointId: id,
        error,
      });
      throw new UnclassifiableWaitpointId(id, { cause: error });
    }

    // 1. Complete the Waitpoint (if not completed)
    const [updateError, updateResult] = await tryCatch(
      store.updateManyWaitpoints({
        where: { id, status: "PENDING" },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: output?.value,
          outputType: output?.type,
          outputIsError: output?.isError,
        },
      })
    );

    if (updateError) {
      this.$.logger.error("completeWaitpoint: error updating waitpoint:", { updateError });
      throw updateError;
    }

    if (updateResult.count === 0) {
      this.$.logger.info(
        "completeWaitpoint: attempted to complete a waitpoint that is not PENDING",
        { waitpointId: id }
      );
    }

    // Re-read the just-written row from the RESOLVED store's PRIMARY: the replica (findWaitpoint's
    // default) can miss it under lag → false "not found" → the parent hangs; this.$.prisma would
    // instead hit the wrong DB. findWaitpointOnPrimary reads the owning store's primary.
    const waitpoint = await store.findWaitpointOnPrimary({
      where: { id },
    });

    if (!waitpoint) {
      this.$.logger.error("completeWaitpoint: waitpoint not found", { waitpointId: id });
      throw new Error("Waitpoint not found");
    }

    if (waitpoint.status !== "COMPLETED") {
      this.$.logger.error(`completeWaitpoint: waitpoint is not completed`, {
        waitpointId: id,
      });
      throw new Error("Waitpoint not completed");
    }

    // 2. Find the TaskRuns blocked by this waitpoint. The edge (TaskRunWaitpoint) co-locates
    // with its RUN, not this token, so it can live on the OTHER run-ops DB: read via the router
    // (which fans the waitpointId lookup across both DBs) rather than the token's own `store`,
    // or a cross-DB blocked run is never found and hangs forever.
    const affectedTaskRuns = await this.$.runStore.findManyTaskRunWaitpoints(
      {
        where: { waitpointId: id },
        select: { taskRunId: true, spanIdToComplete: true, createdAt: true },
      },
      this.$.prisma
    );

    if (affectedTaskRuns.length === 0) {
      this.$.logger.debug(`completeWaitpoint: no TaskRunWaitpoints found for waitpoint`, {
        waitpointId: id,
      });
    }

    // 3. Schedule trying to continue the runs
    for (const run of affectedTaskRuns) {
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
    tx,
  }: {
    runId?: string;
    projectId: string;
    environmentId: string;
    completedAfter: Date;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    tx?: PrismaClientOrTransaction;
  }) {
    // Co-location invariant: a DATETIME wait waitpoint lives on the same run-ops DB as the run that
    // blocks on it (so the block edge's local `Waitpoint` join resolves and completion/resume stay
    // local). The minted waitpoint id is always a cuid, so without `coLocateWithRunId` the upsert
    // would always route to LEGACY and a run-ops run on NEW would hang. The (env,idempotencyKey) dedup
    // is within the owning run/tree (co-resident on one DB), so the dedup probe + rotation target the
    // SAME store. With no run id (a standalone token has no owning run yet) the lookup falls back to
    // a cross-DB NEW-then-LEGACY scan and the upsert routes by id-shape. A caller-supplied tx pins a
    // client (same physical DB as the control-plane tx → LEGACY), so it stays on direct prisma.
    const colocate = runId ? { coLocateWithRunId: runId } : undefined;
    const existingWaitpoint = idempotencyKey
      ? tx
        ? await tx.waitpoint.findFirst({
            where: {
              environmentId,
              idempotencyKey,
            },
          })
        : await this.$.runStore.findWaitpoint(
            {
              where: {
                environmentId,
                idempotencyKey,
              },
            },
            undefined,
            colocate
          )
      : undefined;

    if (existingWaitpoint) {
      if (
        existingWaitpoint.idempotencyKeyExpiresAt &&
        new Date() > existingWaitpoint.idempotencyKeyExpiresAt
      ) {
        //the idempotency key has expired
        //remove the waitpoint idempotencyKey
        const rotateArgs = {
          where: {
            id: existingWaitpoint.id,
          },
          data: {
            idempotencyKey: nanoid(24),
            inactiveIdempotencyKey: existingWaitpoint.idempotencyKey,
          },
        };
        if (tx) {
          await tx.waitpoint.update(rotateArgs);
        } else {
          await this.$.runStore.updateWaitpoint(rotateArgs, undefined, colocate);
        }

        //let it fall through to create a new waitpoint
      } else {
        return { waitpoint: existingWaitpoint, isCached: true };
      }
    }

    const upsertArgs = {
      where: {
        environmentId_idempotencyKey: {
          environmentId,
          idempotencyKey: idempotencyKey ?? nanoid(24),
        },
      },
      create: {
        ...WaitpointId.generate(),
        type: "DATETIME" as const,
        idempotencyKey: idempotencyKey ?? nanoid(24),
        idempotencyKeyExpiresAt,
        userProvidedIdempotencyKey: !!idempotencyKey,
        environmentId,
        projectId,
        completedAfter,
      },
      update: {},
    };
    const waitpoint = tx
      ? await tx.waitpoint.upsert(upsertArgs)
      : await this.$.runStore.upsertWaitpoint(upsertArgs, undefined, colocate);

    await this.$.worker.enqueue({
      id: `finishWaitpoint.${waitpoint.id}`,
      job: "finishWaitpoint",
      payload: { waitpointId: waitpoint.id },
      availableAt: completedAfter,
    });

    return { waitpoint, isCached: false };
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
  }: {
    runId?: string;
    environmentId: string;
    projectId: string;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    timeout?: Date;
    tags?: string[];
  }): Promise<{ waitpoint: Waitpoint; isCached: boolean }> {
    // Co-location invariant (see createDateTimeWaitpoint): when a `runId` is supplied the waitpoint
    // co-locates with that run's DB and the (env,idempotencyKey) dedup is per-run (co-resident). A
    // standalone token (api.v1.waitpoints.tokens.ts) passes no run id — it is created without an
    // owner, blocked later by whichever run waits on it (possibly cross-DB, resolved by the
    // run-co-resident block edge + completion fan-out), so it routes by id-shape and dedups cross-DB. No tx here.
    const colocate = runId ? { coLocateWithRunId: runId } : undefined;
    const existingWaitpoint = idempotencyKey
      ? await this.$.runStore.findWaitpoint(
          {
            where: {
              environmentId,
              idempotencyKey,
            },
          },
          undefined,
          colocate
        )
      : undefined;

    if (existingWaitpoint) {
      if (
        existingWaitpoint.idempotencyKeyExpiresAt &&
        new Date() > existingWaitpoint.idempotencyKeyExpiresAt
      ) {
        //the idempotency key has expired
        //remove the waitpoint idempotencyKey
        await this.$.runStore.updateWaitpoint(
          {
            where: {
              id: existingWaitpoint.id,
            },
            data: {
              idempotencyKey: nanoid(24),
              inactiveIdempotencyKey: existingWaitpoint.idempotencyKey,
            },
          },
          undefined,
          colocate
        );

        //let it fall through to create a new waitpoint
      } else {
        return { waitpoint: existingWaitpoint, isCached: true };
      }
    }

    const maxRetries = 5;
    let attempts = 0;

    while (attempts < maxRetries) {
      try {
        const waitpoint = await this.$.runStore.upsertWaitpoint(
          {
            where: {
              environmentId_idempotencyKey: {
                environmentId,
                idempotencyKey: idempotencyKey ?? nanoid(24),
              },
            },
            create: {
              ...WaitpointId.generate(),
              type: "MANUAL",
              idempotencyKey: idempotencyKey ?? nanoid(24),
              idempotencyKeyExpiresAt,
              userProvidedIdempotencyKey: !!idempotencyKey,
              environmentId,
              projectId,
              completedAfter: timeout,
              tags,
            },
            update: {},
          },
          undefined,
          colocate
        );

        //schedule the timeout
        if (timeout) {
          await this.$.worker.enqueue({
            id: `finishWaitpoint.${waitpoint.id}`,
            job: "finishWaitpoint",
            payload: {
              waitpointId: waitpoint.id,
              error: JSON.stringify(timeoutError(timeout)),
            },
            availableAt: timeout,
          });
        }

        return { waitpoint, isCached: false };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          // Handle unique constraint violation (conflict)
          attempts++;
          if (attempts >= maxRetries) {
            throw new Error(
              `Failed to create waitpoint after ${maxRetries} attempts due to conflicts.`
            );
          }
        } else {
          throw error; // Re-throw other errors
        }
      }
    }

    throw new Error(`Failed to create waitpoint after ${maxRetries} attempts due to conflicts.`);
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

      // Insert the blocking + historical connections via the run-ops store, routed by the owning
      // run id so the edge co-resides with the run. Never pinned to the caller's control-plane tx:
      // that joined `Waitpoint` on the wrong DB and wrote 0 edges. The pending check stays a
      // SEPARATE store call so it gets its own READ COMMITTED snapshot (see the doc comment above).
      await this.$.runStore.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: $waitpoints,
        projectId,
        spanIdToComplete,
        batchId: batch?.id,
        batchIndex: batch?.index,
      });

      // Check if the run is actually blocked using a separate query (see above).
      const pendingCount = await this.$.runStore.countPendingWaitpoints($waitpoints);

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
  }: {
    runId: string;
    waitpoints: string | string[];
    projectId: string;
    timeout?: Date;
    spanIdToComplete?: string;
    batch: { id: string; index?: number };
  }): Promise<void> {
    const $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    // Same routed edge write as blockRunWithWaitpoint, routed by the owning run id. No lock
    // needed: ON CONFLICT DO NOTHING makes concurrent inserts safe, and the parent snapshot is
    // already EXECUTING_WITH_WAITPOINTS from blockRunWithCreatedBatch.
    await this.$.runStore.blockRunWithWaitpointEdges({
      runId,
      waitpointIds: $waitpoints,
      projectId,
      spanIdToComplete,
      batchId: batch.id,
      batchIndex: batch.index,
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
      const blockingWaitpoints = await this.$.runStore.findManyTaskRunWaitpoints(
        {
          where: { taskRunId: runId },
          select: {
            id: true,
            batchId: true,
            batchIndex: true,
            waitpoint: {
              select: { id: true, status: true, type: true, completedAfter: true },
            },
          },
        },
        this.$.prisma
      );

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
        await this.$.runStore.deleteManyTaskRunWaitpoints({
          where: {
            taskRunId: runId,
            id: { in: blockingWaitpoints.map((b) => b.id) },
          },
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

  public buildRunAssociatedWaitpoint({
    projectId,
    environmentId,
  }: {
    projectId: string;
    environmentId: string;
  }) {
    return {
      ...WaitpointId.generate(),
      type: "RUN" as const,
      status: "PENDING" as const,
      idempotencyKey: nanoid(24),
      userProvidedIdempotencyKey: false,
      projectId,
      environmentId,
    };
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

      // RUN-type within-tree waitpoint that belongs to runId; routes by owning run id.
      const waitpoint = await this.$.runStore.createWaitpoint({
        data: {
          ...waitpointData,
          completedByTaskRunId: runId,
        },
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
