import type {
  CheckpointInput,
  CreateCheckpointResult,
  ExecutionResult,
} from "@trigger.dev/core/v3";
import { CheckpointId } from "@trigger.dev/core/v3/isomorphic";
import { toWireRoute } from "@internal/run-store";
import type { SnapshotRouteWire } from "@internal/run-store";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { sendNotificationToWorker } from "../eventBus.js";
import { isCheckpointable, isPendingExecuting } from "../statuses.js";
import type { ExecutionSnapshotSystem } from "./executionSnapshotSystem.js";
import {
  getLatestExecutionSnapshot,
  executionResultFromSnapshot,
} from "./executionSnapshotSystem.js";
import type { SystemResources } from "./systems.js";
import { ServiceValidationError } from "../errors.js";
import type { EnqueueSystem } from "./enqueueSystem.js";

export type CheckpointSystemOptions = {
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
  enqueueSystem: EnqueueSystem;
};

export class CheckpointSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;
  private readonly enqueueSystem: EnqueueSystem;

  constructor(private readonly options: CheckpointSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
    this.enqueueSystem = options.enqueueSystem;
  }

  /**
   * This gets called AFTER the checkpoint has been created
   * The CPU/Memory checkpoint at this point exists in our snapshot storage
   */
  async createCheckpoint({
    runId,
    snapshotId,
    checkpoint,
    workerId,
    runnerId,
    snapshotRoute,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    checkpoint: CheckpointInput;
    workerId?: string;
    runnerId?: string;
    // Carried from the worker's suspend request so the SUSPENDED transition honors durable residency
    // on a poll-lagging pod. Undefined for a never-enrolled run.
    snapshotRoute?: SnapshotRouteWire;
    tx?: PrismaClientOrTransaction;
  }): Promise<CreateCheckpointResult> {
    const prisma = tx ?? this.$.prisma;

    return await this.$.runLock.lock("createCheckpoint", [runId], async () => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId, this.$.runStore);

      const isValidSnapshot =
        // Case 1: The provided snapshotId matches the current snapshot
        snapshot.id === snapshotId ||
        // Case 2: The provided snapshotId matches the previous snapshot
        // AND we're in QUEUED_EXECUTING state (which is valid)
        (snapshot.previousSnapshotId === snapshotId &&
          snapshot.executionStatus === "QUEUED_EXECUTING");

      if (!isValidSnapshot) {
        this.$.logger.info("Tried to createCheckpoint on an invalid snapshot", {
          runId,
          snapshotId,
          latestSnapshotId: snapshot.id,
          latestSnapshotExecutionStatus: snapshot.executionStatus,
          latestSnapshotPreviousSnapshotId: snapshot.previousSnapshotId,
        });

        this.$.eventBus.emit("incomingCheckpointDiscarded", {
          time: new Date(),
          run: {
            id: runId,
          },
          checkpoint: {
            discardReason: "Not the latest snapshot",
            metadata: checkpoint,
          },
          snapshot: {
            id: snapshot.id,
            executionStatus: snapshot.executionStatus,
          },
        });

        return {
          ok: false as const,
          error: "Not the latest snapshot",
        };
      }

      if (!isCheckpointable(snapshot.executionStatus)) {
        this.$.logger.error("Tried to createCheckpoint on a run in an invalid state", {
          runId,
          snapshotId: snapshot.id,
          executionStatus: snapshot.executionStatus,
        });

        this.$.eventBus.emit("incomingCheckpointDiscarded", {
          time: new Date(),
          run: {
            id: runId,
          },
          checkpoint: {
            discardReason: `Status ${snapshot.executionStatus} is not checkpointable`,
            metadata: checkpoint,
          },
          snapshot: {
            id: snapshot.id,
            executionStatus: snapshot.executionStatus,
          },
        });

        return {
          ok: false as const,
          error: `Status ${snapshot.executionStatus} is not checkpointable`,
        };
      }

      // The route the SUSPENDED (or re-QUEUED) transition honors. The supervisor's suspend flow may not
      // thread the route through every hop, so prefer the carried route and otherwise resolve the run's
      // durable residency ONCE (forceDurable) rather than let a poll-lagging / undefined-dial pod take
      // the never-enrolled Postgres shortcut and freeze a redis-primary run's head. Fails closed. Placed
      // after the discard early-exits so a discarded checkpoint does no durable read.
      let effectiveRoute = snapshotRoute;
      if (effectiveRoute === undefined) {
        const resolved = await this.$.runStore.readSnapshotRoute(runId, snapshot.organizationId, {
          forceDurable: true,
        });
        effectiveRoute = resolved ? toWireRoute(resolved) : undefined;
      }

      // Get the run (run-ops scalars only) and update the status; the control-plane env is
      // resolved separately so the run-ops DB can split without a cross-provider join.
      const run = await this.$.runStore.suspendForCheckpoint(
        runId,
        {
          include: {},
        },
        this.$.prisma
      );

      if (!run) {
        this.$.logger.error("Run not found for createCheckpoint", {
          runId,
          snapshotId: snapshot.id,
          executionStatus: snapshot.executionStatus,
        });

        throw new ServiceValidationError("Run not found", 404);
      }

      const env = await this.$.controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);

      if (!env) {
        this.$.logger.error("Environment not found for createCheckpoint", {
          runId,
          snapshotId: snapshot.id,
          executionStatus: snapshot.executionStatus,
          runtimeEnvironmentId: run.runtimeEnvironmentId,
        });

        throw new ServiceValidationError("Run not found", 404);
      }

      this.$.eventBus.emit("runStatusChanged", {
        time: new Date(),
        run: {
          id: runId,
          status: run.status,
          updatedAt: run.updatedAt,
          createdAt: run.createdAt,
          runTags: run.runTags,
          batchId: run.batchId,
        },
        organization: {
          id: env.organizationId,
        },
        project: {
          id: env.projectId,
        },
        environment: {
          id: env.id,
        },
      });

      // Create the checkpoint through the run-ops store (routed by owning run id). When a caller
      // supplied a tx distinct from the base client, pass it through so the write stays atomic with
      // that transaction; otherwise the store resolves it on its own client (passthrough in single-DB).
      const taskRunCheckpoint = await this.$.runStore.createTaskRunCheckpoint(
        {
          data: {
            ...CheckpointId.generate(),
            type: checkpoint.type,
            location: checkpoint.location,
            imageRef: checkpoint.imageRef,
            reason: checkpoint.reason,
            runtimeEnvironmentId: env.id,
            projectId: env.projectId,
          },
        },
        run.id,
        tx ? prisma : undefined
      );

      if (snapshot.executionStatus === "QUEUED_EXECUTING") {
        // Enqueue the run again
        const newSnapshot = await this.enqueueSystem.enqueueRun({
          run,
          env,
          snapshot: {
            status: "QUEUED",
            description:
              "Run was QUEUED, because it was queued and executing and a checkpoint was created",
            metadata: snapshot.metadata,
          },
          previousSnapshotId: snapshot.id,
          batchId: snapshot.batchId ?? undefined,
          completedWaitpoints: snapshot.completedWaitpoints.map((waitpoint) => ({
            id: waitpoint.id,
            index: waitpoint.index,
          })),
          checkpointId: taskRunCheckpoint.id,
          snapshotRoute: effectiveRoute,
        });

        this.$.logger.debug("Releasing concurrency for run because it was checkpointed", {
          runId,
          snapshotId: snapshot.id,
          executionStatus: snapshot.executionStatus,
          newSnapshotId: newSnapshot.id,
          newExecutionStatus: newSnapshot.executionStatus,
        });

        if (run.organizationId) {
          await this.$.runQueue.releaseAllConcurrency(run.organizationId, run.id);
        }

        return {
          ok: true as const,
          ...executionResultFromSnapshot(newSnapshot),
          checkpoint: taskRunCheckpoint,
        } satisfies CreateCheckpointResult;
      } else {
        //create a new execution snapshot, with the checkpoint
        const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run,
          snapshot: {
            executionStatus: "SUSPENDED",
            description: "Run was suspended after creating a checkpoint.",
            metadata: snapshot.metadata,
          },
          previousSnapshotId: snapshot.id,
          batchId: snapshot.batchId ?? undefined,
          completedWaitpoints: snapshot.completedWaitpoints.map((waitpoint) => ({
            id: waitpoint.id,
            index: waitpoint.index,
          })),
          environmentId: snapshot.environmentId,
          environmentType: snapshot.environmentType,
          projectId: snapshot.projectId,
          organizationId: snapshot.organizationId,
          checkpointId: taskRunCheckpoint.id,
          workerId,
          runnerId,
          snapshotRoute: effectiveRoute,
        });

        this.$.logger.debug("Releasing concurrency for run because it was checkpointed", {
          runId,
          snapshotId: snapshot.id,
          executionStatus: snapshot.executionStatus,
          newSnapshotId: newSnapshot.id,
          newExecutionStatus: newSnapshot.executionStatus,
        });

        if (run.organizationId) {
          await this.$.runQueue.releaseAllConcurrency(run.organizationId, run.id);
        }

        return {
          ok: true as const,
          ...executionResultFromSnapshot(newSnapshot),
          checkpoint: taskRunCheckpoint,
        } satisfies CreateCheckpointResult;
      }
    });
  }

  /**
   * This is called when a run has been restored from a checkpoint and is ready to start executing again
   */
  async continueRunExecution({
    runId,
    snapshotId,
    workerId,
    runnerId,
    environmentId,
    snapshotRoute,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    workerId?: string;
    runnerId?: string;
    environmentId?: string;
    // Carried from the restore DequeuedMessage so the resume transition honors durable residency on
    // a poll-lagging pod. Undefined for a never-enrolled run.
    snapshotRoute?: SnapshotRouteWire;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.$.prisma;

    return await this.$.runLock.lock("continueRunExecution", [runId], async () => {
      const snapshot = await getLatestExecutionSnapshot(
        prisma,
        runId,
        this.$.runStore,
        environmentId
      );

      if (snapshot.id !== snapshotId) {
        throw new ServiceValidationError(
          "Snapshot ID doesn't match the latest snapshot in continueRunExecution",
          400,
          {
            snapshotId,
            latestSnapshotId: snapshot.id,
          }
        );
      }

      if (!isPendingExecuting(snapshot.executionStatus)) {
        throw new ServiceValidationError(
          "Snapshot is not in a valid state to continue in continueRunExecution",
          400,
          {
            snapshotId,
            snapshotStatus: snapshot.executionStatus,
          }
        );
      }

      // Get the run and update the status
      const run = await this.$.runStore.resumeFromCheckpoint(
        runId,
        {
          select: {
            id: true,
            status: true,
            attemptNumber: true,
            organizationId: true,
            runtimeEnvironmentId: true,
            projectId: true,
            updatedAt: true,
            createdAt: true,
            runTags: true,
            batchId: true,
          },
        },
        this.$.prisma
      );

      if (!run) {
        this.$.logger.error("Run not found for createCheckpoint", {
          runId,
          snapshotId: snapshot.id,
          executionStatus: snapshot.executionStatus,
        });

        throw new ServiceValidationError("Run not found", 404);
      }

      this.$.eventBus.emit("runStatusChanged", {
        time: new Date(),
        run: {
          id: runId,
          status: run.status,
          updatedAt: run.updatedAt,
          createdAt: run.createdAt,
          runTags: run.runTags,
          batchId: run.batchId,
        },
        organization: {
          id: run.organizationId ?? undefined,
        },
        project: {
          id: run.projectId,
        },
        environment: {
          id: run.runtimeEnvironmentId,
        },
      });

      const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run,
        snapshot: {
          executionStatus: "EXECUTING",
          description: "Run was continued after being suspended",
        },
        previousSnapshotId: snapshot.id,
        environmentId: snapshot.environmentId,
        environmentType: snapshot.environmentType,
        projectId: snapshot.projectId,
        organizationId: snapshot.organizationId,
        batchId: snapshot.batchId ?? undefined,
        completedWaitpoints: snapshot.completedWaitpoints,
        workerId,
        runnerId,
        snapshotRoute,
      });

      // Let worker know about the new snapshot so it can continue the run
      await sendNotificationToWorker({ runId, snapshot: newSnapshot, eventBus: this.$.eventBus });

      return {
        ...executionResultFromSnapshot(newSnapshot),
      } satisfies ExecutionResult;
    });
  }
}
