import {
  BatchTriggerTaskV2RequestBody,
  BatchTriggerTaskV3RequestBody,
  BatchTriggerTaskV3Response,
  IOPacket,
  packetRequiresOffloading,
  parsePacket,
} from "@trigger.dev/core/v3";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { BatchTaskRun, Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, prisma, PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { batchTriggerWorker } from "~/v3/batchTriggerWorker.server";
import { downloadPacketFromObjectStore, uploadPacketToObjectStore } from "../../v3/r2.server";
import { ServiceValidationError, WithRunEngine } from "../../v3/services/baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "../../v3/services/triggerTask.server";
import { startActiveSpan } from "../../v3/tracer.server";

const PROCESSING_BATCH_SIZE = 50;
const ASYNC_BATCH_PROCESS_SIZE_THRESHOLD = 20;
const MAX_ATTEMPTS = 10;

export const BatchProcessingStrategy = z.enum(["sequential", "parallel"]);
export type BatchProcessingStrategy = z.infer<typeof BatchProcessingStrategy>;

export const BatchProcessingOptions = z.object({
  batchId: z.string(),
  processingId: z.string(),
  range: z.object({ start: z.number().int(), count: z.number().int() }),
  attemptCount: z.number().int(),
  strategy: BatchProcessingStrategy,
  parentRunId: z.string().optional(),
  resumeParentOnCompletion: z.boolean().optional(),
});

export type BatchProcessingOptions = z.infer<typeof BatchProcessingOptions>;

export type BatchTriggerTaskServiceOptions = {
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  oneTimeUseToken?: string;
};

/**
 * Larger batches, used in Run Engine v2
 */
export class RunEngineBatchTriggerService extends WithRunEngine {
  private _batchProcessingStrategy: BatchProcessingStrategy;

  constructor(
    batchProcessingStrategy?: BatchProcessingStrategy,
    protected readonly _prisma: PrismaClientOrTransaction = prisma
  ) {
    super({ prisma });

    // Eric note: We need to force sequential processing because when doing parallel, we end up with high-contention on the parent run lock
    // becuase we are triggering a lot of runs at once, and each one is trying to lock the parent run.
    // by forcing sequential, we are only ever locking the parent run for a single run at a time.
    this._batchProcessingStrategy = "sequential";
  }

  public async call(
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV3RequestBody,
    options: BatchTriggerTaskServiceOptions = {}
  ): Promise<BatchTriggerTaskV3Response> {
    try {
      return await this.traceWithEnv<BatchTriggerTaskV3Response>(
        "call()",
        environment,
        async (span) => {
          const { id, friendlyId } = BatchId.generate();

          span.setAttribute("batchId", friendlyId);

          if (environment.type !== "DEVELOPMENT") {
            const result = await getEntitlement(environment.organizationId);
            if (result && result.hasAccess === false) {
              throw new OutOfEntitlementError();
            }
          }

          // Upload to object store
          const payloadPacket = await this.#handlePayloadPacket(
            body.items,
            `batch/${friendlyId}`,
            environment
          );

          const batch = await this.#createAndProcessBatchTaskRun(
            friendlyId,
            payloadPacket,
            environment,
            body,
            options
          );

          if (!batch) {
            throw new Error("Failed to create batch");
          }

          return {
            id: batch.friendlyId,
            isCached: false,
            idempotencyKey: batch.idempotencyKey ?? undefined,
            runCount: body.items.length,
          };
        }
      );
    } catch (error) {
      // Detect a prisma transaction Unique constraint violation
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.debug("RunEngineBatchTrigger: Prisma transaction error", {
          code: error.code,
          message: error.message,
          meta: error.meta,
        });

        if (error.code === "P2002") {
          const target = error.meta?.target;

          if (
            Array.isArray(target) &&
            target.length > 0 &&
            typeof target[0] === "string" &&
            target[0].includes("oneTimeUseToken")
          ) {
            throw new ServiceValidationError(
              "Cannot batch trigger with a one-time use token as it has already been used."
            );
          } else {
            throw new ServiceValidationError(
              "Cannot batch trigger as it has already been triggered with the same idempotency key."
            );
          }
        }
      }

      throw error;
    }
  }

  async #createAndProcessBatchTaskRun(
    batchId: string,
    payloadPacket: IOPacket,
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV2RequestBody,
    options: BatchTriggerTaskServiceOptions = {}
  ) {
    if (body.items.length <= ASYNC_BATCH_PROCESS_SIZE_THRESHOLD) {
      const batch = await this._prisma.batchTaskRun.create({
        data: {
          id: BatchId.fromFriendlyId(batchId),
          friendlyId: batchId,
          runtimeEnvironmentId: environment.id,
          runCount: body.items.length,
          runIds: [],
          payload: payloadPacket.data,
          payloadType: payloadPacket.dataType,
          options,
          batchVersion: "runengine:v1",
          oneTimeUseToken: options.oneTimeUseToken,
        },
      });

      if (body.parentRunId && body.resumeParentOnCompletion) {
        await this._engine.blockRunWithCreatedBatch({
          runId: RunId.fromFriendlyId(body.parentRunId),
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        });
      }

      const result = await this.#processBatchTaskRunItems({
        batch,
        environment,
        currentIndex: 0,
        batchSize: PROCESSING_BATCH_SIZE,
        items: body.items,
        options,
        parentRunId: body.parentRunId,
        resumeParentOnCompletion: body.resumeParentOnCompletion,
      });

      switch (result.status) {
        case "COMPLETE": {
          logger.debug("[RunEngineBatchTrigger][call] Batch inline processing complete", {
            batchId: batch.friendlyId,
            currentIndex: 0,
          });

          return batch;
        }
        case "INCOMPLETE": {
          logger.debug("[RunEngineBatchTrigger][call] Batch inline processing incomplete", {
            batchId: batch.friendlyId,
            currentIndex: result.workingIndex,
          });

          // If processing inline does not finish for some reason, enqueue processing the rest of the batch
          await this.#enqueueBatchTaskRun({
            batchId: batch.id,
            processingId: "0",
            range: {
              start: result.workingIndex,
              count: PROCESSING_BATCH_SIZE,
            },
            attemptCount: 0,
            strategy: "sequential",
            parentRunId: body.parentRunId,
            resumeParentOnCompletion: body.resumeParentOnCompletion,
          });

          return batch;
        }
        case "ERROR": {
          logger.error("[RunEngineBatchTrigger][call] Batch inline processing error", {
            batchId: batch.friendlyId,
            currentIndex: result.workingIndex,
            error: result.error,
          });

          await this.#enqueueBatchTaskRun({
            batchId: batch.id,
            processingId: "0",
            range: {
              start: result.workingIndex,
              count: PROCESSING_BATCH_SIZE,
            },
            attemptCount: 0,
            strategy: "sequential",
            parentRunId: body.parentRunId,
            resumeParentOnCompletion: body.resumeParentOnCompletion,
          });

          return batch;
        }
      }
    } else {
      const batch = await this._prisma.batchTaskRun.create({
        data: {
          id: BatchId.fromFriendlyId(batchId),
          friendlyId: batchId,
          runtimeEnvironmentId: environment.id,
          runCount: body.items.length,
          runIds: [],
          payload: payloadPacket.data,
          payloadType: payloadPacket.dataType,
          options,
          batchVersion: "runengine:v1",
          oneTimeUseToken: options.oneTimeUseToken,
        },
      });

      if (body.parentRunId && body.resumeParentOnCompletion) {
        await this._engine.blockRunWithCreatedBatch({
          runId: RunId.fromFriendlyId(body.parentRunId),
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        });
      }

      switch (this._batchProcessingStrategy) {
        case "sequential": {
          await this.#enqueueBatchTaskRun({
            batchId: batch.id,
            processingId: batchId,
            range: { start: 0, count: PROCESSING_BATCH_SIZE },
            attemptCount: 0,
            strategy: this._batchProcessingStrategy,
            parentRunId: body.parentRunId,
            resumeParentOnCompletion: body.resumeParentOnCompletion,
          });

          break;
        }
        case "parallel": {
          const ranges = Array.from({
            length: Math.ceil(body.items.length / PROCESSING_BATCH_SIZE),
          }).map((_, index) => ({
            start: index * PROCESSING_BATCH_SIZE,
            count: PROCESSING_BATCH_SIZE,
          }));

          await Promise.all(
            ranges.map((range, index) =>
              this.#enqueueBatchTaskRun({
                batchId: batch.id,
                processingId: `${index}`,
                range,
                attemptCount: 0,
                strategy: this._batchProcessingStrategy,
                parentRunId: body.parentRunId,
                resumeParentOnCompletion: body.resumeParentOnCompletion,
              })
            )
          );

          break;
        }
      }

      return batch;
    }
  }

  async #enqueueBatchTaskRun(options: BatchProcessingOptions) {
    await batchTriggerWorker.enqueue({
      id: `RunEngineBatchTriggerService.process:${options.batchId}:${options.processingId}`,
      job: "runengine.processBatchTaskRun",
      payload: options,
    });
  }

  // This is the function that the worker will call
  async processBatchTaskRun(options: BatchProcessingOptions) {
    logger.debug("[RunEngineBatchTrigger][processBatchTaskRun] Processing batch", {
      options,
    });

    const $attemptCount = options.attemptCount + 1;

    // Add early return if max attempts reached
    if ($attemptCount > MAX_ATTEMPTS) {
      logger.error("[RunEngineBatchTrigger][processBatchTaskRun] Max attempts reached", {
        options,
        attemptCount: $attemptCount,
      });
      // You might want to update the batch status to failed here
      return;
    }

    const batch = await this._prisma.batchTaskRun.findFirst({
      where: { id: options.batchId },
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
    if (options.range.start >= batch.runCount) {
      logger.debug(
        "[RunEngineBatchTrigger][processBatchTaskRun] currentIndex is greater than runCount",
        {
          options,
          batchId: batch.friendlyId,
          runCount: batch.runCount,
          attemptCount: $attemptCount,
        }
      );

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
      logger.debug("[RunEngineBatchTrigger][processBatchTaskRun] Failed to parse payload", {
        options,
        batchId: batch.friendlyId,
        attemptCount: $attemptCount,
      });

      throw new Error("Failed to parse payload");
    }

    // Skip zod parsing
    const $payload = payload as BatchTriggerTaskV2RequestBody["items"];
    const $options = batch.options as BatchTriggerTaskServiceOptions;

    const result = await this.#processBatchTaskRunItems({
      batch,
      environment: batch.runtimeEnvironment,
      currentIndex: options.range.start,
      batchSize: options.range.count,
      items: $payload,
      options: $options,
      parentRunId: options.parentRunId,
      resumeParentOnCompletion: options.resumeParentOnCompletion,
    });

    switch (result.status) {
      case "COMPLETE": {
        logger.debug("[RunEngineBatchTrigger][processBatchTaskRun] Batch processing complete", {
          options,
          batchId: batch.friendlyId,
          attemptCount: $attemptCount,
        });

        return;
      }
      case "INCOMPLETE": {
        logger.debug("[RunEngineBatchTrigger][processBatchTaskRun] Batch processing incomplete", {
          batchId: batch.friendlyId,
          currentIndex: result.workingIndex,
          attemptCount: $attemptCount,
        });

        // Only enqueue the next batch task run if the strategy is sequential
        // if the strategy is parallel, we will already have enqueued the next batch task run
        if (options.strategy === "sequential") {
          await this.#enqueueBatchTaskRun({
            batchId: batch.id,
            processingId: options.processingId,
            range: {
              start: result.workingIndex,
              count: options.range.count,
            },
            attemptCount: 0,
            strategy: options.strategy,
            parentRunId: options.parentRunId,
            resumeParentOnCompletion: options.resumeParentOnCompletion,
          });
        }

        return;
      }
      case "ERROR": {
        logger.error("[RunEngineBatchTrigger][processBatchTaskRun] Batch processing error", {
          batchId: batch.friendlyId,
          currentIndex: result.workingIndex,
          error: result.error,
          attemptCount: $attemptCount,
        });

        // if the strategy is sequential, we will requeue processing with a count of the PROCESSING_BATCH_SIZE
        // if the strategy is parallel, we will requeue processing with a range starting at the workingIndex and a count that is the remainder of this "slice" of the batch
        if (options.strategy === "sequential") {
          await this.#enqueueBatchTaskRun({
            batchId: batch.id,
            processingId: options.processingId,
            range: {
              start: result.workingIndex,
              count: options.range.count, // This will be the same as the original count
            },
            attemptCount: $attemptCount,
            strategy: options.strategy,
            parentRunId: options.parentRunId,
            resumeParentOnCompletion: options.resumeParentOnCompletion,
          });
        } else {
          await this.#enqueueBatchTaskRun({
            batchId: batch.id,
            processingId: options.processingId,
            range: {
              start: result.workingIndex,
              // This will be the remainder of the slice
              // for example if the original range was 0-50 and the workingIndex is 25, the new range will be 25-25
              // if the original range was 51-100 and the workingIndex is 75, the new range will be 75-25
              count: options.range.count - result.workingIndex - options.range.start,
            },
            attemptCount: $attemptCount,
            strategy: options.strategy,
            parentRunId: options.parentRunId,
            resumeParentOnCompletion: options.resumeParentOnCompletion,
          });
        }

        return;
      }
    }
  }

  async #processBatchTaskRunItems({
    batch,
    environment,
    currentIndex,
    batchSize,
    items,
    options,
    parentRunId,
    resumeParentOnCompletion,
  }: {
    batch: BatchTaskRun;
    environment: AuthenticatedEnvironment;
    currentIndex: number;
    batchSize: number;
    items: BatchTriggerTaskV2RequestBody["items"];
    options?: BatchTriggerTaskServiceOptions;
    parentRunId?: string | undefined;
    resumeParentOnCompletion?: boolean | undefined;
  }): Promise<
    | { status: "COMPLETE" }
    | { status: "INCOMPLETE"; workingIndex: number }
    | { status: "ERROR"; error: string; workingIndex: number }
  > {
    // Grab the next PROCESSING_BATCH_SIZE items
    const itemsToProcess = items.slice(currentIndex, currentIndex + batchSize);

    logger.debug("[RunEngineBatchTrigger][processBatchTaskRun] Processing batch items", {
      batchId: batch.friendlyId,
      currentIndex,
      runCount: batch.runCount,
    });

    let workingIndex = currentIndex;

    let runIds: string[] = [];

    for (const item of itemsToProcess) {
      try {
        const run = await this.#processBatchTaskRunItem({
          batch,
          environment,
          item,
          currentIndex: workingIndex,
          options,
          parentRunId,
          resumeParentOnCompletion,
        });

        if (!run) {
          logger.error("[RunEngineBatchTrigger][processBatchTaskRun] Failed to process item", {
            batchId: batch.friendlyId,
            currentIndex: workingIndex,
          });

          throw new Error("[RunEngineBatchTrigger][processBatchTaskRun] Failed to process item");
        }

        runIds.push(run.friendlyId);

        workingIndex++;
      } catch (error) {
        logger.error("[RunEngineBatchTrigger][processBatchTaskRun] Failed to process item", {
          batchId: batch.friendlyId,
          currentIndex: workingIndex,
          error,
        });

        return {
          status: "ERROR",
          error: error instanceof Error ? error.message : String(error),
          workingIndex,
        };
      }
    }

    //add the run ids to the batch
    const updatedBatch = await this._prisma.batchTaskRun.update({
      where: { id: batch.id },
      data: {
        runIds: {
          push: runIds,
        },
        processingJobsCount: {
          increment: runIds.length,
        },
      },
      select: {
        processingJobsCount: true,
        runCount: true,
      },
    });

    //triggered all the runs
    if (updatedBatch.processingJobsCount >= updatedBatch.runCount) {
      logger.debug("[RunEngineBatchTrigger][processBatchTaskRun] All runs created", {
        batchId: batch.friendlyId,
        processingJobsCount: updatedBatch.processingJobsCount,
        runCount: updatedBatch.runCount,
        workingIndex,
      });

      //if all the runs were idempotent, it's possible the batch is already completed
      await this._engine.tryCompleteBatch({ batchId: batch.id });
    }

    // if there are more items to process, requeue the batch
    if (workingIndex < batch.runCount) {
      return { status: "INCOMPLETE", workingIndex };
    }

    return { status: "COMPLETE" };
  }

  async #processBatchTaskRunItem({
    batch,
    environment,
    item,
    currentIndex,
    options,
    parentRunId,
    resumeParentOnCompletion,
  }: {
    batch: BatchTaskRun;
    environment: AuthenticatedEnvironment;
    item: BatchTriggerTaskV2RequestBody["items"][number];
    currentIndex: number;
    options?: BatchTriggerTaskServiceOptions;
    parentRunId: string | undefined;
    resumeParentOnCompletion: boolean | undefined;
  }) {
    logger.debug("[RunEngineBatchTrigger][processBatchTaskRunItem] Processing item", {
      batchId: batch.friendlyId,
      currentIndex,
    });

    const triggerTaskService = new TriggerTaskService();

    const result = await triggerTaskService.call(
      item.task,
      environment,
      {
        ...item,
        options: {
          ...item.options,
          parentRunId,
          resumeParentOnCompletion,
          parentBatch: batch.id,
        },
      },
      {
        triggerVersion: options?.triggerVersion,
        traceContext: options?.traceContext,
        spanParentAsLink: options?.spanParentAsLink,
        batchId: batch.id,
        batchIndex: currentIndex,
      },
      "V2"
    );

    return result
      ? {
          friendlyId: result.run.friendlyId,
        }
      : undefined;
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
