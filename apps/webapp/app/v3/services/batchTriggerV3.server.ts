import {
  BatchTriggerTaskV2RequestBody,
  BatchTriggerTaskV2Response,
  IOPacket,
  packetRequiresOffloading,
  parsePacket,
} from "@trigger.dev/core/v3";
import { BatchId, RunId } from "@trigger.dev/core/v3/apps";
import { BatchTaskRun, Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, prisma, PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { workerQueue } from "~/services/worker.server";
import { downloadPacketFromObjectStore, uploadPacketToObjectStore } from "../r2.server";
import { startActiveSpan } from "../tracer.server";
import { ServiceValidationError, WithRunEngine } from "./baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "./triggerTask.server";
import { guardQueueSizeLimitsForEnv } from "./triggerTaskV2.server";

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
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  oneTimeUseToken?: string;
};

/**
 * Larger batches, used in Run Engine v2
 */
export class BatchTriggerV3Service extends WithRunEngine {
  private _batchProcessingStrategy: BatchProcessingStrategy;

  constructor(
    batchProcessingStrategy?: BatchProcessingStrategy,
    protected readonly _prisma: PrismaClientOrTransaction = prisma
  ) {
    super({ prisma });

    this._batchProcessingStrategy = batchProcessingStrategy ?? "parallel";
  }

  public async call(
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV2RequestBody,
    options: BatchTriggerTaskServiceOptions = {}
  ): Promise<BatchTriggerTaskV2Response> {
    try {
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
              logger.debug("[BatchTriggerV3][call] Idempotency key has expired", {
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

              return this.#respondWithExistingBatch(
                existingBatch,
                environment,
                body.resumeParentOnCompletion ? body.parentRunId : undefined
              );
            }
          }

          const { id, friendlyId } = BatchId.generate();

          span.setAttribute("batchId", friendlyId);

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
            logger.debug("[BatchTriggerV3][call] Found cached runs", {
              cachedRuns,
              batchId: friendlyId,
            });
          }

          // Now we need to create an array of all the run IDs, in order
          // If we have a cached run, that isn't expired, we should use that run ID
          // If we have a cached run, that is expired, we should generate a new run ID and save that cached run ID to a set of expired run IDs
          // If we don't have a cached run, we should generate a new run ID
          const expiredRunIds = new Set<string>();
          let cachedRunCount = 0;

          const runs = body.items.map((item) => {
            const cachedRun = cachedRuns.find(
              (r) => r.idempotencyKey === item.options?.idempotencyKey
            );

            const runId = RunId.generate();

            if (cachedRun) {
              if (
                cachedRun.idempotencyKeyExpiresAt &&
                cachedRun.idempotencyKeyExpiresAt < new Date()
              ) {
                expiredRunIds.add(cachedRun.friendlyId);

                return {
                  id: runId.friendlyId,
                  isCached: false,
                  idempotencyKey: item.options?.idempotencyKey ?? undefined,
                  taskIdentifier: item.task,
                };
              }

              cachedRunCount++;

              return {
                id: cachedRun.friendlyId,
                isCached: true,
                idempotencyKey: item.options?.idempotencyKey ?? undefined,
                taskIdentifier: item.task,
              };
            }

            return {
              id: runId.friendlyId,
              isCached: false,
              idempotencyKey: item.options?.idempotencyKey ?? undefined,
              taskIdentifier: item.task,
            };
          });

