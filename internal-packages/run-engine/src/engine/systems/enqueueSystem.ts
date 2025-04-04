import {
  Prisma,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionStatus,
} from "@trigger.dev/database";
import { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { ExecutionSnapshotSystem } from "./executionSnapshotSystem.js";
import { SystemResources } from "./systems.js";

export type EnqueueSystemOptions = {
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
};

export class EnqueueSystem {
  private readonly $: SystemResources;
  private readonly executionSnapshotSystem: ExecutionSnapshotSystem;

  constructor(private readonly options: EnqueueSystemOptions) {
    this.$ = options.resources;
    this.executionSnapshotSystem = options.executionSnapshotSystem;
  }

  public async enqueueRun({
    run,
    env,
    tx,
    snapshot,
    previousSnapshotId,
    batchId,
    checkpointId,
    completedWaitpoints,
    workerId,
    runnerId,
  }: {
    run: TaskRun;
    env: MinimalAuthenticatedEnvironment;
    tx?: PrismaClientOrTransaction;
    snapshot?: {
      status?: Extract<TaskRunExecutionStatus, "QUEUED" | "QUEUED_EXECUTING">;
      description?: string;
      metadata?: Prisma.JsonValue;
    };
    previousSnapshotId?: string;
    batchId?: string;
    checkpointId?: string;
    completedWaitpoints?: {
      id: string;
      index?: number;
    }[];
    workerId?: string;
    runnerId?: string;
  }) {
    const prisma = tx ?? this.$.prisma;

    return await this.$.runLock.lock([run.id], 5000, async () => {
      const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run: run,
        snapshot: {
          executionStatus: snapshot?.status ?? "QUEUED",
          description: snapshot?.description ?? "Run was QUEUED",
          metadata: snapshot?.metadata ?? undefined,
        },
        previousSnapshotId,
        batchId,
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.project.id,
        organizationId: env.organization.id,
        checkpointId,
        completedWaitpoints,
        workerId,
        runnerId,
      });

      const masterQueues = [run.masterQueue];
      if (run.secondaryMasterQueue) {
        masterQueues.push(run.secondaryMasterQueue);
      }

      const timestamp = (run.queueTimestamp ?? run.createdAt).getTime() - run.priorityMs;

      await this.$.runQueue.enqueueMessage({
        env,
        masterQueues,
        message: {
          runId: run.id,
          taskIdentifier: run.taskIdentifier,
          orgId: env.organization.id,
          projectId: env.project.id,
          environmentId: env.id,
          environmentType: env.type,
          queue: run.queue,
          concurrencyKey: run.concurrencyKey ?? undefined,
          timestamp,
          attempt: 0,
        },
      });

      return newSnapshot;
    });
  }
}
