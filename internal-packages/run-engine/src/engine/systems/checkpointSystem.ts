import { CheckpointInput, CreateCheckpointResult, ExecutionResult } from "@trigger.dev/core/v3";
import { CheckpointId } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { sendNotificationToWorker } from "../eventBus.js";
import { isCheckpointable, isPendingExecuting } from "../statuses.js";
import {
  getLatestExecutionSnapshot,
  executionResultFromSnapshot,
  ExecutionSnapshotSystem,
} from "./executionSnapshotSystem.js";
import { SystemResources } from "./systems.js";
import { ServiceValidationError } from "../errors.js";
import { EnqueueSystem } from "./enqueueSystem.js";

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
    tx,
  }: {
    runId: string;
    snapshotId: string;
    checkpoint: CheckpointInput;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<CreateCheckpointResult> {
    const prisma = tx ?? this.$.prisma;

    return await this.$.runLock.lock("createCheckpoint", [runId], async () => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);

      const isValidSnapshot =
        // Case 1: The provided snapshotId matches the current snapshot
        snapshot.id === snapshotId ||
        // Case 2: The provided snapshotId matches the previous snapshot
        // AND we're in QUEUED_EXECUTING state (which is valid)
        (snapshot.previousSnapshotId === snapshotId &&
          snapshot.executionStatus === "QUEUED_EXECUTING");

      if (!isValidSnapshot) {
        this.$.logger.info("Tried to createCheckpoint on an invalid snapshot", {
          snapshot,
          snapshotId,
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
          snapshot,
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

      // Get the run and update the status
      const run = await this.$.prisma.taskRun.update({
        where: {
          id: runId,
        },
        data: {
          status: "WAITING_TO_RESUME",
        },
        include: {
          runtimeEnvironment: {
            include: {
              project: true,
              organization: true,
            },
          },
        },
      });

      if (!run) {
        this.$.logger.error("Run not found for createCheckpoint", {
          snapshot,
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
        },
        organization: {
          id: run.runtimeEnvironment.organizationId,
        },
        project: {
          id: run.runtimeEnvironment.projectId,
        },
        environment: {
          id: run.runtimeEnvironment.id,
        },
      });

      // Create the checkpoint
      const taskRunCheckpoint = await prisma.taskRunCheckpoint.create({
        data: {
          ...CheckpointId.generate(),
          type: checkpoint.type,
          location: checkpoint.location,
          imageRef: checkpoint.imageRef,
          reason: checkpoint.reason,
          runtimeEnvironmentId: run.runtimeEnvironment.id,
          projectId: run.runtimeEnvironment.projectId,
        },
      });

      if (snapshot.executionStatus === "QUEUED_EXECUTING") {
        // Enqueue the run again
        const newSnapshot = await this.enqueueSystem.enqueueRun({
          run,
          env: run.runtimeEnvironment,
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
        });

        this.$.logger.debug("Releasing concurrency for run because it was checkpointed", {
          snapshot,
          newSnapshot,
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
        });

        this.$.logger.debug("Releasing concurrency for run because it was checkpointed", {
          snapshot,
          newSnapshot,
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
    tx,
  }: {
    runId: string;
    snapshotId: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.$.prisma;

    return await this.$.runLock.lock("continueRunExecution", [runId], async () => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);

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
      const run = await this.$.prisma.taskRun.update({
        where: {
          id: runId,
        },
        data: {
          status: "EXECUTING",
        },
        select: {
          id: true,
          status: true,
          attemptNumber: true,
          organizationId: true,
          runtimeEnvironmentId: true,
          projectId: true,
          updatedAt: true,
          createdAt: true,
        },
      });

      if (!run) {
        this.$.logger.error("Run not found for createCheckpoint", {
          snapshot,
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
      });

      // Let worker know about the new snapshot so it can continue the run
      await sendNotificationToWorker({ runId, snapshot: newSnapshot, eventBus: this.$.eventBus });

      return {
        ...executionResultFromSnapshot(newSnapshot),
      } satisfies ExecutionResult;
    });
  }
}
