import {
  Prisma,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionStatus,
} from "@trigger.dev/database";
import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
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
    skipRunLock,
    includeTtl = false,
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
    skipRunLock?: boolean;
    /** When true, include TTL in the queued message (only for first enqueue from trigger). Default false. */
    includeTtl?: boolean;
  }) {
    const prisma = tx ?? this.$.prisma;

    return await this.$.runLock.lockIf(!skipRunLock, "enqueueRun", [run.id], async () => {
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

      // Force development runs to use the environment id as the worker queue.
      const workerQueue = env.type === "DEVELOPMENT" ? env.id : run.workerQueue;

      const timestamp = (run.queueTimestamp ?? run.createdAt).getTime() - run.priorityMs;

      // Include TTL only when explicitly requested (first enqueue from trigger).
      // Re-enqueues (waitpoint, checkpoint, delayed, pending version) must not add TTL.
      let ttlExpiresAt: number | undefined;
      if (includeTtl && run.ttl) {
        const expireAt = parseNaturalLanguageDuration(run.ttl);
        if (expireAt) {
          ttlExpiresAt = expireAt.getTime();
        }
      }

      await this.$.runQueue.enqueueMessage({
        env,
        workerQueue,
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
          ttlExpiresAt,
        },
      });

      return newSnapshot;
    });
  }
}
