import type { InitializeBatchOptions } from "@internal/run-engine";
import { type CreateBatchRequestBody, type CreateBatchResponse } from "@trigger.dev/core/v3";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { type BatchTaskRun, Prisma } from "@trigger.dev/database";
import { Evt } from "evt";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError, WithRunEngine } from "../../v3/services/baseService.server";
import { BatchRateLimitExceededError, getBatchLimits } from "../concerns/batchLimits.server";
import { DefaultQueueManager } from "../concerns/queues.server";
import { DefaultTriggerTaskValidator } from "../validators/triggerTaskValidator";

export type CreateBatchServiceOptions = {
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined | Record<string, string | undefined>>;
  spanParentAsLink?: boolean;
  oneTimeUseToken?: string;
  realtimeStreamsVersion?: "v1" | "v2";
};

/**
 * Create Batch Service (Phase 1 of 2-phase batch API).
 *
 * This service handles Phase 1 of the streaming batch API:
 * 1. Validates entitlement and queue limits
 * 2. Creates BatchTaskRun in Postgres with status=PENDING, expectedCount set
 * 3. For batchTriggerAndWait: blocks the parent run immediately
 * 4. Initializes batch metadata in Redis
 * 5. Returns batch ID - items are streamed separately via Phase 2
 *
 * The batch is NOT sealed until Phase 2 completes.
 */
export class CreateBatchService extends WithRunEngine {
  public onBatchTaskRunCreated: Evt<BatchTaskRun> = new Evt();
  private readonly queueConcern: DefaultQueueManager;
  private readonly validator: DefaultTriggerTaskValidator;

  constructor(protected readonly _prisma: PrismaClientOrTransaction = prisma) {
    super({ prisma: _prisma });

    this.queueConcern = new DefaultQueueManager(this._prisma, this._engine);
    this.validator = new DefaultTriggerTaskValidator();
  }

  /**
   * Create a batch for 2-phase processing.
   * Items will be streamed separately via the StreamBatchItemsService.
   */
  public async call(
    environment: AuthenticatedEnvironment,
    body: CreateBatchRequestBody,
    options: CreateBatchServiceOptions = {}
  ): Promise<CreateBatchResponse> {
    try {
      return await this.traceWithEnv<CreateBatchResponse>(
        "createBatch()",
        environment,
        async (span) => {
          const { id, friendlyId } = BatchId.generate();

          span.setAttribute("batchId", friendlyId);
          span.setAttribute("runCount", body.runCount);

          // Validate entitlement
          const entitlementValidation = await this.validator.validateEntitlement({
            environment,
          });

          if (!entitlementValidation.ok) {
            throw entitlementValidation.error;
          }

          // Extract plan type from entitlement validation for billing tracking
          const planType = entitlementValidation.plan?.type;

          // Get batch limits for this organization
          const { config, rateLimiter } = await getBatchLimits(environment.organization);

          // Check rate limit BEFORE creating the batch
          // This prevents burst creation of batches that exceed the rate limit
          const rateResult = await rateLimiter.limit(environment.id, body.runCount);

          if (!rateResult.success) {
            throw new BatchRateLimitExceededError(
              rateResult.limit,
              rateResult.remaining,
              new Date(rateResult.reset),
              body.runCount
            );
          }

          // Validate queue limits for the expected batch size
          const queueSizeGuard = await this.queueConcern.validateQueueLimits(
            environment,
            body.runCount
          );

          if (!queueSizeGuard.ok) {
            throw new ServiceValidationError(
              `Cannot create batch with ${body.runCount} items as the queue size limit for this environment has been reached. The maximum size is ${queueSizeGuard.maximumSize}`
            );
          }

          // Create BatchTaskRun in Postgres with PENDING status
          // The batch will be sealed (status -> PROCESSING) when items are streamed
          const batch = await this._prisma.batchTaskRun.create({
            data: {
              id,
              friendlyId,
              runtimeEnvironmentId: environment.id,
              status: "PENDING",
              runCount: body.runCount,
              expectedCount: body.runCount,
              runIds: [],
              batchVersion: "runengine:v2", // 2-phase streaming batch API
              oneTimeUseToken: options.oneTimeUseToken,
              idempotencyKey: body.idempotencyKey,
              // Not sealed yet - will be sealed when items stream completes
              sealed: false,
            },
          });

          this.onBatchTaskRunCreated.post(batch);

          // Block parent run if this is a batchTriggerAndWait
          if (body.parentRunId && body.resumeParentOnCompletion) {
            await this._engine.blockRunWithCreatedBatch({
              runId: RunId.fromFriendlyId(body.parentRunId),
              batchId: batch.id,
              environmentId: environment.id,
              projectId: environment.projectId,
              organizationId: environment.organizationId,
            });
          }

          // Initialize batch metadata in Redis (without items)
          const initOptions: InitializeBatchOptions = {
            batchId: id,
            friendlyId,
            environmentId: environment.id,
            environmentType: environment.type,
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            runCount: body.runCount,
            parentRunId: body.parentRunId,
            resumeParentOnCompletion: body.resumeParentOnCompletion,
            triggerVersion: options.triggerVersion,
            traceContext: options.traceContext as Record<string, unknown> | undefined,
            spanParentAsLink: options.spanParentAsLink,
            realtimeStreamsVersion: options.realtimeStreamsVersion,
            idempotencyKey: body.idempotencyKey,
            processingConcurrency: config.processingConcurrency,
            planType,
          };

          await this._engine.initializeBatch(initOptions);

          logger.info("Batch created", {
            batchId: friendlyId,
            runCount: body.runCount,
            envId: environment.id,
            projectId: environment.projectId,
            parentRunId: body.parentRunId,
            resumeParentOnCompletion: body.resumeParentOnCompletion,
            processingConcurrency: config.processingConcurrency,
          });

          return {
            id: friendlyId,
            runCount: body.runCount,
            isCached: false,
            idempotencyKey: body.idempotencyKey,
          };
        }
      );
    } catch (error) {
      // Handle Prisma unique constraint violations
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.debug("CreateBatchService: Prisma error", {
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
              "Cannot create batch with a one-time use token as it has already been used."
            );
          } else {
            throw new ServiceValidationError(
              "Cannot create batch as it has already been created with the same idempotency key."
            );
          }
        }
      }

      throw error;
    }
  }
}
