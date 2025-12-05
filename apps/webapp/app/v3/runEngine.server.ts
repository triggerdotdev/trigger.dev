import { RunEngine, type CompleteBatchResult } from "@internal/run-engine";
import { BatchTaskRunStatus, Prisma } from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { defaultMachine, getCurrentPlan } from "~/services/platform.v3.server";
import { singleton } from "~/utils/singleton";
import { allMachines } from "./machinePresets.server";
import { meter, tracer } from "./tracer.server";
import { logger } from "~/services/logger.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { TriggerTaskService } from "./services/triggerTask.server";

export const engine = singleton("RunEngine", createRunEngine);

export type { RunEngine };

function createRunEngine() {
  const engine = new RunEngine({
    prisma,
    readOnlyPrisma: $replica,
    logLevel: env.RUN_ENGINE_WORKER_LOG_LEVEL,
    treatProductionExecutionStallsAsOOM:
      env.RUN_ENGINE_TREAT_PRODUCTION_EXECUTION_STALLS_AS_OOM === "1",
    worker: {
      disabled: env.RUN_ENGINE_WORKER_ENABLED === "0",
      workers: env.RUN_ENGINE_WORKER_COUNT,
      tasksPerWorker: env.RUN_ENGINE_TASKS_PER_WORKER,
      pollIntervalMs: env.RUN_ENGINE_WORKER_POLL_INTERVAL,
      immediatePollIntervalMs: env.RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL,
      limit: env.RUN_ENGINE_WORKER_CONCURRENCY_LIMIT,
      shutdownTimeoutMs: env.RUN_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS,
      redis: {
        keyPrefix: "engine:",
        port: env.RUN_ENGINE_WORKER_REDIS_PORT ?? undefined,
        host: env.RUN_ENGINE_WORKER_REDIS_HOST ?? undefined,
        username: env.RUN_ENGINE_WORKER_REDIS_USERNAME ?? undefined,
        password: env.RUN_ENGINE_WORKER_REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.RUN_ENGINE_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
    },
    machines: {
      defaultMachine,
      machines: allMachines(),
      baseCostInCents: env.CENTS_PER_RUN,
    },
    queue: {
      defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
      defaultEnvConcurrencyBurstFactor: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_BURST_FACTOR,
      logLevel: env.RUN_ENGINE_RUN_QUEUE_LOG_LEVEL,
      redis: {
        keyPrefix: "engine:",
        port: env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? undefined,
        host: env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? undefined,
        username: env.RUN_ENGINE_RUN_QUEUE_REDIS_USERNAME ?? undefined,
        password: env.RUN_ENGINE_RUN_QUEUE_REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.RUN_ENGINE_RUN_QUEUE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
      queueSelectionStrategyOptions: {
        parentQueueLimit: env.RUN_ENGINE_PARENT_QUEUE_LIMIT,
        biases: {
          concurrencyLimitBias: env.RUN_ENGINE_CONCURRENCY_LIMIT_BIAS,
          availableCapacityBias: env.RUN_ENGINE_AVAILABLE_CAPACITY_BIAS,
          queueAgeRandomization: env.RUN_ENGINE_QUEUE_AGE_RANDOMIZATION_BIAS,
        },
        reuseSnapshotCount: env.RUN_ENGINE_REUSE_SNAPSHOT_COUNT,
        maximumEnvCount: env.RUN_ENGINE_MAXIMUM_ENV_COUNT,
        tracer,
      },
      shardCount: env.RUN_ENGINE_RUN_QUEUE_SHARD_COUNT,
      processWorkerQueueDebounceMs: env.RUN_ENGINE_PROCESS_WORKER_QUEUE_DEBOUNCE_MS,
      dequeueBlockingTimeoutSeconds: env.RUN_ENGINE_DEQUEUE_BLOCKING_TIMEOUT_SECONDS,
      masterQueueConsumersIntervalMs: env.RUN_ENGINE_MASTER_QUEUE_CONSUMERS_INTERVAL_MS,
      masterQueueConsumersDisabled: env.RUN_ENGINE_WORKER_ENABLED === "0",
      masterQueueCooloffPeriodMs: env.RUN_ENGINE_MASTER_QUEUE_COOLOFF_PERIOD_MS,
      masterQueueCooloffCountThreshold: env.RUN_ENGINE_MASTER_QUEUE_COOLOFF_COUNT_THRESHOLD,
      masterQueueConsumerDequeueCount: env.RUN_ENGINE_MASTER_QUEUE_CONSUMER_DEQUEUE_COUNT,
      concurrencySweeper: {
        scanSchedule: env.RUN_ENGINE_CONCURRENCY_SWEEPER_SCAN_SCHEDULE,
        processMarkedSchedule: env.RUN_ENGINE_CONCURRENCY_SWEEPER_PROCESS_MARKED_SCHEDULE,
        scanJitterInMs: env.RUN_ENGINE_CONCURRENCY_SWEEPER_SCAN_JITTER_IN_MS,
        processMarkedJitterInMs: env.RUN_ENGINE_CONCURRENCY_SWEEPER_PROCESS_MARKED_JITTER_IN_MS,
      },
    },
    runLock: {
      redis: {
        keyPrefix: "engine:",
        port: env.RUN_ENGINE_RUN_LOCK_REDIS_PORT ?? undefined,
        host: env.RUN_ENGINE_RUN_LOCK_REDIS_HOST ?? undefined,
        username: env.RUN_ENGINE_RUN_LOCK_REDIS_USERNAME ?? undefined,
        password: env.RUN_ENGINE_RUN_LOCK_REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.RUN_ENGINE_RUN_LOCK_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
      duration: env.RUN_ENGINE_RUN_LOCK_DURATION,
      automaticExtensionThreshold: env.RUN_ENGINE_RUN_LOCK_AUTOMATIC_EXTENSION_THRESHOLD,
      retryConfig: {
        maxAttempts: env.RUN_ENGINE_RUN_LOCK_MAX_RETRIES,
        baseDelay: env.RUN_ENGINE_RUN_LOCK_BASE_DELAY,
        maxDelay: env.RUN_ENGINE_RUN_LOCK_MAX_DELAY,
        backoffMultiplier: env.RUN_ENGINE_RUN_LOCK_BACKOFF_MULTIPLIER,
        jitterFactor: env.RUN_ENGINE_RUN_LOCK_JITTER_FACTOR,
        maxTotalWaitTime: env.RUN_ENGINE_RUN_LOCK_MAX_TOTAL_WAIT_TIME,
      },
    },
    tracer,
    meter,
    heartbeatTimeoutsMs: {
      PENDING_EXECUTING: env.RUN_ENGINE_TIMEOUT_PENDING_EXECUTING,
      PENDING_CANCEL: env.RUN_ENGINE_TIMEOUT_PENDING_CANCEL,
      EXECUTING: env.RUN_ENGINE_TIMEOUT_EXECUTING,
      EXECUTING_WITH_WAITPOINTS: env.RUN_ENGINE_TIMEOUT_EXECUTING_WITH_WAITPOINTS,
      SUSPENDED: env.RUN_ENGINE_TIMEOUT_SUSPENDED,
    },
    suspendedHeartbeatRetriesConfig: {
      maxCount: env.RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_MAX_COUNT,
      maxDelayMs: env.RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_MAX_DELAY_MS,
      initialDelayMs: env.RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_INITIAL_DELAY_MS,
      factor: env.RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_FACTOR,
    },
    retryWarmStartThresholdMs: env.RUN_ENGINE_RETRY_WARM_START_THRESHOLD_MS,
    billing: {
      getCurrentPlan: async (orgId: string) => {
        const plan = await getCurrentPlan(orgId);

        // This only happens when there's no billing service running or on errors
        if (!plan) {
          logger.warn("engine.getCurrentPlan: no plan", { orgId });
          return {
            isPaying: true,
            type: "paid", // default to paid
          };
        }

        // This shouldn't happen
        if (!plan.v3Subscription) {
          logger.warn("engine.getCurrentPlan: no v3 subscription", { orgId });
          return {
            isPaying: false,
            type: "free",
          };
        }

        // Neither should this
        if (!plan.v3Subscription.plan) {
          logger.warn("engine.getCurrentPlan: no v3 subscription plan", { orgId });
          return {
            isPaying: plan.v3Subscription.isPaying,
            type: plan.v3Subscription.isPaying ? "paid" : "free",
          };
        }

        // This is the normal case when the billing service is running
        return {
          isPaying: plan.v3Subscription.isPaying,
          type: plan.v3Subscription.plan.type,
        };
      },
    },
    // BatchQueue with DRR scheduling for fair batch processing
    // Consumers are controlled by options.worker.disabled (same as main worker)
    batchQueue: env.BATCH_TRIGGER_WORKER_ENABLED === "true" ? {
      redis: {
        keyPrefix: "engine:",
        port: env.BATCH_TRIGGER_WORKER_REDIS_PORT ?? undefined,
        host: env.BATCH_TRIGGER_WORKER_REDIS_HOST ?? undefined,
        username: env.BATCH_TRIGGER_WORKER_REDIS_USERNAME ?? undefined,
        password: env.BATCH_TRIGGER_WORKER_REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.BATCH_TRIGGER_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
      drr: {
        quantum: env.BATCH_QUEUE_DRR_QUANTUM,
        maxDeficit: env.BATCH_QUEUE_MAX_DEFICIT,
      },
      consumerCount: env.BATCH_QUEUE_CONSUMER_COUNT,
      consumerIntervalMs: env.BATCH_QUEUE_CONSUMER_INTERVAL_MS,
    } : undefined,
  });

  // Set up BatchQueue callbacks if enabled
  if (engine.isBatchQueueEnabled()) {
    setupBatchQueueCallbacks(engine);
  }

  return engine;
}

/**
 * Set up the BatchQueue processing callbacks.
 * These handle creating runs from batch items and completing batches.
 */
function setupBatchQueueCallbacks(engine: RunEngine) {
  // Item processing callback - creates a run for each batch item
  engine.setBatchProcessItemCallback(async ({ batchId, friendlyId, itemIndex, item, meta }) => {
    try {
      const triggerTaskService = new TriggerTaskService();

      const result = await triggerTaskService.call(
        item.task,
        {
          id: meta.environmentId,
          type: meta.environmentType,
          organizationId: meta.organizationId,
          projectId: meta.projectId,
          organization: { id: meta.organizationId },
          project: { id: meta.projectId },
        } as AuthenticatedEnvironment,
        {
          payload: item.payload,
          options: {
            ...(item.options as Record<string, unknown>),
            payloadType: item.payloadType,
            parentRunId: meta.parentRunId,
            resumeParentOnCompletion: meta.resumeParentOnCompletion,
            parentBatch: batchId,
          },
        },
        {
          triggerVersion: meta.triggerVersion,
          traceContext: meta.traceContext as Record<string, unknown> | undefined,
          spanParentAsLink: meta.spanParentAsLink,
          batchId,
          batchIndex: itemIndex,
          skipChecks: true, // Already validated at batch level
          planType: meta.planType,
          realtimeStreamsVersion: meta.realtimeStreamsVersion,
        },
        "V2"
      );

      if (result) {
        return { success: true as const, runId: result.run.friendlyId };
      } else {
        return {
          success: false as const,
          error: "TriggerTaskService returned undefined",
          errorCode: "TRIGGER_FAILED",
        };
      }
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "TRIGGER_ERROR",
      };
    }
  });

  // Batch completion callback - updates Postgres with results
  engine.setBatchCompletionCallback(async (result: CompleteBatchResult) => {
    const { batchId, runIds, successfulRunCount, failedRunCount, failures } = result;

    // Determine final status
    let status: BatchTaskRunStatus;
    if (failedRunCount > 0 && successfulRunCount === 0) {
      status = "ABORTED";
    } else if (failedRunCount > 0) {
      status = "PARTIAL_FAILED";
    } else {
      status = "PENDING"; // All runs created, waiting for completion
    }

    try {
      // Update BatchTaskRun
      await prisma.batchTaskRun.update({
        where: { id: batchId },
        data: {
          status,
          runIds,
          successfulRunCount,
          failedRunCount,
          completedAt: status === "ABORTED" ? new Date() : undefined,
        },
      });

      // Create error records if there were failures
      if (failures.length > 0) {
        for (const failure of failures) {
          await prisma.batchTaskRunError.create({
            data: {
              batchTaskRunId: batchId,
              index: failure.index,
              taskIdentifier: failure.taskIdentifier,
              payload: failure.payload,
              options: failure.options as Prisma.InputJsonValue | undefined,
              error: failure.error,
              errorCode: failure.errorCode,
            },
          });
        }
      }

      // Try to complete the batch (handles waitpoint completion if all runs are done)
      if (status !== "ABORTED") {
        await engine.tryCompleteBatch({ batchId });
      }

      logger.info("Batch completion handled", {
        batchId,
        status,
        successfulRunCount,
        failedRunCount,
      });
    } catch (error) {
      logger.error("Failed to handle batch completion", {
        batchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  logger.info("BatchQueue callbacks configured");
}
