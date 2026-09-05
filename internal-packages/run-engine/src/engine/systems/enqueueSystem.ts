import type {
  Prisma,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionStatus,
} from "@trigger.dev/database";
import type { CompletedWaitpointRecord, RunStore } from "@internal/run-store";
import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { QUEUED_SNAPSHOT_DESCRIPTION, QUEUED_SNAPSHOT_STATUS } from "../consts.js";
import type { ExecutionSnapshotSystem } from "./executionSnapshotSystem.js";
import type { SystemResources } from "./systems.js";

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
    completedWaitpointRecords,
    workerId,
    runnerId,
    skipRunLock,
    includeTtl = false,
    anchorEligibilityAtQueuePosition = false,
    enableFastPath = false,
    store,
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
    completedWaitpointRecords?: CompletedWaitpointRecord[];
    workerId?: string;
    runnerId?: string;
    skipRunLock?: boolean;
    /**
     * When true, arm the run's TTL on the queued message. Set by every path that is the run's
     * first real entry into the queue: trigger, a delayed run coming due, and the pending-version
     * promotion. Waitpoint and checkpoint re-enqueues must not re-arm it. Default false.
     */
    includeTtl?: boolean;
    /**
     * When true, the scheduling-delay clock starts at the run's queue position (its
     * `queueTimestamp`, which for a delayed run is `delayUntil`) rather than now. Set only where
     * the run was genuinely eligible to execute from that moment: trigger and a delayed run
     * coming due.
     *
     * Deliberately separate from `includeTtl`, because the two disagree on the pending-version
     * promotion: that promotion is the run's first entry into the queue (so TTL arms there), but
     * the run was NOT runnable while it waited for a worker version, and its `queueTimestamp`
     * still holds the original trigger time. Anchoring there would bill the whole wait-for-deploy
     * period as queue scheduling delay. Default false, so a new call site has to opt in.
     */
    anchorEligibilityAtQueuePosition?: boolean;
    /** When true, allow the queue to push directly to worker queue if concurrency is available. */
    enableFastPath?: boolean;
    /**
     * When set (inside `runStore.runInTransaction`), the snapshot write goes through this tx-bound
     * store so the promote+snapshot pair is atomic on the run's owning DB. The Redis enqueue
     * below is not part of that transaction.
     */
    store?: RunStore;
  }) {
    const prisma = tx ?? this.$.prisma;

    return await this.$.runLock.lockIf(!skipRunLock, "enqueueRun", [run.id], async () => {
      const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
        prisma,
        {
          run: run,
          snapshot: {
            executionStatus: snapshot?.status ?? QUEUED_SNAPSHOT_STATUS,
            description: snapshot?.description ?? QUEUED_SNAPSHOT_DESCRIPTION,
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
          completedWaitpointRecords,
          workerId,
          runnerId,
        },
        store
      );

      await this.publishRun({
        run,
        env,
        includeTtl,
        anchorEligibilityAtQueuePosition,
        enableFastPath,
      });

      return newSnapshot;
    });
  }

  /**
   * Publishes the run to the RunQueue without writing an execution snapshot. Callers that already
   * hold a `QUEUED` snapshot (the trigger path writes one inside the run-create transaction) use
   * this so the run does not pay for a second snapshot write.
   */
  public async publishRun({
    run,
    env,
    includeTtl = false,
    anchorEligibilityAtQueuePosition = false,
    enableFastPath = false,
  }: {
    run: TaskRun;
    env: MinimalAuthenticatedEnvironment;
    /** See `enqueueRun`. */
    includeTtl?: boolean;
    /** See `enqueueRun`. */
    anchorEligibilityAtQueuePosition?: boolean;
    /** When true, allow the queue to push directly to worker queue if concurrency is available. */
    enableFastPath?: boolean;
  }) {
    // Force development runs to use the environment id as the worker queue.
    const workerQueue = env.type === "DEVELOPMENT" ? env.id : run.workerQueue;

    const queuePositionMs = (run.queueTimestamp ?? run.createdAt).getTime();
    const timestamp = queuePositionMs - run.priorityMs;
    const eligibleAtMs = anchorEligibilityAtQueuePosition ? queuePositionMs : Date.now();

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
      enableFastPath,
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
        eligibleAtMs,
        attempt: 0,
        ttlExpiresAt,
      },
    });
  }
}
