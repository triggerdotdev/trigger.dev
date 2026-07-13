import type {
  BatchTriggerTaskV2RequestBody,
  BatchTriggerTaskV2Response,
  IOPacket,
} from "@trigger.dev/core/v3";
import { packetRequiresOffloading, parsePacket } from "@trigger.dev/core/v3";
import type { BatchTaskRun, TaskRunAttempt } from "@trigger.dev/database";
import { isUniqueConstraintError, Prisma } from "@trigger.dev/database";
import type { RunStore } from "@internal/run-store";
import { z } from "zod";
import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { batchTaskRunItemStatusForRunStatus } from "~/models/taskRun.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { dependentAttemptWhere } from "./dependentAttemptScope";
import { logger } from "~/services/logger.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { resolveRunIdMintKind, type RunIdMintKind } from "~/v3/engineVersion.server";
import { resolveInheritedMintKind } from "~/v3/runOpsMigration/resolveInheritedMintKind.server";
import { mintFriendlyIdForKind } from "~/v3/runOpsMigration/mintAnchoredRunFriendlyId.server";
import { mintBatchFriendlyId } from "~/v3/runOpsMigration/mintBatchFriendlyId.server";
import { batchTriggerWorker } from "../batchTriggerWorker.server";
import { guardQueueSizeLimitsForEnv } from "../queueSizeLimits.server";
import { downloadPacketFromObjectStore, uploadPacketToObjectStore } from "../objectStore.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { startActiveSpan } from "../tracer.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
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
  triggerSource?: string;
  triggerAction?: string;
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
 * When the v3 batch is considered completed it is marked COMPLETED. (Dependent-attempt
 * batches from batchTriggerAndWait only existed on the retired V1 engine.)
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
    protected readonly _prisma: PrismaClientOrTransaction = prisma,
    protected readonly runStore: RunStore = defaultRunStore,
    // Injected so tests force the env-default branch deterministically; defaults
    // to the live per-env mint resolver.
    private readonly resolveMintKind: (environment: {
      organizationId: string;
      id: string;
      orgFeatureFlags?: unknown;
    }) => Promise<RunIdMintKind> = resolveRunIdMintKind
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

          // BatchTaskRun.runtimeEnvironmentId no longer has an FK into RuntimeEnvironment;
          // validate env existence app-side before any create arm (passthrough when split is off).
          await controlPlaneResolver.assertEnvExists(environment.id);

          const existingBatch = options.idempotencyKey
            ? await this.runStore.findBatchTaskRunByIdempotencyKey(
                environment.id,
                options.idempotencyKey
              )
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
              await this.runStore.updateBatchTaskRun({
                where: { id: existingBatch.id },
                data: { idempotencyKey: null },
                select: { id: true },
              });

              // Don't return, just continue with the batch trigger
            } else {
              span.setAttribute("batchId", existingBatch.friendlyId);

              return this.#respondWithExistingBatch(existingBatch, environment);
            }
          }

          const { id: batchInternalId, friendlyId: batchId } = await mintBatchFriendlyId({
            environment: {
              organizationId: environment.organizationId,
              id: environment.id,
              orgFeatureFlags: environment.organization.featureFlags,
            },
            parentRunFriendlyId: body.parentRunId,
          });

          span.setAttribute("batchId", batchId);

          const dependentAttempt = body?.dependentAttempt
            ? await this.runStore.findTaskRunAttempt({
                // Scope to the caller's environment (see dependentAttemptWhere).
                where: dependentAttemptWhere(body.dependentAttempt, environment.id),
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

          const runs = await this.#prepareRunData(environment, body, batchId);

          const newRunCount = runs.filter((r) => !r.isCached).length;

          if (newRunCount === 0) {
            logger.debug("[BatchTriggerV2][call] All runs are cached", {
              batchId,
            });

            await this.runStore.createBatchTaskRun({
              id: batchInternalId,
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
            });

            return {
              id: batchId,
              isCached: false,
              idempotencyKey: options.idempotencyKey ?? undefined,
              runs,
            };
          }

          const queueSizeGuard = await guardQueueSizeLimitsForEnv(environment, newRunCount);

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
              `Cannot trigger ${newRunCount} tasks as the queue size limit for this environment has been reached. The maximum size is ${queueSizeGuard.maximumSize}`,
              undefined,
              "warn"
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
            batchInternalId,
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

  // Mint a child run's friendlyId so it lands in the SAME physical store as its
  // residency anchor. The caller passes the batch's friendlyId, so a run-ops id
  // (NEW) anchor yields a run-ops id (NEW) child and a cuid anchor yields a cuid
  // (LEGACY) child. With no anchor it falls back to the env's cutover setting.
  // Mirrors RunEngineTriggerTaskService.mintRunFriendlyId.
  private async mintChildFriendlyId(
    environment: AuthenticatedEnvironment,
    anchorFriendlyId?: string,
    region?: string
  ): Promise<string> {
    const mintKind = anchorFriendlyId
      ? resolveInheritedMintKind(anchorFriendlyId)
      : await this.resolveMintKind({
          organizationId: environment.organizationId,
          id: environment.id,
          orgFeatureFlags: environment.organization.featureFlags,
        });

    return mintFriendlyIdForKind(mintKind, region);
  }

  async #prepareRunData(
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV2RequestBody,
    batchFriendlyId: string
  ): Promise<Array<RunItemData>> {
    // Anchor every child to the batch's residency: the batch friendlyId is
    // minted once, so deriving each child's id-kind from it — rather than re-resolving
    // the per-org flag, which can flip mid-batch — keeps batch + children co-resident.
    const childAnchor = batchFriendlyId;

    // batchTriggerAndWait cannot have cached runs because that does not work in run engine v1 and is not available in the client
    if (body?.dependentAttempt) {
      return Promise.all(
        body.items.map(async (item) => ({
          id: await this.mintChildFriendlyId(environment, childAnchor, item.options?.region),
          isCached: false,
          idempotencyKey: undefined,
          taskIdentifier: item.task,
        }))
      );
    }

    // Group items by taskIdentifier
    const itemsByTask = body.items.reduce(
      (acc, item) => {
        if (!item.options?.idempotencyKey) return acc;

        if (!acc[item.task]) {
          acc[item.task] = [];
        }
        acc[item.task].push(item);
        return acc;
      },
      {} as Record<string, typeof body.items>
    );

    logger.debug("[BatchTriggerV2][call] Grouped items by task identifier", {
      itemsByTask,
    });

    // Fetch cached runs for each task identifier separately to make use of the index
    const cachedRuns = await Promise.all(
      Object.entries(itemsByTask).map(([taskIdentifier, items]) =>
        this.runStore.findRuns(
          {
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
          },
          this._prisma
        )
      )
    ).then((results) => results.flat());

    // Build the run IDs in order: reuse an unexpired cached id, else mint a new id (and record any
    // expired cached id so its idempotency key can be cleared below).
    const expiredRunIds = new Set<string>();

    const runs = await Promise.all(
      body.items.map(async (item) => {
        const cachedRun = cachedRuns.find((r) => r.idempotencyKey === item.options?.idempotencyKey);

        if (cachedRun) {
          if (cachedRun.idempotencyKeyExpiresAt && cachedRun.idempotencyKeyExpiresAt < new Date()) {
            expiredRunIds.add(cachedRun.friendlyId);

            return {
              id: await this.mintChildFriendlyId(environment, childAnchor, item.options?.region),
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
          id: await this.mintChildFriendlyId(environment, childAnchor, item.options?.region),
          isCached: false,
          idempotencyKey: item.options?.idempotencyKey ?? undefined,
          taskIdentifier: item.task,
        };
      })
    );

    // Expire the cached runs that are no longer valid
    if (expiredRunIds.size) {
      await this.runStore.clearIdempotencyKey(
        { byFriendlyIds: Array.from(expiredRunIds) },
        this._prisma
      );
    }

    return runs;
  }

  async #createAndProcessBatchTaskRun(
    batchId: string,
    batchInternalId: string,
    runs: Array<RunItemData>,
    payloadPacket: IOPacket,
    newRunCount: number,
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskV2RequestBody,
    options: BatchTriggerTaskServiceOptions = {},
    dependentAttempt?: TaskRunAttempt
  ) {
    if (runs.length <= this._asyncBatchProcessSizeThreshold) {
      const batch = await this.runStore.createBatchTaskRun({
        id: batchInternalId,
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

        await this.runStore.updateBatchTaskRun({
          where: { id: batch.id },
          data: {
            status: "ABORTED",
            completedAt: new Date(),
          },
          select: { id: true },
        });

        throw result.error;
      }

      await this.runStore.updateBatchTaskRun({
        where: { id: batch.id },
        data: { sealed: true, sealedAt: new Date() },
        select: { id: true },
      });

      return batch;
    } else {
      const batch = await this.runStore.createBatchTaskRun({
        id: batchInternalId,
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

          await this.runStore.updateBatchTaskRun({
            where: { id: batch.id },
            data: {
              processingJobsExpectedCount: ranges.length,
            },
            select: { id: true },
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

    if ($attemptCount > MAX_ATTEMPTS) {
      logger.error("[BatchTriggerV2][processBatchTaskRun] Max attempts reached", {
        options,
        attemptCount: $attemptCount,
      });
      return;
    }

    const batch = await this.runStore.findBatchTaskRunById(options.batchId);

    if (!batch) {
      return;
    }

    // BatchTaskRun -> RuntimeEnvironment FK is dropped; resolve the env from the scalar id.
    const environment = await findEnvironmentById(batch.runtimeEnvironmentId);
    if (!environment) {
      logger.error("[BatchTriggerV2][processBatchTaskRun] Environment not found", {
        batchId: batch.id,
        runtimeEnvironmentId: batch.runtimeEnvironmentId,
      });
      return;
    }

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
      environment
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
      environment,
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
        // Done once we've walked past the last item in the batch
        if (result.workingIndex >= batch.runCount) {
          await this.runStore.updateBatchTaskRun({
            where: { id: batch.id },
            data: { sealed: true, sealedAt: new Date() },
            select: { id: true },
          });

          logger.debug("[BatchTriggerV2][processBatchTaskRun] Batch processing complete", {
            batchId: batch.friendlyId,
            runCount: batch.runCount,
            currentIndex: result.workingIndex,
            attemptCount: $attemptCount,
          });
        } else {
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
        // Each processing job increments the count; the last one to arrive seals the batch
        const { processingJobsCount, processingJobsExpectedCount } =
          await this.runStore.updateBatchTaskRun({
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
          await this.runStore.updateBatchTaskRun({
            where: { id: batch.id },
            data: { sealed: true, sealedAt: new Date() },
            select: { id: true },
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
    const runIds = batch.runIds.slice(currentIndex, currentIndex + batchSize);

    logger.debug("[BatchTriggerV2][processBatchTaskRun] Processing batch items", {
      batchId: batch.friendlyId,
      currentIndex,
      runIds,
      runCount: batch.runCount,
    });

    // Pair each runId in this window with its item from the payload array
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
      await this.runStore.updateBatchTaskRun({
        where: { id: batch.id },
        data: {
          expectedCount: {
            increment: expectedCount,
          },
        },
        select: { id: true },
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
        triggerSource: options?.triggerSource ?? "api",
        triggerAction: options?.triggerAction ?? "trigger",
      }
    );

    if (!result) {
      throw new Error(`Failed to trigger run ${task.runId} for batch ${batch.friendlyId}`);
    }

    if (!result.isCached) {
      try {
        await this.runStore.createBatchTaskRunItem({
          batchTaskRunId: batch.id,
          taskRunId: result.run.id,
          status: batchTaskRunItemStatusForRunStatus(result.run.status),
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

      const uploadedFilename = await uploadPacketToObjectStore(
        filename,
        packet.data,
        packet.dataType,
        environment
      );

      return {
        data: uploadedFilename,
        dataType: "application/store",
      };
    });
  }
}

export async function tryCompleteBatchV3(
  batchId: string,
  tx: PrismaClientOrTransaction,
  scheduleResumeOnComplete: boolean,
  // Threaded in so a run-ops id (NEW-resident) batch + its items are read/written on the owning
  // store, not the control-plane `tx`. Defaults to the singleton (single-DB = passthrough).
  runStore: RunStore = defaultRunStore
) {
  const batch = await runStore.findBatchTaskRunById(batchId);

  if (!batch) {
    logger.debug("tryCompleteBatchV3: Batch not found", { batchId });
    return;
  }

  if (batch.status === "COMPLETED") {
    logger.debug("tryCompleteBatchV3: Already completed", { batchId });
    return;
  }

  if (!batch.sealed) {
    logger.debug("tryCompleteBatchV3: Not sealed yet", { batchId });
    return;
  }

  const completedCount = await runStore.countBatchTaskRunItems({
    batchTaskRunId: batchId,
    status: "COMPLETED",
  });

  if (completedCount < batch.expectedCount) {
    logger.debug("tryCompleteBatchV3: Not all items completed", {
      batchId,
      completedCount,
      expectedCount: batch.expectedCount,
    });
    return;
  }

  // Mark batch COMPLETED (idempotent via status check)
  const updated = await runStore.updateManyBatchTaskRun({
    where: { id: batchId, status: "PENDING" },
    data: { status: "COMPLETED", completedAt: new Date(), completedCount },
  });

  if (updated.count === 0) {
    logger.debug("tryCompleteBatchV3: Already transitioned", { batchId });
    return;
  }

  logger.debug("tryCompleteBatchV3: Batch completed", { batchId, completedCount });

  // Dependent-attempt batches (batchTriggerAndWait) only exist on the retired V1 engine, so there is no parent to resume here.
}
