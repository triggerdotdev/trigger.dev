import type {
  Prisma,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunCheckpoint,
  TaskRunExecutionStatus,
} from "@trigger.dev/database";
import type { CompletedWaitpointRecord, RunStore, SnapshotRouteWire } from "@internal/run-store";
import { snapshotRouteFromSnapshot } from "@internal/run-store";
import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { QUEUED_SNAPSHOT_DESCRIPTION, QUEUED_SNAPSHOT_STATUS } from "../consts.js";
import { parseGates } from "../gateParsing.js";
import { workerQueueForPublish } from "../workerQueueRouting.js";
import type { ExecutionSnapshotSystem, PreviousSnapshot } from "./executionSnapshotSystem.js";
import type { SystemResources } from "./systems.js";

export type EnqueueSystemOptions = {
  resources: SystemResources;
  executionSnapshotSystem: ExecutionSnapshotSystem;
};

function parseRunGates(
  gates: unknown
): Array<{ queue: string; concurrencyKey?: string }> | undefined {
  const parsed = parseGates(gates);
  return parsed.length > 0 ? parsed : undefined;
}

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
    previousSnapshot,
    snapshotRoute,
    batchId,
    checkpoint,
    completedWaitpoints,
    resolveCompletedWaitpointRecords,
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
    previousSnapshot?: PreviousSnapshot;
    /** Server-side only: never published to workers or exposed through an API. */
    snapshotRoute?: SnapshotRouteWire;
    batchId?: string;
    checkpoint?: Pick<TaskRunCheckpoint, "id" | "type">;
    completedWaitpoints?: {
      id: string;
      index?: number;
    }[];
    resolveCompletedWaitpointRecords?: () => Promise<CompletedWaitpointRecord[]>;
    workerId?: string;
    runnerId?: string;
    skipRunLock?: boolean;
    /**
     * Arms the run's TTL. Set only on the run's first real entry into the queue: trigger, a
     * delayed run coming due, and the pending-version promotion. Re-enqueues must not re-arm it.
     */
    includeTtl?: boolean;
    /**
     * Starts the scheduling-delay clock at `queueTimestamp` (`delayUntil` for a delayed run), not
     * now. Set only where the run was eligible from that moment: trigger and a delayed run coming
     * due. It is separate from `includeTtl` because of the pending-version promotion: the run was
     * not runnable while it waited for a worker version, so anchoring there would bill the
     * wait-for-deploy time as queue delay.
     */
    anchorEligibilityAtQueuePosition?: boolean;
    /** Lets the queue push straight to the worker queue when concurrency is available. */
    enableFastPath?: boolean;
    /**
     * A tx-bound store from `runStore.runInTransaction`, so the snapshot write commits with the
     * caller's writes. The queue publish is not part of that transaction.
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
          previousSnapshot,
          snapshotRoute,
          batchId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.project.id,
          organizationId: env.organization.id,
          checkpointId: checkpoint?.id,
          completedWaitpoints,
          resolveCompletedWaitpointRecords,
          workerId,
          runnerId,
        },
        store
      );

      await this.publishRun({
        run,
        env,
        snapshotRoute: snapshotRouteFromSnapshot(newSnapshot),
        checkpoint,
        includeTtl,
        anchorEligibilityAtQueuePosition,
        enableFastPath,
      });

      return newSnapshot;
    });
  }

  /** Publishes without a snapshot write, for callers that already hold a `QUEUED` snapshot. */
  public async publishRun({
    run,
    env,
    snapshotRoute,
    checkpoint,
    includeTtl = false,
    anchorEligibilityAtQueuePosition = false,
    enableFastPath = false,
  }: {
    run: TaskRun;
    env: MinimalAuthenticatedEnvironment;
    snapshotRoute?: SnapshotRouteWire;
    checkpoint?: Pick<TaskRunCheckpoint, "id" | "type">;
    /** See `enqueueRun`. */
    includeTtl?: boolean;
    /** See `enqueueRun`. */
    anchorEligibilityAtQueuePosition?: boolean;
    /** See `enqueueRun`. */
    enableFastPath?: boolean;
  }) {
    const workerQueue = workerQueueForPublish(run, env, checkpoint);

    const queuePositionMs = (run.queueTimestamp ?? run.createdAt).getTime();
    const timestamp = queuePositionMs - run.priorityMs;
    const eligibleAtMs = anchorEligibilityAtQueuePosition ? queuePositionMs : Date.now();

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
        gates: parseRunGates(run.gates),
        timestamp,
        eligibleAtMs,
        attempt: 0,
        ttlExpiresAt,
        snapshotRoute,
      },
    });
  }
}
