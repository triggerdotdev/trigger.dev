import { type BatchTaskRunStatus, type Prisma } from "@trigger.dev/database";
import { type PrismaClientOrTransaction, type PrismaReplicaClient } from "~/db.server";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { engine } from "~/v3/runEngine.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";
import { BasePresenter } from "./basePresenter.server";

type BatchPresenterOptions = {
  environmentId: string;
  batchId: string;
  userId?: string;
};

// Shared by the read-through closures and the passthrough so every store path returns
// a byte-identical row shape.
const BATCH_SELECT = {
  id: true,
  friendlyId: true,
  status: true,
  runCount: true,
  batchVersion: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  processingStartedAt: true,
  processingCompletedAt: true,
  successfulRunCount: true,
  failedRunCount: true,
  idempotencyKey: true,
  errors: {
    select: {
      id: true,
      index: true,
      taskIdentifier: true,
      error: true,
      errorCode: true,
      createdAt: true,
    },
    orderBy: {
      index: "asc",
    },
  },
} satisfies Prisma.BatchTaskRunSelect;

type BatchRow = Prisma.BatchTaskRunGetPayload<{ select: typeof BATCH_SELECT }>;

type BatchPresenterDeps = {
  /** Resolved boot constant; never awaited per-request when supplied. */
  splitEnabled?: boolean;
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  readThrough?: typeof readThroughRun;
  resolveDisplayableEnvironment?: typeof findDisplayableEnvironment;
};

export type BatchPresenterData = Awaited<ReturnType<BatchPresenter["call"]>>;

export class BatchPresenter extends BasePresenter {
  constructor(
    _prisma?: PrismaClientOrTransaction,
    _replica?: PrismaClientOrTransaction,
    private readonly deps: BatchPresenterDeps = {}
  ) {
    super(_prisma, _replica);
  }

  public async call({ environmentId, batchId, userId }: BatchPresenterOptions) {
    // Reads the BatchTaskRun (run-ops) via the read-through layer: split on -> new run-ops
    // first, then the LEGACY RUN-OPS READ REPLICA only for not-yet-migrated batches (never the
    // legacy primary); split off (single-DB / self-host) -> one plain batchTaskRun.findFirst
    // (passthrough). The runtimeEnvironment (control-plane) is resolved separately because its
    // FK is physically dropped on cloud, so a batch row on the new run-ops DB cannot single-SQL
    // join to control-plane RuntimeEnvironment.
    const where = { runtimeEnvironmentId: environmentId, friendlyId: batchId } as const;
    const readBatch = (client: PrismaReplicaClient): Promise<BatchRow | null> =>
      client.batchTaskRun.findFirst({ select: BATCH_SELECT, where });

    const readThrough = this.deps.readThrough ?? readThroughRun;
    const batchResult = await readThrough<BatchRow>({
      // The read-through key; here it is the batch friendlyId. A cuid-shaped batch friendlyId
      // classifies as LEGACY and the read-through probes both stores (new first, then legacy
      // replica); a ksuid-shaped one (cut-over orgs) classifies as NEW and reads only the new
      // store — either way the row is found on the DB that owns it.
      runId: batchId,
      environmentId,
      readNew: readBatch,
      readLegacy: readBatch,
      deps: {
        splitEnabled: this.deps.splitEnabled,
        newClient: this.deps.newClient,
        legacyReplica: this.deps.legacyReplica,
      },
    });

    const batch =
      batchResult.source === "new" || batchResult.source === "legacy-replica"
        ? batchResult.value
        : null; // not-found / past-retention => normal not-found surface

    if (!batch) {
      throw new Error("Batch not found");
    }

    const hasFinished = batch.status !== "PENDING" && batch.status !== "PROCESSING";
    const isV2 = batch.batchVersion === "runengine:v2";

    // For v2 batches in PROCESSING state, get live progress from Redis
    // This provides real-time updates without waiting for the batch to complete
    let liveSuccessCount = batch.successfulRunCount ?? 0;
    let liveFailureCount = batch.failedRunCount ?? 0;

    if (isV2 && batch.status === "PROCESSING") {
      const liveProgress = await engine.getBatchQueueProgress(batch.id);
      if (liveProgress) {
        liveSuccessCount = liveProgress.successCount;
        liveFailureCount = liveProgress.failureCount;
      }
    }

    // Control-plane env resolved separately from the run-ops batch row (cross-seam FK dropped).
    const resolveEnv = this.deps.resolveDisplayableEnvironment ?? findDisplayableEnvironment;

    return {
      id: batch.id,
      friendlyId: batch.friendlyId,
      status: batch.status as BatchTaskRunStatus,
      runCount: batch.runCount,
      batchVersion: batch.batchVersion,
      isV2,
      createdAt: batch.createdAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString(),
      completedAt: batch.completedAt?.toISOString(),
      processingStartedAt: batch.processingStartedAt?.toISOString(),
      processingCompletedAt: batch.processingCompletedAt?.toISOString(),
      finishedAt: batch.completedAt
        ? batch.completedAt.toISOString()
        : hasFinished
          ? batch.updatedAt.toISOString()
          : undefined,
      hasFinished,
      successfulRunCount: liveSuccessCount,
      failedRunCount: liveFailureCount,
      idempotencyKey: batch.idempotencyKey,
      environment: await resolveEnv(environmentId, userId),
      errors: batch.errors.map((error) => ({
        id: error.id,
        index: error.index,
        taskIdentifier: error.taskIdentifier,
        error: error.error,
        errorCode: error.errorCode,
        createdAt: error.createdAt.toISOString(),
      })),
    };
  }
}
