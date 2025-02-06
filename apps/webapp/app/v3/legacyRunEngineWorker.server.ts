import { Worker as RedisWorker } from "@internal/redis-worker";
import { Logger } from "@trigger.dev/core/logger";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { TaskRunHeartbeatFailedService } from "./taskRunHeartbeatFailed.server";

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
    },
    concurrency: {
      workers: env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_TASKS_PER_WORKER,
      limit: env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_LIMIT,
    },
    pollIntervalMs: env.LEGACY_RUN_ENGINE_WORKER_POLL_INTERVAL,
    immediatePollIntervalMs: env.LEGACY_RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL,
    logger: new Logger("LegacyRunEngineWorker", "debug"),
    jobs: {
      runHeartbeat: async ({ payload }) => {
        const service = new TaskRunHeartbeatFailedService();

        await service.call(payload.runId);
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
