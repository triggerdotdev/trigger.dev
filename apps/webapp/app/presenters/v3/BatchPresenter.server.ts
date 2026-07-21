import { type BatchTaskRunStatus, type Prisma } from "@trigger.dev/database";
import { type PrismaClientOrTransaction } from "~/db.server";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { engine } from "~/v3/runEngine.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";
import { BasePresenter } from "./basePresenter.server";

type BatchPresenterOptions = {
  environmentId: string;
  batchId: string;
  userId?: string;
};

const BATCH_INCLUDE = {
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
} satisfies Prisma.BatchTaskRunInclude;

type BatchPresenterDeps = {
  resolveDisplayableEnvironment?: typeof findDisplayableEnvironment;
};

export type BatchPresenterData = Awaited<ReturnType<BatchPresenter["call"]>>;

export class BatchPresenter extends BasePresenter {
  constructor(
    _prisma?: PrismaClientOrTransaction,
    _replica?: PrismaClientOrTransaction,
    private readonly deps: BatchPresenterDeps = {},
    private readonly runStore = defaultRunStore
  ) {
    super(_prisma, _replica);
  }

  public async call({ environmentId, batchId, userId }: BatchPresenterOptions) {
    // The BatchTaskRun (run-ops) is read through the run store, which routes by residency. The
    // runtimeEnvironment (control-plane) is resolved separately because the cross-seam FK is
    // dropped, so the batch row cannot single-SQL join to control-plane RuntimeEnvironment.
    let batch = await this.runStore.findBatchTaskRunByFriendlyId(
      batchId,
      environmentId,
      { include: BATCH_INCLUDE },
      this._replica
    );

    // Read-your-writes: findBatchTaskRunByFriendlyId defaults to (and here reads) the replica, so a
    // batch created within the replica's apply window returns null under lag. Re-read from the owning
    // primary on a miss so a live batch's detail page never spuriously 404s ("Batch not found").
    if (!batch) {
      batch = await this.runStore.findBatchTaskRunByFriendlyId(
        batchId,
        environmentId,
        { include: BATCH_INCLUDE },
        this._prisma
      );
    }

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
