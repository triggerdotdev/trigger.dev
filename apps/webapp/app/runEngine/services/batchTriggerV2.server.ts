import {
  type BatchTriggerTaskV3RequestBody,
  type BatchTriggerTaskV3Response,
} from "@trigger.dev/core/v3";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { type BatchTaskRun, Prisma } from "@trigger.dev/database";
import { type BatchItem, type EnqueueBatchOptions } from "@internal/run-engine";
import { Evt } from "evt";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { DefaultQueueManager } from "../concerns/queues.server";
import { DefaultTriggerTaskValidator } from "../validators/triggerTaskValidator";
import { ServiceValidationError, WithRunEngine } from "../../v3/services/baseService.server";

export type BatchTriggerTaskServiceOptions = {
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined | Record<string, string | undefined>>;
  spanParentAsLink?: boolean;
  oneTimeUseToken?: string;
  realtimeStreamsVersion?: "v1" | "v2";
  idempotencyKey?: string;
};

/**
 * Run Engine v2 Batch Trigger Service using Redis-based BatchQueue with DRR scheduling.
 *
 * This service:
 * 1. Creates BatchTaskRun in Postgres with status=PROCESSING
 * 2. Enqueues all items to BatchQueue (via RunEngine)
 * 3. For batchTriggerAndWait: blocks the parent run immediately
 * 4. Returns immediately - BatchQueue consumers handle run creation
 *
 * The BatchQueue uses Deficit Round Robin scheduling to ensure fair processing
 * across environments, preventing any single environment from monopolizing workers.
 *
 * NOTE: BatchQueue callbacks are set up in the RunEngine initialization (runEngine.server.ts),
 * not in this service.
 */
export class RunEngineBatchTriggerServiceV2 extends WithRunEngine {
  public onBatchTaskRunCreated: Evt<BatchTaskRun> = new Evt();
  private readonly queueConcern: DefaultQueueManager;
  private readonly validator: DefaultTriggerTaskValidator;

  constructor(protected readonly _prisma: PrismaClientOrTransaction = prisma) {
    super({ prisma });

    this.queueConcern = new DefaultQueueManager(this._prisma, this._engine);
    this.validator = new DefaultTriggerTaskValidator();
  }

  /**
   * Trigger a batch of tasks.
   */
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

          // Validate entitlement
          const entitlementValidation = await this.validator.validateEntitlement({
            environment,
          });

          if (!entitlementValidation.ok) {
            throw entitlementValidation.error;
          }

          const planType = entitlementValidation.plan?.type;

          // Validate queue limits for the total batch size
          const queueSizeGuard = await this.queueConcern.validateQueueLimits(
            environment,
            body.items.length
          );

          if (!queueSizeGuard.ok) {
            throw new ServiceValidationError(
              `Cannot trigger ${body.items.length} tasks as the queue size limit for this environment has been reached. The maximum size is ${queueSizeGuard.maximumSize}`
            );
          }

          // Create BatchTaskRun in Postgres with PROCESSING status
          const batch = await this._prisma.batchTaskRun.create({
            data: {
              id,
              friendlyId,
              runtimeEnvironmentId: environment.id,
              status: "PROCESSING",
              runCount: body.items.length,
              runIds: [],
              batchVersion: "runengine:v2",
              oneTimeUseToken: options.oneTimeUseToken,
              idempotencyKey: options.idempotencyKey,
              processingStartedAt: new Date(),
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

          // Convert body items to BatchItem format
          const batchItems: BatchItem[] = body.items.map((item) => ({
            task: item.task,
            payload: item.payload,
            payloadType: item.options?.payloadType ?? "application/json",
            options: item.options as Record<string, unknown> | undefined,
          }));

          // Enqueue to BatchQueue (Redis)
          const enqueueOptions: EnqueueBatchOptions = {
            batchId: id,
            friendlyId,
            environmentId: environment.id,
            environmentType: environment.type,
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            items: batchItems,
            parentRunId: body.parentRunId,
            resumeParentOnCompletion: body.resumeParentOnCompletion,
            triggerVersion: options.triggerVersion,
            traceContext: options.traceContext as Record<string, unknown> | undefined,
            spanParentAsLink: options.spanParentAsLink,
            realtimeStreamsVersion: options.realtimeStreamsVersion,
            idempotencyKey: options.idempotencyKey,
            planType,
          };

          await this._engine.enqueueBatchToQueue(enqueueOptions);

          logger.debug("Batch enqueued to BatchQueue", {
            batchId: friendlyId,
            itemCount: body.items.length,
            envId: environment.id,
          });

          return {
            id: friendlyId,
            isCached: false,
            idempotencyKey: options.idempotencyKey,
            runCount: body.items.length,
          };
        }
      );
    } catch (error) {
      // Handle Prisma unique constraint violations
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.debug("RunEngineBatchTriggerV2: Prisma error", {
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
}
