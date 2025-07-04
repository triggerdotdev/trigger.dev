import { Logger } from "@trigger.dev/core/logger";
import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { z } from "zod";
import { env } from "~/env.server";
import { RunEngineBatchTriggerService } from "~/runEngine/services/batchTrigger.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { BatchTriggerV3Service } from "./services/batchTriggerV3.server";

function initializeWorker() {
  const redisOptions = {
    keyPrefix: "batch-trigger:worker:",
    host: env.BATCH_TRIGGER_WORKER_REDIS_HOST,
    port: env.BATCH_TRIGGER_WORKER_REDIS_PORT,
    username: env.BATCH_TRIGGER_WORKER_REDIS_USERNAME,
    password: env.BATCH_TRIGGER_WORKER_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.BATCH_TRIGGER_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  logger.debug(
    `👨‍🏭 Initializing batch trigger worker at host ${env.BATCH_TRIGGER_WORKER_REDIS_HOST}`
  );

  const worker = new RedisWorker({
    name: "batch-trigger-worker",
    redisOptions,
    catalog: {
      "v3.processBatchTaskRun": {
        schema: z.object({
          batchId: z.string(),
          processingId: z.string(),
          range: z.object({ start: z.number().int(), count: z.number().int() }),
          attemptCount: z.number().int(),
          strategy: z.enum(["sequential", "parallel"]),
        }),
        visibilityTimeoutMs: env.BATCH_TRIGGER_PROCESS_JOB_VISIBILITY_TIMEOUT_MS,
        retry: {
          maxAttempts: 5,
        },
      },
      "runengine.processBatchTaskRun": {
        schema: z.object({
          batchId: z.string(),
          processingId: z.string(),
          range: z.object({ start: z.number().int(), count: z.number().int() }),
          attemptCount: z.number().int(),
          strategy: z.enum(["sequential", "parallel"]),
          parentRunId: z.string().optional(),
          resumeParentOnCompletion: z.boolean().optional(),
        }),
        visibilityTimeoutMs: env.BATCH_TRIGGER_PROCESS_JOB_VISIBILITY_TIMEOUT_MS,
        retry: {
          maxAttempts: 5,
        },
      },
    },
    concurrency: {
      workers: env.BATCH_TRIGGER_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.BATCH_TRIGGER_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.BATCH_TRIGGER_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.BATCH_TRIGGER_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.BATCH_TRIGGER_WORKER_IMMEDIATE_POLL_INTERVAL,
    shutdownTimeoutMs: env.BATCH_TRIGGER_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("BatchTriggerWorker", env.BATCH_TRIGGER_WORKER_LOG_LEVEL),
    jobs: {
      "v3.processBatchTaskRun": async ({ payload }) => {
        const service = new BatchTriggerV3Service(payload.strategy);
        await service.processBatchTaskRun(payload);
      },
      "runengine.processBatchTaskRun": async ({ payload }) => {
        const service = new RunEngineBatchTriggerService(payload.strategy);
        await service.processBatchTaskRun(payload);
      },
    },
  });

  if (env.BATCH_TRIGGER_WORKER_ENABLED === "true") {
    logger.debug(
      `👨‍🏭 Starting batch trigger worker at host ${env.BATCH_TRIGGER_WORKER_REDIS_HOST}, pollInterval = ${env.BATCH_TRIGGER_WORKER_POLL_INTERVAL}, immediatePollInterval = ${env.BATCH_TRIGGER_WORKER_IMMEDIATE_POLL_INTERVAL}, workers = ${env.BATCH_TRIGGER_WORKER_CONCURRENCY_WORKERS}, tasksPerWorker = ${env.BATCH_TRIGGER_WORKER_CONCURRENCY_TASKS_PER_WORKER}, concurrencyLimit = ${env.BATCH_TRIGGER_WORKER_CONCURRENCY_LIMIT}`
    );

    worker.start();
  }

  return worker;
}

export const batchTriggerWorker = singleton("batchTriggerWorker", initializeWorker);
