import {
  BatchTriggerTaskV2RequestBody,
  BatchTriggerTaskV2Response,
  IOPacket,
  packetRequiresOffloading,
  parsePacket,
} from "@trigger.dev/core/v3";
import {
  BatchTaskRun,
  isPrismaRaceConditionError,
  isPrismaRetriableError,
  isUniqueConstraintError,
  Prisma,
  TaskRunAttempt,
} from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, prisma, PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { batchTaskRunItemStatusForRunStatus } from "~/models/taskRun.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { batchTriggerWorker } from "../batchTriggerWorker.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { legacyRunEngineWorker } from "../legacyRunEngineWorker.server";
import { marqs } from "../marqs/index.server";
import { guardQueueSizeLimitsForEnv } from "../queueSizeLimits.server";
import { downloadPacketFromObjectStore, uploadPacketToObjectStore } from "../r2.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { startActiveSpan } from "../tracer.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { OutOfEntitlementError, TriggerTaskService } from "./triggerTask.server";

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
});

export type BatchProcessingOptions = z.infer<typeof BatchProcessingOptions>;

export type BatchTriggerTaskServiceOptions = {
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  oneTimeUseToken?: string;
  realtimeStreamsVersion?: "v1" | "v2";
};

type RunItemData = {
  id: string;
  isCached: boolean;
  idempotencyKey: string | undefined;
  taskIdentifier: string;
};

/**
 * ### V3
 *
 * BatchTrigger v3 doesn't have any changes from v2, other than a different system for tracking if the
 * batch is completed.
 *
 * v3 BatchTaskRun's now must be "sealed" before they could be considered completed. Being "sealed" means
 * that all the items in the batch have been processed and the batch is ready to be considered completed.
 *
 * We also now track the expected count of items in the batch, and then as each BatchTaskRunItem is set to COMPLETED,
 * we increment the BatchTaskRun's completed count. Once the completed count is equal to the expected count, and the
 * batch is sealed, we can consider the batch completed.
 *
 * So now when the v3 batch is considered completed, we will enqueue the ResumeBatchRunService to resume the dependent
 * task attempt if there is one. This is in contrast to v2 batches where every time a task was completed, we would schedule
 * the ResumeBatchRunService to check if the batch was completed and set it to completed if it was.
 *
 * We've also introduced a new column "resumedAt" that will be set when the batch is resumed. Previously in v2 batches, the status == "COMPLETED" was overloaded
 * to mean that the batch was completed and resumed. Now we have a separate column to track when the batch was resumed (and to make sure it's only resumed once).
 *
 * ### V2
 *
 * Batch v2 added the ability to trigger more than 100 tasks in a single batch. This was done by offloading the payload to the object store and
 * then processing the batch in chunks of 50 tasks at a time in the background.
 *
 * The other main difference from v1 is that a single batch in v2 could trigger multiple different tasks, whereas in v1 a batch could only trigger a single task.
 */
export class BatchTriggerV3Service extends BaseService {
  private _batchProcessingStrategy: BatchProcessingStrategy;
  private _asyncBatchProcessSizeThreshold: number;

