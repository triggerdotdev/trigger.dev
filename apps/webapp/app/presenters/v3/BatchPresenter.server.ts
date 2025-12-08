import { type BatchTaskRunStatus } from "@trigger.dev/database";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { engine } from "~/v3/runEngine.server";
import { BasePresenter } from "./basePresenter.server";

type BatchPresenterOptions = {
  environmentId: string;
  batchId: string;
  userId?: string;
};

export type BatchPresenterData = Awaited<ReturnType<BatchPresenter["call"]>>;

export class BatchPresenter extends BasePresenter {
  public async call({ environmentId, batchId, userId }: BatchPresenterOptions) {
    const batch = await this._replica.batchTaskRun.findFirst({
      select: {
        id: true,
        friendlyId: true,
        status: true,
        runCount: true,
        batchVersion: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        processingStartedAt: true,
        successfulRunCount: true,
        failedRunCount: true,
        idempotencyKey: true,
        runtimeEnvironment: {
          select: {
            id: true,
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
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
      },
      where: {
        runtimeEnvironmentId: environmentId,
        friendlyId: batchId,
      },
    });

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
      finishedAt: batch.completedAt
        ? batch.completedAt.toISOString()
        : hasFinished
          ? batch.updatedAt.toISOString()
          : undefined,
      hasFinished,
      successfulRunCount: liveSuccessCount,
      failedRunCount: liveFailureCount,
      idempotencyKey: batch.idempotencyKey,
      environment: displayableEnvironment(batch.runtimeEnvironment, userId),
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

