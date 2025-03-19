import { Worker as RedisWorker } from "@trigger.dev/redis-worker";
import { Logger } from "@trigger.dev/core/logger";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { TaskRunHeartbeatFailedService } from "./taskRunHeartbeatFailed.server";
import { completeBatchTaskRunItemV3 } from "./services/batchTriggerV3.server";
import { prisma } from "~/db.server";
import { marqs } from "./marqs/index.server";

function initializeWorker() {
  const redisOptions = {
    keyPrefix: "legacy-run-engine:worker:",
    host: env.LEGACY_RUN_ENGINE_WORKER_REDIS_HOST,
    port: env.LEGACY_RUN_ENGINE_WORKER_REDIS_PORT,
    username: env.LEGACY_RUN_ENGINE_WORKER_REDIS_USERNAME,
    password: env.LEGACY_RUN_ENGINE_WORKER_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.LEGACY_RUN_ENGINE_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };

  logger.debug(
    `👨‍🏭 Initializing legacy run engine worker at host ${env.LEGACY_RUN_ENGINE_WORKER_REDIS_HOST}`
  );

  const worker = new RedisWorker({
    name: "legacy-run-engine-worker",
    redisOptions,
    catalog: {
      runHeartbeat: {
        schema: z.object({
          runId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 3,
        },
      },
      completeBatchTaskRunItem: {
        schema: z.object({
          itemId: z.string(),
          batchTaskRunId: z.string(),
          scheduleResumeOnComplete: z.boolean(),
          taskRunAttemptId: z.string().optional(),
          attempt: z.number().optional(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 10,
        },
      },
      scheduleRequeueMessage: {
        schema: z.object({
          messageId: z.string(),
        }),
        visibilityTimeoutMs: 60_000,
        retry: {
          maxAttempts: 5,
        },
      },
    },
    concurrency: {
      workers: env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.LEGACY_RUN_ENGINE_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.LEGACY_RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL,
    shutdownTimeoutMs: env.LEGACY_RUN_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS,
    logger: new Logger("LegacyRunEngineWorker", "debug"),
    jobs: {
      runHeartbeat: async ({ payload }) => {
        const service = new TaskRunHeartbeatFailedService();

        await service.call(payload.runId);
      },
      completeBatchTaskRunItem: async ({ payload, attempt }) => {
        await completeBatchTaskRunItemV3(
          payload.itemId,
          payload.batchTaskRunId,
          prisma,
          payload.scheduleResumeOnComplete,
          payload.taskRunAttemptId,
          attempt
        );
      },
      scheduleRequeueMessage: async ({ payload }) => {
        await marqs.requeueMessageById(payload.messageId);
      },
    },
  });

  if (env.LEGACY_RUN_ENGINE_WORKER_ENABLED === "true") {
    logger.debug(
      `👨‍🏭 Starting legacy run engine worker at host ${env.LEGACY_RUN_ENGINE_WORKER_REDIS_HOST}, pollInterval = ${env.LEGACY_RUN_ENGINE_WORKER_POLL_INTERVAL}, immediatePollInterval = ${env.LEGACY_RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL}, workers = ${env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_WORKERS}, tasksPerWorker = ${env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_TASKS_PER_WORKER}, concurrencyLimit = ${env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_LIMIT}`
    );

    worker.start();
  }

  return worker;
}

export const legacyRunEngineWorker = singleton("legacyRunEngineWorker", initializeWorker);