          //block the parent with any existing children
          if (body.resumeParentOnCompletion && body.parentRunId) {
            await this.#blockParentRun({
              parentRunId: body.parentRunId,
              childFriendlyIds: runs.flatMap((r) => (r.isCached ? [r.id] : [])),
              environment,
            });
          }

          // Calculate how many new runs we need to create
          const newRunCount = body.items.length - cachedRunCount;

          if (newRunCount === 0) {
            logger.debug("[BatchTriggerV3][call] All runs are cached", {
              batchId: friendlyId,
            });

            await this._prisma.batchTaskRun.create({
              data: {
                friendlyId,
                runtimeEnvironmentId: environment.id,
                idempotencyKey: options.idempotencyKey,
                idempotencyKeyExpiresAt: options.idempotencyKeyExpiresAt,
                runCount: body.items.length,
                runIds: runs.map((r) => r.id),
                //todo is this correct? Surely some of the runs could still be in progress?
                status: "COMPLETED",
                batchVersion: "v2",
                oneTimeUseToken: options.oneTimeUseToken,
              },
            });

            return {
              id: friendlyId,
              isCached: false,
              idempotencyKey: options.idempotencyKey ?? undefined,
              runs,
            };
          }

          const queueSizeGuard = await guardQueueSizeLimitsForEnv(
            this._engine,
            environment,
            newRunCount
          );

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
              batchId: friendlyId,
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
            `batch/${friendlyId}`,
            environment
          );

          const batch = await this.#createAndProcessBatchTaskRun(
            friendlyId,
            runs,
            payloadPacket,
            newRunCount,
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
            runs,
          };
        }
      );
    } catch (error) {
      // Detect a prisma transaction Unique constraint violation
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.debug("BatchTriggerV3: Prisma transaction error", {
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
    runs: Array<{
      id: string;
      isCached: boolean;
      idempotencyKey: string | undefined;
      taskIdentifier: string;
    }>,
    payloadPacket: IOPacket,
    newRunCount: number,
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV2RequestBody,
    options: BatchTriggerTaskServiceOptions = {}
  ) {
    if (newRunCount <= ASYNC_BATCH_PROCESS_SIZE_THRESHOLD) {
      const batch = await this._prisma.batchTaskRun.create({
        data: {
          friendlyId: batchId,
          runtimeEnvironmentId: environment.id,
          idempotencyKey: options.idempotencyKey,
          idempotencyKeyExpiresAt: options.idempotencyKeyExpiresAt,
          runCount: newRunCount,
          runIds: runs.map((r) => r.id),
          payload: payloadPacket.data,
          payloadType: payloadPacket.dataType,
          options,
          batchVersion: "v2",
          oneTimeUseToken: options.oneTimeUseToken,
        },
      });

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
          logger.debug("[BatchTriggerV3][call] Batch inline processing complete", {
            batchId: batch.friendlyId,
            currentIndex: 0,
          });

          return batch;
        }
        case "INCOMPLETE": {
          logger.debug("[BatchTriggerV3][call] Batch inline processing incomplete", {
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
          logger.error("[BatchTriggerV3][call] Batch inline processing error", {
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
      return await $transaction(this._prisma, async (tx) => {
        const batch = await tx.batchTaskRun.create({
          data: {
            friendlyId: batchId,
            runtimeEnvironmentId: environment.id,
            idempotencyKey: options.idempotencyKey,
            idempotencyKeyExpiresAt: options.idempotencyKeyExpiresAt,
            runCount: body.items.length,
            runIds: runs.map((r) => r.id),
            payload: payloadPacket.data,
            payloadType: payloadPacket.dataType,
            options,
            batchVersion: "v2",
            oneTimeUseToken: options.oneTimeUseToken,
          },
        });

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
              length: Math.ceil(newRunCount / PROCESSING_BATCH_SIZE),
            }).map((_, index) => ({
              start: index * PROCESSING_BATCH_SIZE,
              count: PROCESSING_BATCH_SIZE,
            }));

            await Promise.all(
              ranges.map((range, index) =>
                this.#enqueueBatchTaskRun(
                  {
                    batchId: batch.id,
                    processingId: `${index}`,
                    range,
                    attemptCount: 0,
                    strategy: this._batchProcessingStrategy,
                    parentRunId: body.parentRunId,
                    resumeParentOnCompletion: body.resumeParentOnCompletion,
                  },
                  tx
                )
              )
            );

            break;
          }
        }

        return batch;
      });
    }
  }

  async #respondWithExistingBatch(
    batch: BatchTaskRun,
    environment: AuthenticatedEnvironment,
    blockParentRunId: string | undefined
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

    //block the parent with all of the children
    if (blockParentRunId) {
      await this.#blockParentRun({
        parentRunId: blockParentRunId,
        childFriendlyIds: batch.runIds,
        environment,
      });
    }

    return {
      id: batch.friendlyId,
      idempotencyKey: batch.idempotencyKey ?? undefined,
      isCached: true,
      runs,
    };
  }

  async processBatchTaskRun(options: BatchProcessingOptions) {
    logger.debug("[BatchTriggerV3][processBatchTaskRun] Processing batch", {
      options,
    });

    const $attemptCount = options.attemptCount + 1;

    // Add early return if max attempts reached
    if ($attemptCount > MAX_ATTEMPTS) {
      logger.error("[BatchTriggerV3][processBatchTaskRun] Max attempts reached", {
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
      logger.debug("[BatchTriggerV3][processBatchTaskRun] currentIndex is greater than runCount", {
        options,
        batchId: batch.friendlyId,
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
      logger.debug("[BatchTriggerV3][processBatchTaskRun] Failed to parse payload", {
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
    });

    switch (result.status) {
      case "COMPLETE": {
        logger.debug("[BatchTriggerV3][processBatchTaskRun] Batch processing complete", {
          options,
          batchId: batch.friendlyId,
          attemptCount: $attemptCount,
        });

        return;
      }
      case "INCOMPLETE": {
        logger.debug("[BatchTriggerV3][processBatchTaskRun] Batch processing incomplete", {
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
        logger.error("[BatchTriggerV3][processBatchTaskRun] Batch processing error", {
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
    // Grab the next PROCESSING_BATCH_SIZE runIds
    const runFriendlyIds = batch.runIds.slice(currentIndex, currentIndex + batchSize);

    logger.debug("[BatchTriggerV3][processBatchTaskRun] Processing batch items", {
      batchId: batch.friendlyId,
      currentIndex,
      runIds: runFriendlyIds,
      runCount: batch.runCount,
    });

    // Combine the "window" between currentIndex and currentIndex + PROCESSING_BATCH_SIZE with the runId and the item in the payload which is an array
    const itemsToProcess = runFriendlyIds.map((runFriendlyId, index) => ({
      runFriendlyId,
      item: items[index + currentIndex],
    }));

    let workingIndex = currentIndex;

    for (const item of itemsToProcess) {
      try {
        await this.#processBatchTaskRunItem({
          batch,
          environment,
          task: item,
          currentIndex: workingIndex,
          options,
          parentRunId,
          resumeParentOnCompletion,
        });

        workingIndex++;
      } catch (error) {
        logger.error("[BatchTriggerV3][processBatchTaskRun] Failed to process item", {
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

    // if there are more items to process, requeue the batch
    if (workingIndex < batch.runCount) {
      return { status: "INCOMPLETE", workingIndex };
    }

    return { status: "COMPLETE" };
  }

  async #processBatchTaskRunItem({
    batch,
    environment,
    task,
    currentIndex,
    options,
    parentRunId,
    resumeParentOnCompletion,
  }: {
    batch: BatchTaskRun;
    environment: AuthenticatedEnvironment;
    task: { runFriendlyId: string; item: BatchTriggerTaskV2RequestBody["items"][number] };
    currentIndex: number;
    options?: BatchTriggerTaskServiceOptions;
    parentRunId: string | undefined;
    resumeParentOnCompletion: boolean | undefined;
  }) {
    logger.debug("[BatchTriggerV3][processBatchTaskRunItem] Processing item", {
      batchId: batch.friendlyId,
      runId: task.runFriendlyId,
      currentIndex,
    });

    const triggerTaskService = new TriggerTaskService();

    await triggerTaskService.call(
      task.item.task,
      environment,
      {
        ...task.item,
        options: {
          ...task.item.options,
          parentRunId,
          resumeParentOnCompletion,
        },
      },
      {
        triggerVersion: options?.triggerVersion,
        traceContext: options?.traceContext,
        spanParentAsLink: options?.spanParentAsLink,
        batchId: batch.friendlyId,
        skipChecks: true,
        runFriendlyId: task.runFriendlyId,
      }
    );
  }

  async #enqueueBatchTaskRun(options: BatchProcessingOptions, tx?: PrismaClientOrTransaction) {
    await workerQueue.enqueue("v3.processBatchTaskRunV3", options, {
      tx,
      jobKey: `BatchTriggerV3Service.process:${options.batchId}:${options.processingId}`,
    });
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

  async #blockParentRun({
    parentRunId,
    childFriendlyIds,
    environment,
  }: {
    parentRunId: string;
    childFriendlyIds: string[];
    environment: AuthenticatedEnvironment;
  }) {
    const runsWithAssociatedWaitpoints = await this._prisma.taskRun.findMany({
      where: {
        friendlyId: {
          in: childFriendlyIds,
        },
      },
      select: {
        associatedWaitpoint: {
          select: {
            id: true,
          },
        },
      },
    });

    await this._engine.blockRunWithWaitpoint({
      runId: parentRunId,
      waitpointId: runsWithAssociatedWaitpoints.flatMap((r) =>
        r.associatedWaitpoint ? [r.associatedWaitpoint.id] : []
      ),
      environmentId: environment.id,
      projectId: environment.projectId,
    });
  }
}
