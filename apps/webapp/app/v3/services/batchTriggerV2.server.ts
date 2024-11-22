import {
  BatchTriggerTaskResponse,
  BatchTriggerTaskV2RequestBody,
  BatchTriggerTaskV2Response,
  packetRequiresOffloading,
  parsePacket,
} from "@trigger.dev/core/v3";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { workerQueue } from "~/services/worker.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs/index.server";
import { guardQueueSizeLimitsForEnv } from "../queueSizeLimits.server";
import { downloadPacketFromObjectStore, uploadPacketToObjectStore } from "../r2.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { startActiveSpan } from "../tracer.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "./triggerTask.server";
import { BatchTaskRun } from "@trigger.dev/database";
import { batchTaskRunItemStatusForRunStatus } from "~/models/taskRun.server";
import { logger } from "~/services/logger.server";

const PROCESSING_BATCH_SIZE = 50;

export type BatchTriggerTaskServiceOptions = {
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
};

export class BatchTriggerV2Service extends BaseService {
  public async call(
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV2RequestBody,
    options: BatchTriggerTaskServiceOptions = {}
  ): Promise<BatchTriggerTaskV2Response> {
    return await this.traceWithEnv<BatchTriggerTaskV2Response>(
      "call()",
      environment,
      async (span) => {
        const existingBatch = options.idempotencyKey
          ? await this._prisma.batchTaskRun.findUnique({
              where: {
                runtimeEnvironmentId_idempotencyKey: {
                  runtimeEnvironmentId: environment.id,
                  idempotencyKey: options.idempotencyKey,
                },
              },
            })
          : undefined;

        if (existingBatch) {
          if (
            existingBatch.idempotencyKeyExpiresAt &&
            existingBatch.idempotencyKeyExpiresAt < new Date()
          ) {
            logger.debug("[BatchTriggerV2][call] Idempotency key has expired", {
              idempotencyKey: options.idempotencyKey,
              batch: {
                id: existingBatch.id,
                friendlyId: existingBatch.friendlyId,
                runCount: existingBatch.runCount,
                idempotencyKeyExpiresAt: existingBatch.idempotencyKeyExpiresAt,
                idempotencyKey: existingBatch.idempotencyKey,
              },
            });

            // Update the existing batch to remove the idempotency key
            await this._prisma.batchTaskRun.update({
              where: { id: existingBatch.id },
              data: { idempotencyKey: null },
            });

            // Don't return, just continue with the batch trigger
          } else {
            span.setAttribute("batchId", existingBatch.friendlyId);

            return this.#respondWithExistingBatch(existingBatch, environment);
          }
        }

        const batchId = generateFriendlyId("batch");

        span.setAttribute("batchId", batchId);

        const dependentAttempt = body?.dependentAttempt
          ? await this._prisma.taskRunAttempt.findUnique({
              where: { friendlyId: body.dependentAttempt },
              include: {
                taskRun: {
                  select: {
                    id: true,
                    status: true,
                  },
                },
              },
            })
          : undefined;

        if (
          dependentAttempt &&
          (isFinalAttemptStatus(dependentAttempt.status) ||
            isFinalRunStatus(dependentAttempt.taskRun.status))
        ) {
          logger.debug("[BatchTriggerV2][call] Dependent attempt or run is in a terminal state", {
            dependentAttempt: dependentAttempt,
            batchId,
          });

          throw new ServiceValidationError(
            "Cannot process batch as the parent run is already in a terminal state"
          );
        }

        if (environment.type !== "DEVELOPMENT") {
          const result = await getEntitlement(environment.organizationId);
          if (result && result.hasAccess === false) {
            throw new OutOfEntitlementError();
          }
        }

        const idempotencyKeys = body.items.map((i) => i.options?.idempotencyKey).filter(Boolean);

        const cachedRuns =
          idempotencyKeys.length > 0
            ? await this._prisma.taskRun.findMany({
                where: {
                  runtimeEnvironmentId: environment.id,
                  idempotencyKey: {
                    in: body.items.map((i) => i.options?.idempotencyKey).filter(Boolean),
                  },
                },
                select: {
                  friendlyId: true,
                  idempotencyKey: true,
                  idempotencyKeyExpiresAt: true,
                },
              })
            : [];

        if (cachedRuns.length) {
          logger.debug("[BatchTriggerV2][call] Found cached runs", {
            cachedRuns,
            batchId,
          });
        }

        // Now we need to create an array of all the run IDs, in order
        // If we have a cached run, that isn't expired, we should use that run ID
        // If we have a cached run, that is expired, we should generate a new run ID and save that cached run ID to a set of expired run IDs
        // If we don't have a cached run, we should generate a new run ID
        const expiredRunIds = new Set<string>();
        let cachedRunCount = 0;

        const runIds = body.items.map((item) => {
          const cachedRun = cachedRuns.find(
            (r) => r.idempotencyKey === item.options?.idempotencyKey
          );

          if (cachedRun) {
            if (
              cachedRun.idempotencyKeyExpiresAt &&
              cachedRun.idempotencyKeyExpiresAt < new Date()
            ) {
              expiredRunIds.add(cachedRun.friendlyId);

              return generateFriendlyId("run");
            }

            cachedRunCount++;

            return cachedRun.friendlyId;
          }

          return generateFriendlyId("run");
        });

        // Calculate how many new runs we need to create
        const newRunCount = body.items.length - cachedRunCount;

        if (newRunCount === 0) {
          logger.debug("[BatchTriggerV2][call] All runs are cached", {
            batchId,
          });

          return {
            batchId,
            runs: runIds,
          };
        }

        const queueSizeGuard = await guardQueueSizeLimitsForEnv(environment, marqs, newRunCount);

        logger.debug("Queue size guard result", {
          newRunCount,
          queueSizeGuard,
          environment: {
            id: environment.id,
            type: environment.type,
            organization: environment.organization,
            project: environment.project,
          },
        });

        if (!queueSizeGuard.isWithinLimits) {
          throw new ServiceValidationError(
            `Cannot trigger ${newRunCount} tasks as the queue size limit for this environment has been reached. The maximum size is ${queueSizeGuard.maximumSize}`
          );
        }

        // Expire the cached runs that are no longer valid
        if (expiredRunIds.size) {
          logger.debug("Expiring cached runs", {
            expiredRunIds: Array.from(expiredRunIds),
            batchId,
          });

          // TODO: is there a limit to the number of items we can update in a single query?
          await this._prisma.taskRun.updateMany({
            where: { friendlyId: { in: Array.from(expiredRunIds) } },
            data: { idempotencyKey: null },
          });
        }

        // Upload to object store
        const payloadPacket = await this.#handlePayloadPacket(
          body.items,
          `batch/${batchId}`,
          environment
        );

        const batch = await $transaction(this._prisma, async (tx) => {
          const batch = await tx.batchTaskRun.create({
            data: {
              friendlyId: generateFriendlyId("batch"),
              runtimeEnvironmentId: environment.id,
              idempotencyKey: options.idempotencyKey,
              idempotencyKeyExpiresAt: options.idempotencyKeyExpiresAt,
              dependentTaskAttemptId: dependentAttempt?.id,
              runCount: body.items.length,
              runIds,
              payload: payloadPacket.data,
              payloadType: payloadPacket.dataType,
              options,
            },
          });

          await this.#enqueueBatchTaskRun(batch.id, 0, 0, tx);

          return batch;
        });

        if (!batch) {
          throw new Error("Failed to create batch");
        }

        return {
          id: batch.friendlyId,
          isCached: false,
          idempotencyKey: batch.idempotencyKey ?? undefined,
        };
      }
    );
  }

  async #respondWithExistingBatch(
    batch: BatchTaskRun,
    environment: AuthenticatedEnvironment
  ): Promise<BatchTriggerTaskV2Response> {
    // Resolve the payload
    const payloadPacket = await downloadPacketFromObjectStore(
      {
        data: batch.payload ?? undefined,
        dataType: batch.payloadType,
      },
      environment
    );

    const payload = await parsePacket(payloadPacket).then(
      (p) => p as BatchTriggerTaskV2RequestBody["items"]
    );

    const runs = batch.runIds.map((id, index) => {
      const item = payload[index];

      return {
        id,
        taskIdentifier: item.task,
        isCached: true,
        idempotencyKey: item.options?.idempotencyKey ?? undefined,
      };
    });

    return {
      id: batch.friendlyId,
      idempotencyKey: batch.idempotencyKey ?? undefined,
      isCached: true,
      runs,
    };
  }

  async processBatchTaskRun(batchId: string, currentIndex: number, attemptCount: number) {
    logger.debug("[BatchTriggerV2][processBatchTaskRun] Processing batch", {
      batchId,
      currentIndex,
      attemptCount,
    });

    const $attemptCount = attemptCount + 1;

    const batch = await this._prisma.batchTaskRun.findFirst({
      where: { id: batchId },
      include: {
        runtimeEnvironment: {
          include: {
            project: true,
            organization: true,
          },
        },
      },
    });

    if (!batch) {
      return;
    }

    // Check to make sure the currentIndex is not greater than the runCount
    if (currentIndex >= batch.runCount) {
      logger.debug("[BatchTriggerV2][processBatchTaskRun] currentIndex is greater than runCount", {
        batchId: batch.friendlyId,
        currentIndex,
        runCount: batch.runCount,
        attemptCount: $attemptCount,
      });

      return;
    }

    // Resolve the payload
    const payloadPacket = await downloadPacketFromObjectStore(
      {
        data: batch.payload ?? undefined,
        dataType: batch.payloadType,
      },
      batch.runtimeEnvironment
    );

    const payload = await parsePacket(payloadPacket);

    if (!payload) {
      logger.debug("[BatchTriggerV2][processBatchTaskRun] Failed to parse payload", {
        batchId: batch.friendlyId,
        currentIndex,
        attemptCount: $attemptCount,
      });

      throw new Error("Failed to parse payload");
    }

    // Skip zod parsing
    const $payload = payload as BatchTriggerTaskV2RequestBody["items"];

    // Grab the next PROCESSING_BATCH_SIZE runIds
    const runIds = batch.runIds.slice(currentIndex, currentIndex + PROCESSING_BATCH_SIZE);

    logger.debug("[BatchTriggerV2][processBatchTaskRun] Processing batch items", {
      batchId: batch.friendlyId,
      currentIndex,
      runIds,
      attemptCount: $attemptCount,
      runCount: batch.runCount,
    });

    // Combine the "window" between currentIndex and currentIndex + PROCESSING_BATCH_SIZE with the runId and the item in the payload which is an array
    const itemsToProcess = runIds.map((runId, index) => ({
      runId,
      item: $payload[index + currentIndex],
    }));

    let workingIndex = currentIndex;

    for (const item of itemsToProcess) {
      try {
        await this.#processBatchTaskRunItem(
          batch,
          batch.runtimeEnvironment,
          item,
          workingIndex,
          batch.options as BatchTriggerTaskServiceOptions
        );

        workingIndex++;
      } catch (error) {
        logger.error("[BatchTriggerV2][processBatchTaskRun] Failed to process item", {
          batchId: batch.friendlyId,
          currentIndex: workingIndex,
          error,
        });

        // Requeue the batch to try again
        await this.#enqueueBatchTaskRun(batch.id, workingIndex, $attemptCount);
        return;
      }
    }

    // if there are more items to process, requeue the batch
    if (workingIndex < batch.runCount) {
      await this.#enqueueBatchTaskRun(batch.id, workingIndex, 0);
      return;
    }
  }

  async #processBatchTaskRunItem(
    batch: BatchTaskRun,
    environment: AuthenticatedEnvironment,
    task: { runId: string; item: BatchTriggerTaskV2RequestBody["items"][number] },
    currentIndex: number,
    options?: BatchTriggerTaskServiceOptions
  ) {
    logger.debug("[BatchTriggerV2][processBatchTaskRunItem] Processing item", {
      batchId: batch.friendlyId,
      runId: task.runId,
      currentIndex,
    });

    // If the item has an idempotency key, it's possible the run already exists and we should check for that
    if (task.item.options?.idempotencyKey) {
      const existingRun = await this._prisma.taskRun.findFirst({
        where: {
          friendlyId: task.runId,
        },
      });

      if (existingRun) {
        logger.debug("[BatchTriggerV2][processBatchTaskRunItem] Run already exists", {
          batchId: batch.friendlyId,
          runId: task.runId,
          currentIndex,
        });

        return;
      }
    }

    const triggerTaskService = new TriggerTaskService();

    const run = await triggerTaskService.call(
      task.item.task,
      environment,
      {
        ...task.item,
        options: {
          ...task.item.options,
          dependentBatch: batch.dependentTaskAttemptId ? batch.friendlyId : undefined, // Only set dependentBatch if dependentAttempt is set which means batchTriggerAndWait was called
          parentBatch: batch.dependentTaskAttemptId ? undefined : batch.friendlyId, // Only set parentBatch if dependentAttempt is NOT set which means batchTrigger was called
        },
      },
      {
        triggerVersion: options?.triggerVersion,
        traceContext: options?.traceContext,
        spanParentAsLink: options?.spanParentAsLink,
        batchId: batch.friendlyId,
        skipChecks: true,
        runId: task.runId,
      }
    );

    if (!run) {
      throw new Error(`Failed to trigger run ${task.runId} for batch ${batch.friendlyId}`);
    }

    await this._prisma.batchTaskRunItem.create({
      data: {
        batchTaskRunId: batch.id,
        taskRunId: run.id,
        status: batchTaskRunItemStatusForRunStatus(run.status),
      },
    });
  }

  async #enqueueBatchTaskRun(
    batchId: string,
    currentIndex: number = 0,
    attemptCount: number = 0,
    tx?: PrismaClientOrTransaction
  ) {
    await workerQueue.enqueue(
      "v3.processBatchTaskRun",
      {
        batchId,
        currentIndex,
        attemptCount,
      },
      { tx, jobKey: `process-batch:${batchId}` }
    );
  }

  async #handlePayloadPacket(
    payload: any,
    pathPrefix: string,
    environment: AuthenticatedEnvironment
  ) {
    return await startActiveSpan("handlePayloadPacket()", async (span) => {
      const packet = { data: JSON.stringify(payload), dataType: "application/json" };

      if (!packet.data) {
        return packet;
      }

      const { needsOffloading } = packetRequiresOffloading(
        packet,
        env.TASK_PAYLOAD_OFFLOAD_THRESHOLD
      );

      if (!needsOffloading) {
        return packet;
      }

      const filename = `${pathPrefix}/payload.json`;

      await uploadPacketToObjectStore(filename, packet.data, packet.dataType, environment);

      return {
        data: filename,
        dataType: "application/store",
      };
    });
  }
}
