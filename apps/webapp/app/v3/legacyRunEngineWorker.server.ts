import { Worker as RedisWorker } from "@internal/redis-worker";
import { Logger } from "@trigger.dev/core/logger";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { TaskRunHeartbeatFailedService } from "./taskRunHeartbeatFailed.server";
import { tracer } from "./tracer.server";

const workerCatalog = {
  runHeartbeat: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 10000,
  },
};

function initializeWorker() {
  if (env.WORKER_ENABLED !== "true") {
    logger.debug("RedisWorker not initialized because WORKER_ENABLED is not set to true");
    return;
  }

  if (!env.LEGACY_RUN_ENGINE_WORKER_REDIS_HOST || !env.LEGACY_RUN_ENGINE_WORKER_REDIS_PORT) {
    logger.debug(
      "RedisWorker not initialized because LEGACY_RUN_ENGINE_WORKER_REDIS_HOST or LEGACY_RUN_ENGINE_WORKER_REDIS_PORT is not set"
    );
    return;
  }

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
    catalog: workerCatalog,
    concurrency: {
      workers: env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_WORKERS,
      tasksPerWorker: env.LEGACY_RUN_ENGINE_WORKER_CONCURRENCY_TASKS_PER_WORKER,
    },
    pollIntervalMs: env.LEGACY_RUN_ENGINE_WORKER_POLL_INTERVAL,
    logger: new Logger("LegacyRunEngineWorker", "debug"),
    jobs: {
      runHeartbeat: async ({ payload }) => {
        const service = new TaskRunHeartbeatFailedService();

        await service.call(payload.runId);
      },
    },
  });

  return worker;
}

export const legacyRunEngineWorker = singleton("legacyRunEngineWorker", initializeWorker);