  constructor(
    batchProcessingStrategy?: BatchProcessingStrategy,
    asyncBatchProcessSizeThreshold: number = ASYNC_BATCH_PROCESS_SIZE_THRESHOLD,
    protected readonly _prisma: PrismaClientOrTransaction = prisma
  ) {
    super(_prisma);

    this._batchProcessingStrategy = batchProcessingStrategy ?? "parallel";
    this._asyncBatchProcessSizeThreshold = asyncBatchProcessSizeThreshold;
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
          if (!body.items || body.items.length === 0) {
            throw new ServiceValidationError("A batch trigger must have at least one item");
          }

          const existingBatch = options.idempotencyKey
            ? await this._prisma.batchTaskRun.findFirst({
                where: {
                  runtimeEnvironmentId: environment.id,
                  idempotencyKey: options.idempotencyKey,
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
            ? await this._prisma.taskRunAttempt.findFirst({
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

          const runs = await this.#prepareRunData(environment, body);

          // Calculate how many new runs we need to create
          const newRunCount = runs.filter((r) => !r.isCached).length;

          if (newRunCount === 0) {
            logger.debug("[BatchTriggerV2][call] All runs are cached", {
              batchId,
            });

            await this._prisma.batchTaskRun.create({
              data: {
                friendlyId: batchId,
                runtimeEnvironmentId: environment.id,
                idempotencyKey: options.idempotencyKey,
                idempotencyKeyExpiresAt: options.idempotencyKeyExpiresAt,
                dependentTaskAttemptId: dependentAttempt?.id,
                runCount: body.items.length,
                runIds: runs.map((r) => r.id),
                status: "COMPLETED",
                batchVersion: "v3",
                oneTimeUseToken: options.oneTimeUseToken,
              },
            });

            return {
              id: batchId,
              isCached: false,
              idempotencyKey: options.idempotencyKey ?? undefined,
              runs,
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

          // Upload to object store
          const payloadPacket = await this.#handlePayloadPacket(
            body.items,
            `batch/${batchId}`,
            environment
          );

          const batch = await this.#createAndProcessBatchTaskRun(
            batchId,
            runs,
            payloadPacket,
            newRunCount,
            environment,
            body,
            options,
            dependentAttempt ?? undefined
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
        logger.debug("BatchTriggerV2: Prisma transaction error", {
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

  async #prepareRunData(
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV2RequestBody
  ): Promise<Array<RunItemData>> {
    // batchTriggerAndWait cannot have cached runs because that does not work in run engine v1 and is not available in the client
    if (body?.dependentAttempt) {
      return body.items.map((item) => ({
        id: generateFriendlyId("run"),
        isCached: false,
        idempotencyKey: undefined,
        taskIdentifier: item.task,
      }));
    }

    // Group items by taskIdentifier
    const itemsByTask = body.items.reduce((acc, item) => {
      if (!item.options?.idempotencyKey) return acc;

      if (!acc[item.task]) {
        acc[item.task] = [];
      }
      acc[item.task].push(item);
      return acc;
    }, {} as Record<string, typeof body.items>);

    logger.debug("[BatchTriggerV2][call] Grouped items by task identifier", {
      itemsByTask,
    });

    // Fetch cached runs for each task identifier separately to make use of the index
    const cachedRuns = await Promise.all(
      Object.entries(itemsByTask).map(([taskIdentifier, items]) =>
        this._prisma.taskRun.findMany({
          where: {
            runtimeEnvironmentId: environment.id,
            taskIdentifier,
            idempotencyKey: {
              in: items.map((i) => i.options?.idempotencyKey).filter(Boolean),
            },
          },
          select: {
            friendlyId: true,
            idempotencyKey: true,
            idempotencyKeyExpiresAt: true,
          },
        })
      )
    ).then((results) => results.flat());

    // Now we need to create an array of all the run IDs, in order
    // If we have a cached run, that isn't expired, we should use that run ID
    // If we have a cached run, that is expired, we should generate a new run ID and save that cached run ID to a set of expired run IDs
    // If we don't have a cached run, we should generate a new run ID
    const expiredRunIds = new Set<string>();

    const runs = body.items.map((item) => {
      const cachedRun = cachedRuns.find((r) => r.idempotencyKey === item.options?.idempotencyKey);

      if (cachedRun) {
        if (cachedRun.idempotencyKeyExpiresAt && cachedRun.idempotencyKeyExpiresAt < new Date()) {
          expiredRunIds.add(cachedRun.friendlyId);

          return {
            id: generateFriendlyId("run"),
            isCached: false,
            idempotencyKey: item.options?.idempotencyKey ?? undefined,
            taskIdentifier: item.task,
          };
        }

        return {
          id: cachedRun.friendlyId,
          isCached: true,
          idempotencyKey: item.options?.idempotencyKey ?? undefined,
          taskIdentifier: item.task,
        };
      }

      return {
        id: generateFriendlyId("run"),
        isCached: false,
        idempotencyKey: item.options?.idempotencyKey ?? undefined,
        taskIdentifier: item.task,
      };
    });

    // Expire the cached runs that are no longer valid
    if (expiredRunIds.size) {
      await this._prisma.taskRun.updateMany({
        where: { friendlyId: { in: Array.from(expiredRunIds) } },
        data: { idempotencyKey: null },
      });
    }

    return runs;
  }

  async #createAndProcessBatchTaskRun(
    batchId: string,
    runs: Array<RunItemData>,
    payloadPacket: IOPacket,
    newRunCount: number,
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV2RequestBody,
    options: BatchTriggerTaskServiceOptions = {},
    dependentAttempt?: TaskRunAttempt
  ) {
    if (runs.length <= this._asyncBatchProcessSizeThreshold) {
      const batch = await this._prisma.batchTaskRun.create({
        data: {
          friendlyId: batchId,
          runtimeEnvironmentId: environment.id,
          idempotencyKey: options.idempotencyKey,
          idempotencyKeyExpiresAt: options.idempotencyKeyExpiresAt,
          dependentTaskAttemptId: dependentAttempt?.id,
          runCount: runs.length,
          runIds: runs.map((r) => r.id),
          payload: payloadPacket.data,
          payloadType: payloadPacket.dataType,
          options,
          batchVersion: "v3",
          oneTimeUseToken: options.oneTimeUseToken,
        },
      });

      const result = await this.#processBatchTaskRunItems(
        batch,
        environment,
        0,
        PROCESSING_BATCH_SIZE,
        body.items,
        options
      );

      if (result.error) {
        logger.error("[BatchTriggerV2][call] Batch inline processing error", {
          batchId: batch.friendlyId,
          currentIndex: result.workingIndex,
          error: result.error,
        });

        await this._prisma.batchTaskRun.update({
          where: {
            id: batch.id,
          },
          data: {
            status: "ABORTED",
            completedAt: new Date(),
          },
        });

        throw result.error;
      }

      // Update the batch to be sealed
      await this._prisma.batchTaskRun.update({
        where: { id: batch.id },
        data: { sealed: true, sealedAt: new Date() },
      });

      return batch;
    } else {
      const batch = await this._prisma.batchTaskRun.create({
        data: {
          friendlyId: batchId,
          runtimeEnvironmentId: environment.id,
          idempotencyKey: options.idempotencyKey,
          idempotencyKeyExpiresAt: options.idempotencyKeyExpiresAt,
          dependentTaskAttemptId: dependentAttempt?.id,
          runCount: body.items.length,
          runIds: runs.map((r) => r.id),
          payload: payloadPacket.data,
          payloadType: payloadPacket.dataType,
          options,
          batchVersion: "v3",
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

          await this._prisma.batchTaskRun.update({
            where: { id: batch.id },
            data: {
              processingJobsExpectedCount: ranges.length,
            },
          });

          await Promise.all(
            ranges.map((range, index) =>
              this.#enqueueBatchTaskRun({
                batchId: batch.id,
                processingId: `${index}`,
                range,
                attemptCount: 0,
                strategy: this._batchProcessingStrategy,
              })
            )
          );

          break;
        }
      }

      return batch;
    }
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

  async processBatchTaskRun(options: BatchProcessingOptions) {
    logger.debug("[BatchTriggerV2][processBatchTaskRun] Processing batch", {
      options,
    });

    const $attemptCount = options.attemptCount + 1;

    // Add early return if max attempts reached
    if ($attemptCount > MAX_ATTEMPTS) {
      logger.error("[BatchTriggerV2][processBatchTaskRun] Max attempts reached", {
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
      logger.debug("[BatchTriggerV2][processBatchTaskRun] currentIndex is greater than runCount", {
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
      logger.debug("[BatchTriggerV2][processBatchTaskRun] Failed to parse payload", {
        options,
        batchId: batch.friendlyId,
        attemptCount: $attemptCount,
      });

      throw new Error("Failed to parse payload");
    }

    // Skip zod parsing
    const $payload = payload as BatchTriggerTaskV2RequestBody["items"];
    const $options = batch.options as BatchTriggerTaskServiceOptions;

    const result = await this.#processBatchTaskRunItems(
      batch,
      batch.runtimeEnvironment,
      options.range.start,
      options.range.count,
      $payload,
      $options
    );

    if (result.error) {
      logger.error("[BatchTriggerV2][processBatchTaskRun] Batch processing error", {
        batchId: batch.friendlyId,
        currentIndex: result.workingIndex,
        error: result.error,
        attemptCount: $attemptCount,
      });

      // if the strategy is sequential, we will requeue processing with a count of the PROCESSING_BATCH_SIZE
      // if the strategy is parallel, we will requeue processing with a range starting at the workingIndex and a count that is the remainder of this "slice" of the batch
      await this.#enqueueBatchTaskRun({
        batchId: batch.id,
        processingId: options.processingId,
        range: {
          start: result.workingIndex,
          count:
            options.strategy === "sequential"
              ? options.range.count
              : options.range.count - result.workingIndex - options.range.start,
        },
        attemptCount: $attemptCount,
        strategy: options.strategy,
      });

      return;
    }

    switch (options.strategy) {
      case "sequential": {
        // We can tell if we are done by checking if the result.workingIndex is equal or greater than the runCount
        if (result.workingIndex >= batch.runCount) {
          // Update the batch to be sealed
          await this._prisma.batchTaskRun.update({
            where: { id: batch.id },
            data: { sealed: true, sealedAt: new Date() },
          });

          logger.debug("[BatchTriggerV2][processBatchTaskRun] Batch processing complete", {
            batchId: batch.friendlyId,
            runCount: batch.runCount,
            currentIndex: result.workingIndex,
            attemptCount: $attemptCount,
          });
        } else {
          // Requeue the next batch of processing
          await this.#enqueueBatchTaskRun({
            batchId: batch.id,
            processingId: options.processingId,
            range: {
              start: result.workingIndex,
              count: options.range.count,
            },
            attemptCount: 0,
            strategy: options.strategy,
          });
        }

        break;
      }
      case "parallel": {
        // We need to increment the processingJobsCount and check if we are done
        const { processingJobsCount, processingJobsExpectedCount } =
          await this._prisma.batchTaskRun.update({
            where: { id: batch.id },
            data: {
              processingJobsCount: {
                increment: 1,
              },
            },
            select: {
              processingJobsExpectedCount: true,
              processingJobsCount: true,
            },
          });

        if (processingJobsCount >= processingJobsExpectedCount) {
          // Update the batch to be sealed
          await this._prisma.batchTaskRun.update({
            where: { id: batch.id },
            data: { sealed: true, sealedAt: new Date() },
          });

          logger.debug("[BatchTriggerV2][processBatchTaskRun] Batch processing complete", {
            batchId: batch.friendlyId,
            currentIndex: result.workingIndex,
            attemptCount: $attemptCount,
          });
        }
      }
    }
  }

  async #processBatchTaskRunItems(
    batch: BatchTaskRun,
    environment: AuthenticatedEnvironment,
    currentIndex: number,
    batchSize: number,
    items: BatchTriggerTaskV2RequestBody["items"],
    options?: BatchTriggerTaskServiceOptions
  ): Promise<{ workingIndex: number; error?: Error }> {
    // Grab the next PROCESSING_BATCH_SIZE runIds
    const runIds = batch.runIds.slice(currentIndex, currentIndex + batchSize);

    logger.debug("[BatchTriggerV2][processBatchTaskRun] Processing batch items", {
      batchId: batch.friendlyId,
      currentIndex,
      runIds,
      runCount: batch.runCount,
    });

    // Combine the "window" between currentIndex and currentIndex + PROCESSING_BATCH_SIZE with the runId and the item in the payload which is an array
    const itemsToProcess = runIds.map((runId, index) => ({
      runId,
      item: items[index + currentIndex],
    }));

    let workingIndex = currentIndex;
    let expectedCount = 0;

    for (const item of itemsToProcess) {
      try {
        const created = await this.#processBatchTaskRunItem(
          batch,
          environment,
          item,
          workingIndex,
          options
        );

        if (created) {
          expectedCount++;
        }

        workingIndex++;
      } catch (error) {
        logger.error("[BatchTriggerV2][processBatchTaskRun] Failed to process item", {
          batchId: batch.friendlyId,
          currentIndex: workingIndex,
          error,
        });

        return {
          error: error instanceof Error ? error : new Error(String(error)),
          workingIndex,
        };
      }
    }

    if (expectedCount > 0) {
      await this._prisma.batchTaskRun.update({
        where: { id: batch.id },
        data: {
          expectedCount: {
            increment: expectedCount,
          },
        },
      });
    }

    return { workingIndex };
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

    const triggerTaskService = new TriggerTaskService();

    const result = await triggerTaskService.call(
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
        batchId: batch.id,
        skipChecks: true,
        runFriendlyId: task.runId,
        realtimeStreamsVersion: options?.realtimeStreamsVersion,
      }
    );

    if (!result) {
      throw new Error(`Failed to trigger run ${task.runId} for batch ${batch.friendlyId}`);
    }

    if (!result.isCached) {
      try {
        await this._prisma.batchTaskRunItem.create({
          data: {
            batchTaskRunId: batch.id,
            taskRunId: result.run.id,
            status: batchTaskRunItemStatusForRunStatus(result.run.status),
          },
        });

        return true;
      } catch (error) {
        if (isUniqueConstraintError(error, ["batchTaskRunId", "taskRunId"])) {
          // This means there is already a batchTaskRunItem for this batch and taskRun
          logger.debug(
            "[BatchTriggerV2][processBatchTaskRunItem] BatchTaskRunItem already exists",
            {
              batchId: batch.friendlyId,
              runId: task.runId,
              currentIndex,
            }
          );

          return false;
        }

        throw error;
      }
    }

    return false;
  }

  async #enqueueBatchTaskRun(options: BatchProcessingOptions) {
    await batchTriggerWorker.enqueue({
      id: `BatchTriggerV2Service.process:${options.batchId}:${options.processingId}`,
      job: "v3.processBatchTaskRun",
      payload: options,
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
}

export async function completeBatchTaskRunItemV3(
  itemId: string,
  batchTaskRunId: string,
  tx: PrismaClientOrTransaction,
  scheduleResumeOnComplete = false,
  taskRunAttemptId?: string,
  retryAttempt?: number
) {
  const isRetry = retryAttempt !== undefined;

  logger.debug("completeBatchTaskRunItemV3", {
    itemId,
    batchTaskRunId,
    scheduleResumeOnComplete,
    taskRunAttemptId,
    retryAttempt,
    isRetry,
  });

  if (isRetry) {
    logger.debug("completeBatchTaskRunItemV3 retrying", {
      itemId,
      batchTaskRunId,
      scheduleResumeOnComplete,
      taskRunAttemptId,
      retryAttempt,
    });
  }

  try {
    await $transaction(
      tx,
      "completeBatchTaskRunItemV3",
      async (tx, span) => {
        span?.setAttribute("batch_id", batchTaskRunId);

        // Update the item to complete
        const updated = await tx.batchTaskRunItem.updateMany({
          where: {
            id: itemId,
            status: "PENDING",
          },
          data: {
            status: "COMPLETED",
            taskRunAttemptId,
          },
        });

        if (updated.count === 0) {
          return;
        }

        const updatedBatchRun = await tx.batchTaskRun.update({
          where: {
            id: batchTaskRunId,
          },
          data: {
            completedCount: {
              increment: 1,
            },
          },
          select: {
            sealed: true,
            status: true,
            completedCount: true,
            expectedCount: true,
            dependentTaskAttemptId: true,
          },
        });

        if (
          updatedBatchRun.status === "PENDING" &&
          updatedBatchRun.completedCount === updatedBatchRun.expectedCount &&
          updatedBatchRun.sealed
        ) {
          await tx.batchTaskRun.update({
            where: {
              id: batchTaskRunId,
            },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
            },
          });

          // We only need to resume the batch if it has a dependent task attempt ID
          if (scheduleResumeOnComplete && updatedBatchRun.dependentTaskAttemptId) {
            await ResumeBatchRunService.enqueue(batchTaskRunId, true, tx);
          }
        }
      },
      {
        timeout: 10_000,
        maxWait: 4_000,
      }
    );
  } catch (error) {
    if (isPrismaRetriableError(error) || isPrismaRaceConditionError(error)) {
      logger.error("completeBatchTaskRunItemV3 failed with a Prisma Error, scheduling a retry", {
        itemId,
        batchTaskRunId,
        error,
        retryAttempt,
        isRetry,
      });

      if (isRetry) {
        //throwing this error will cause the Redis worker to retry the job
        throw error;
      } else {
        //schedule a retry
        await legacyRunEngineWorker.enqueue({
          id: `completeBatchTaskRunItem:${itemId}`,
          job: "completeBatchTaskRunItem",
          payload: {
            itemId,
            batchTaskRunId,
            scheduleResumeOnComplete,
            taskRunAttemptId,
          },
          availableAt: new Date(Date.now() + 2_000),
        });
      }
    } else {
      logger.error("completeBatchTaskRunItemV3 failed with a non-retriable error", {
        itemId,
        batchTaskRunId,
        error,
        retryAttempt,
        isRetry,
      });
    }
  }
}
